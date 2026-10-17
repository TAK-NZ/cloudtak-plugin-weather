import type { TimeZoneSetting } from './types.ts';

export const STEP_MIN = 10;
export const MAX_FORECAST_MIN = 240;
export const FRAME_COUNT = 25;
export const SNAPSHOT_STEP_S = 600;

/**
 * The proxy may serve data newer than the requested snapshot (it caches its own
 * latest timestamp for 5 minutes), so labels are approximate until it honours it.
 */
export const SNAPSHOT_EXACT = false;

export interface TimelineSpec {
    pastFrames: 0;
    futureFrames: 24;
}

export const TIMELINE: TimelineSpec = { pastFrames: 0, futureFrames: 24 };

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

/** Identical to the relay's `latest` snapshot: floor(t / 600) * 600 - 600. */
export function snapshotAt(nowMs: number): number {
    return Math.floor(nowMs / 1000 / SNAPSHOT_STEP_S) * SNAPSHOT_STEP_S - SNAPSHOT_STEP_S;
}

export function clampFrame(i: number): number {
    if (typeof i !== 'number' || Number.isNaN(i)) return 0;
    return Math.min(TIMELINE.futureFrames, Math.max(0, Math.round(i)));
}

export function frameToMinutes(frame: number): number {
    return clampFrame(frame) * STEP_MIN;
}

export function minutesToFrame(minutes: number): number {
    return clampFrame(minutes / STEP_MIN);
}

/** Signed so that past frames can be added later. Not clamped. */
export function validTimeS(snapshot: number, frame: number): number {
    return snapshot + frame * SNAPSHOT_STEP_S;
}

export function dataAgeMin(snapshot: number, nowMs: number): number {
    return Math.max(0, Math.round((nowMs / 1000 - snapshot) / 60));
}

type FormatterFactory = (options: Intl.DateTimeFormatOptions) => Intl.DateTimeFormat;

const defaultFactory: FormatterFactory = (options) => new Intl.DateTimeFormat('en-NZ', options);

function part(parts: Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes): string {
    return parts.find((p) => p.type === type)?.value ?? '';
}

function format(epochS: number, zone: string | undefined, make: FormatterFactory): { text: string; zoneName: string } {
    const parts = make({
        ...(zone ? { timeZone: zone } : {}),
        weekday: 'short',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
        timeZoneName: 'short',
    }).formatToParts(new Date(epochS * 1000));

    return {
        text: `${part(parts, 'weekday')} ${part(parts, 'hour')}:${part(parts, 'minute')}`,
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

export interface FrameLabel {
    /** Headline: "Now", a clock time, or "Current data". */
    primary: string;
    /** Clock time of the data for frame 0 ("" otherwise). */
    time: string;
    /** "+120 min", "data 12 min old" or "". */
    secondary: string;
    /** Set while labels are approximate. */
    tooltip?: string;
}

export const APPROXIMATE_TOOLTIP = 'Approximate, up to 10 min';

export function frameLabel(opts: {
    frame: number;
    snapshot: number;
    nowMs: number;
    tz: TimeZoneSetting;
    precip: boolean;
    make?: FormatterFactory;
}): FrameLabel {
    if (!opts.precip) return { primary: 'Current data', time: '', secondary: '' };

    const frame = clampFrame(opts.frame);
    const approx = SNAPSHOT_EXACT ? '' : '~';
    const tooltip = SNAPSHOT_EXACT ? undefined : APPROXIMATE_TOOLTIP;
    const clockText = approx + formatClock(validTimeS(opts.snapshot, frame), opts.tz, opts.make);

    if (frame === 0) {
        return {
            primary: 'Now',
            time: clockText,
            secondary: `data ${dataAgeMin(opts.snapshot, opts.nowMs)} min old`,
            tooltip,
        };
    }

    return { primary: clockText, time: '', secondary: `+${frameToMinutes(frame)} min`, tooltip };
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
