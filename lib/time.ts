import type { TimeZoneSetting, WeatherLayer } from './types.ts';
import { WEATHER_LAYERS } from './constants.ts';

export const STEP_MIN = 10;
export const MAX_FORECAST_MIN = 240;
export const SNAPSHOT_STEP_S = 600;
/** The relay serves snapshots from the last two hours. */
export const WINDOW_S = 7200;
/** Frame 0 is "Now"; negative frames are the past, positive frames the Rain forecast. */
export const FRAME_MIN = -12;
export const FRAME_MAX = 24;
export const FRAME_COUNT = FRAME_MAX - FRAME_MIN + 1;

export interface TimelineSpec {
    pastFrames: 12;
    futureFrames: 24;
}

export const TIMELINE: TimelineSpec = { pastFrames: 12, futureFrames: 24 };

/** Browser clock corrected by the server clock (set by applyServerTime). */
export const clock = {
    offsetMs: 0,
    now(): number {
        return Date.now() + this.offsetMs;
    },
};

export function applyServerTime(serverTimeS: number): void {
    clock.offsetMs = serverTimeS * 1000 - Date.now();
}

/** Identical to the relay's computed `latest` snapshot: floor(t / 600) * 600 - 600. */
export function snapshotAt(nowMs: number): number {
    return Math.floor(nowMs / 1000 / SNAPSHOT_STEP_S) * SNAPSHOT_STEP_S - SNAPSHOT_STEP_S;
}

/** The slider range: the forecast exists for Rain only. */
export function frameBounds(rainOn: boolean): { min: number; max: number } {
    return { min: FRAME_MIN, max: rainOn ? FRAME_MAX : 0 };
}

export function clampFrame(i: number, max: number = FRAME_MAX): number {
    if (typeof i !== 'number' || Number.isNaN(i)) return 0;
    return Math.min(Math.min(max, FRAME_MAX), Math.max(FRAME_MIN, Math.round(i) || 0));
}

/** Forecast minutes of a frame: 0 for Now and the past. */
export function frameToMinutes(frame: number): number {
    return Math.max(0, clampFrame(frame)) * STEP_MIN;
}

/** Valid time of a frame on the axis anchored at `anchor`. */
export function frameTimeS(anchor: number, frame: number): number {
    return anchor + frame * SNAPSHOT_STEP_S;
}

function isSnapshot(v: unknown): v is number {
    return typeof v === 'number' && Number.isInteger(v) && v > 0 && v % SNAPSHOT_STEP_S === 0;
}

/** The per-layer latest snapshots that are plausible at `nowMs`; everything else is dropped. */
export function validLatest(latest: Partial<Record<WeatherLayer, number>> | undefined, nowMs: number): Partial<Record<WeatherLayer, number>> {
    const computed = snapshotAt(nowMs);
    const out: Partial<Record<WeatherLayer, number>> = {};
    if (!latest) return out;
    for (const layer of WEATHER_LAYERS) {
        const v = latest[layer];
        if (isSnapshot(v) && v >= computed - WINDOW_S && v <= computed + SNAPSHOT_STEP_S) out[layer] = v;
    }
    return out;
}

/**
 * The anchor A of the timeline: the newest per-layer latest snapshot, else the status
 * snapshot (relay without `latest`), else the computed one.
 */
export function anchorFrom(latest: Partial<Record<WeatherLayer, number>> | undefined, statusSnapshot: number | undefined, nowMs: number): number {
    const values = Object.values(validLatest(latest, nowMs));
    if (values.length > 0) return Math.max(...values);
    return isSnapshot(statusSnapshot) ? statusSnapshot : snapshotAt(nowMs);
}

/** Never ask for a snapshot older than the relay window (it answers 400). */
export function lowerGuard(snapshot: number, nowMs: number): number {
    return Math.max(snapshot, snapshotAt(nowMs) - WINDOW_S);
}

/** Rain: the past is exact, the forecast starts from the layer's own latest snapshot. */
export function rainFrame(
    frame: number,
    anchor: number,
    rainLatest: number | undefined,
    nowMs: number
): { snapshot: number; forecast: number } {
    if (frame <= 0) return { snapshot: lowerGuard(frameTimeS(anchor, frame), nowMs), forecast: 0 };
    return { snapshot: lowerGuard(rainLatest ?? anchor, nowMs), forecast: frame * STEP_MIN };
}

