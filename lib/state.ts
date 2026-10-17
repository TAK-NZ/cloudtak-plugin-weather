import { reactive } from 'vue';
import type {
    LayerSlot, PaletteCode, PrecipMode, RelayStatus, HealthState, StorageLike, TimeZoneSetting, WeatherSettings,
} from './types.ts';
import { PALETTES, STORAGE_KEY } from './constants.ts';
import { clampFrame, clock, debounce, snapshotAt } from './time.ts';

const PRECIP_MODES: readonly PrecipMode[] = ['none', 'precip', 'precip-global'];
const TIME_ZONES: readonly TimeZoneSetting[] = ['Pacific/Auckland', 'UTC', 'local'];
const OPACITY_MIN = 0.1;
const OPACITY_MAX = 1;
const SAVE_DELAY_MS = 300;

export function defaultSettings(): WeatherSettings {
    return {
        version: 1,
        precip: 'none',
        clouds: false,
        radars: false,
        opacity: { clouds: 0.5, precip: 0.7, radars: 0.7 },
        palette: { precip: '0', radars: '0' },
        coverage: false,
        radarsPrecipType: false,
        tileSize: 512,
        timeZone: 'Pacific/Auckland',
    };
}

export function clampOpacity(v: number): number {
    return Math.min(OPACITY_MAX, Math.max(OPACITY_MIN, v));
}

function isRecord(v: unknown): v is Record<string, unknown> {
    return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function oneOf<T extends string | number>(v: unknown, allowed: readonly T[], fallback: T): T {
    return allowed.includes(v as T) ? (v as T) : fallback;
}

function bool(v: unknown, fallback: boolean): boolean {
    return typeof v === 'boolean' ? v : fallback;
}

function opacity(v: unknown, fallback: number): number {
    return typeof v === 'number' && Number.isFinite(v) ? clampOpacity(v) : fallback;
}

/**
 * Read and sanitise stored settings. Any non-string result of getItem (null, or
 * undefined as the test stub returns) counts as absent; anything unusable gives defaults.
 */
export function loadSettings(storage: StorageLike | null | undefined): WeatherSettings {
    const d = defaultSettings();

    let raw: unknown;
    try {
        raw = storage ? storage.getItem(STORAGE_KEY) : undefined;
    } catch {
        return d;
    }
    if (typeof raw !== 'string') return d;

    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return d;
    }
    if (!isRecord(parsed) || parsed.version !== 1) return d;

    const op = isRecord(parsed.opacity) ? parsed.opacity : {};
    const pal = isRecord(parsed.palette) ? parsed.palette : {};

    return {
        version: 1,
        precip: oneOf(parsed.precip, PRECIP_MODES, d.precip),
        clouds: bool(parsed.clouds, d.clouds),
        radars: bool(parsed.radars, d.radars),
        opacity: {
            clouds: opacity(op.clouds, d.opacity.clouds),
            precip: opacity(op.precip, d.opacity.precip),
            radars: opacity(op.radars, d.opacity.radars),
        },
        palette: {
            precip: oneOf(pal.precip, PALETTES, d.palette.precip),
            radars: oneOf(pal.radars, PALETTES, d.palette.radars),
        },
        coverage: bool(parsed.coverage, d.coverage),
        radarsPrecipType: bool(parsed.radarsPrecipType, d.radarsPrecipType),
        tileSize: oneOf(parsed.tileSize, [256, 512] as const, d.tileSize),
        timeZone: oneOf(parsed.timeZone, TIME_ZONES, d.timeZone),
    };
}

function browserStorage(): StorageLike | null {
    try {
        return typeof localStorage === 'undefined' ? null : localStorage;
    } catch {
        return null;
    }
}

let storage: StorageLike | null = browserStorage();

/** Persisted user settings (module singleton, survives pane unmount/remount). */
export const settings = reactive<WeatherSettings>(loadSettings(storage));

export interface Session {
    panelOpen: boolean;
    /** Committed forecast frame, 0..24. Never persisted. */
    frame: number;
    /** Frame under the slider thumb while dragging. */
    draftFrame: number | null;
    snapshot: number;
    status: RelayStatus | null;
    health: HealthState;
}

/** Per-page-load state. Never persisted. */
export const session = reactive<Session>({
    panelOpen: false,
    frame: 0,
    draftFrame: null,
    snapshot: snapshotAt(clock.now()),
    status: null,
    health: { kind: 'ok' },
});

const save = debounce(() => {
    if (!storage) return;
    try {
        storage.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch {
        // Quota exceeded or private mode: keep working without persistence.
    }
}, SAVE_DELAY_MS);

/** Swap the storage backend (tests) and reload the settings from it. */
export function bindStorage(next: StorageLike | null): void {
    save.cancel();
    storage = next;
    Object.assign(settings, loadSettings(storage));
}

export function flushSave(): void {
    save.flush();
}

export function setPrecip(mode: PrecipMode): void {
    if (!PRECIP_MODES.includes(mode)) return;
    settings.precip = mode;
    save();
}

export function toggleLayer(layer: 'clouds' | 'radars', value?: boolean): void {
    settings[layer] = value ?? !settings[layer];
    save();
}

export function setOpacity(slot: LayerSlot, value: number): void {
    if (typeof value !== 'number' || !Number.isFinite(value)) return;
    settings.opacity[slot] = clampOpacity(value);
    save();
}

export function setPalette(slot: 'precip' | 'radars', code: PaletteCode): void {
    if (!PALETTES.includes(code)) return;
    settings.palette[slot] = code;
    save();
}

export function setCoverage(value: boolean): void {
    settings.coverage = value;
    save();
}

export function setRadarsPrecipType(value: boolean): void {
    settings.radarsPrecipType = value;
    save();
}

export function setTileSize(size: 256 | 512): void {
    if (size !== 256 && size !== 512) return;
    settings.tileSize = size;
    save();
}

export function setTimeZone(tz: TimeZoneSetting): void {
    if (!TIME_ZONES.includes(tz)) return;
    settings.timeZone = tz;
    save();
}

export function resetSettings(): void {
    Object.assign(settings, defaultSettings());
    save();
}

/** The only writer of session.frame. */
export function setFrame(i: number): void {
    session.frame = clampFrame(i);
    session.draftFrame = null;
}

export function setDraftFrame(i: number | null): void {
    session.draftFrame = i === null ? null : clampFrame(i);
}