/** Clouds and radar: the past is exact, they hold their newest frame after Now. */
export function holdSnapshot(frame: number, anchor: number, nowMs: number): number {
    return lowerGuard(frameTimeS(anchor, Math.min(frame, 0)), nowMs);
}

type FormatterFactory = (options: Intl.DateTimeFormatOptions) => Intl.DateTimeFormat;

const defaultFactory: FormatterFactory = (options) => new Intl.DateTimeFormat('en-NZ', options);

function part(parts: Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes): string {
    return parts.find((p) => p.type === type)?.value ?? '';
}

function format(epochS: number, zone: string | undefined, make: FormatterFactory): { text: string; hm: string; zoneName: string } {
    const parts = make({
        ...(zone ? { timeZone: zone } : {}),
        weekday: 'short',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
        timeZoneName: 'short',
    }).formatToParts(new Date(epochS * 1000));
    const hm = `${part(parts, 'hour')}:${part(parts, 'minute')}`;
    return {
        text: `${part(parts, 'weekday')} ${hm}`,
        hm,
        zoneName: part(parts, 'timeZoneName'),
    };
}

/**
 * "Thu 14:20 NZST". Falls back to UTC when the zone is not supported.
 */
export function formatClock(epochS: number, tz: TimeZoneSetting, make: FormatterFactory = defaultFactory): string {
    try {
        if (tz === 'UTC') return `${format(epochS, 'UTC', make).text} UTC`;
        const f = format(epochS, tz === 'local' ? undefined : tz, make);
        let name = f.zoneName;
        if (tz === 'Pacific/Auckland') {
            if (name === 'GMT+13') name = 'NZDT';
            else if (name === 'GMT+12') name = 'NZST';
        }
        return name ? `${f.text} ${name}` : f.text;
    } catch (err) {
        if (!(err instanceof RangeError)) throw err;
        return `${format(epochS, 'UTC', make).text} UTC`;
    }
}

/** "14:20" in the selected zone (UTC when the zone is not supported). */
export function formatHm(epochS: number, tz: TimeZoneSetting, make: FormatterFactory = defaultFactory): string {
    try {
        return format(epochS, tz === 'UTC' ? 'UTC' : tz === 'local' ? undefined : tz, make).hm;
    } catch (err) {
        if (!(err instanceof RangeError)) throw err;
        return format(epochS, 'UTC', make).hm;
    }
}

export interface FrameLabel {
    /** Compact text: "Now · 14:20", "-40 min · 13:40" or "+30 min · 14:50". */
    text: string;
    /** Full text with weekday and zone, for the tooltip. */
    title: string;
}

function offsetText(frame: number): string {
    if (frame === 0) return 'Now';
    return `${frame < 0 ? '-' : '+'}${Math.abs(frame) * STEP_MIN} min`;
}

export function frameLabel(opts: {
    frame: number;
    anchor: number;
    tz: TimeZoneSetting;
    make?: FormatterFactory;
}): FrameLabel {
    const frame = clampFrame(opts.frame);
    const t = frameTimeS(opts.anchor, frame);
    const offset = offsetText(frame);
    return {
        text: `${offset} · ${formatHm(t, opts.tz, opts.make)}`,
        title: `${offset} · ${formatClock(t, opts.tz, opts.make)}`,
    };
}

export interface Debounced<A extends unknown[]> {
    (...args: A): void;
    cancel(): void;
    flush(): void;
}

/** Trailing debounce. */
export function debounce<A extends unknown[]>(fn: (...args: A) => void, ms: number): Debounced<A> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let pending: A | undefined;

    const run = (): void => {
        const args = pending;
        timer = undefined;
        pending = undefined;
        if (args) fn(...args);
    };

    const debounced = ((...args: A): void => {
        pending = args;
        if (timer !== undefined) clearTimeout(timer);
        timer = setTimeout(run, ms);
    }) as Debounced<A>;

    debounced.cancel = () => {
        if (timer !== undefined) clearTimeout(timer);
        timer = undefined;
        pending = undefined;
    };

    debounced.flush = () => {
        if (timer === undefined) return;
        clearTimeout(timer);
        run();
    };

    return debounced;
}

/** Random delay (0..60 s) so clients do not all refresh on the same second. */
export function rolloverJitterMs(random: () => number = Math.random): number {
    return Math.floor(random() * 60000);
}
