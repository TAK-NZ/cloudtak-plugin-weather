import { reactive } from 'vue';
import type {
    LayerSlot, PaletteCode, RelayStatus, HealthState, StorageLike, TimeZoneSetting, ToggleKey, WeatherLayer, WeatherSettings,
} from './types.ts';
import { PALETTES, SETTINGS_VERSION, STORAGE_KEY } from './constants.ts';
import { clampFrame, clock, debounce, frameBounds, snapshotAt } from './time.ts';

const TIME_ZONES: readonly TimeZoneSetting[] = ['Pacific/Auckland', 'UTC', 'local'];
const OPACITY_MIN = 0.1;
const OPACITY_MAX = 1;
const SAVE_DELAY_MS = 300;

export function defaultSettings(): WeatherSettings {
    return {
        version: SETTINGS_VERSION,
        clouds: false,
        precipRegional: false,
        precipGlobal: false,
        radars: false,
        opacity: { clouds: 0.5, 'precip-global': 0.7, precip: 0.7, radars: 0.7 },
        palette: { precip: '4', radars: '4' },
        coverage: false,
        radarsPrecipType: false,
        tileSize: 512,
        timeZone: 'Pacific/Auckland',
        playForecast: true,
    };
}

export function clampOpacity(v: number): number {
    return Math.min(OPACITY_MAX, Math.max(OPACITY_MIN, v));
}

/** Whether any Rain layer (Regional or Global) is on: only Rain has a forecast. */
export function rainOn(s: Pick<WeatherSettings, 'precipRegional' | 'precipGlobal'>): boolean {
    return s.precipRegional || s.precipGlobal;
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

interface Stored {
    settings: WeatherSettings;
    /** True when an older (unversioned, 1 or 2) object was upgraded and should be written back. */
    migrated: boolean;
}

/**
 * Read and sanitise stored settings. Any non-string result of getItem (null, or
 * undefined as the test stub returns) counts as absent; anything unusable gives defaults.
 * A missing, 1 or 2 version is an old object: it is sanitised and migrated to the current
 * version. Version 3 is current (a version 3 object without `playForecast` gets the default true).
 * Any other version gives defaults.
 * Versions up to 2 stored Rain as one mode ('none' | 'precip' | 'precip-global'); it becomes
 * the two Rain switches, and the Global Rain opacity starts as the Rain opacity.
 */
function readStored(from: StorageLike | null | undefined): Stored {
    const d = defaultSettings();
    const fallback: Stored = { settings: d, migrated: false };

    let raw: unknown;
    try {
        raw = from ? from.getItem(STORAGE_KEY) : undefined;
    } catch {
        return fallback;
    }
    if (typeof raw !== 'string') return fallback;

    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return fallback;
    }
    if (!isRecord(parsed)) return fallback;

    const oldPalette = parsed.version === undefined || parsed.version === 1;
    const old = oldPalette || parsed.version === 2;
    if (!old && parsed.version !== SETTINGS_VERSION) return fallback;

    const op = isRecord(parsed.opacity) ? parsed.opacity : {};
    const pal = isRecord(parsed.palette) ? parsed.palette : {};

    const precipOpacity = opacity(op.precip, d.opacity.precip);
    const out: WeatherSettings = {
        version: SETTINGS_VERSION,
        clouds: bool(parsed.clouds, d.clouds),
        precipRegional: old ? parsed.precip === 'precip' : bool(parsed.precipRegional, d.precipRegional),
        precipGlobal: old ? parsed.precip === 'precip-global' : bool(parsed.precipGlobal, d.precipGlobal),
        radars: bool(parsed.radars, d.radars),
        opacity: {
            clouds: opacity(op.clouds, d.opacity.clouds),
            'precip-global': old ? precipOpacity : opacity(op['precip-global'], d.opacity['precip-global']),
            precip: precipOpacity,
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
        playForecast: bool(parsed.playForecast, d.playForecast),
    };

    if (oldPalette) {
        // Version 1 defaulted both palettes to '0'. Move those to the new default '4'.
        // Accepted trade-off: a '0' the user chose on purpose under version 1 cannot be
        // told apart from the old default, so it is migrated too. Version 2 keeps '0'.
        if (pal.precip === '0') out.palette.precip = '4';
        if (pal.radars === '0') out.palette.radars = '4';
    }

    return { settings: out, migrated: old };
}

/** Read and sanitise stored settings, migrating older versions in memory. */
export function loadSettings(storage: StorageLike | null | undefined): WeatherSettings {
    return readStored(storage).settings;
}

function browserStorage(): StorageLike | null {
    try {
        return typeof localStorage === 'undefined' ? null : localStorage;
    } catch {
        return null;
    }
}

let storage: StorageLike | null = browserStorage();

/** Write migrated settings straight away (not debounced), so the migration runs once. */
function persistMigrated(to: StorageLike | null, value: WeatherSettings): void {
    if (!to) return;
    try {
        to.setItem(STORAGE_KEY, JSON.stringify(value));
    } catch {
        // Quota exceeded or private mode: the settings still load from memory.
    }
}

const initial = readStored(storage);
if (initial.migrated) persistMigrated(storage, initial.settings);

/** Persisted user settings (module singleton, survives pane unmount/remount). */
export const settings = reactive<WeatherSettings>(initial.settings);

export interface Session {
    panelOpen: boolean;
    /** Committed frame on the timeline: -12 (2 h ago) .. 0 (Now) .. 24 (+4 h, Rain only). Never persisted. */
    frame: number;
    /** Frame under the slider thumb while dragging. */
    draftFrame: number | null;
    /** The anchor of the timeline (frame 0): the newest per-layer latest snapshot. */
    snapshot: number;
    /** Newest snapshot per layer as reported by the relay (empty for a relay without `latest`). */
    latest: Partial<Record<WeatherLayer, number>>;
    status: RelayStatus | null;
    health: HealthState;
    /** Play is on (also while suspended by a rate limit). */
    playing: boolean;
    /** The frame the hidden buffer loads while playing (one ahead), else null. */
    preload: number | null;
    /** While playing is suspended: when it resumes by itself (epoch ms). */
    resumeAt: number | null;
}

/** Per-page-load state. Never persisted. */
export const session = reactive<Session>({
    panelOpen: false,
    frame: 0,
    draftFrame: null,
    snapshot: snapshotAt(clock.now()),
    latest: {},
    status: null,
    health: { kind: 'ok' },
    playing: false,
    preload: null,
    resumeAt: null,
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
    const loaded = readStored(storage);
    if (loaded.migrated) persistMigrated(storage, loaded.settings);
    Object.assign(settings, loaded.settings);
}

export function flushSave(): void {
    save.flush();
}

export function toggleLayer(layer: ToggleKey, value?: boolean): void {
    settings[layer] = value ?? !settings[layer];
    // Without Rain there is no forecast to show.
    if (!rainOn(settings)) setFrame(Math.min(session.frame, 0));
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

export function setPlayForecast(value: boolean): void {
    if (typeof value !== 'boolean') return;
    settings.playForecast = value;
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

/** Highest selectable frame: the forecast exists for Rain only. */
function frameMax(): number {
    return frameBounds(rainOn(settings)).max;
}

/** The only writer of session.frame. */
export function setFrame(i: number): void {
    session.frame = clampFrame(i, frameMax());
    session.draftFrame = null;
}

/** The player's view in the session. Anything but playing also drops the preload. */
export function setPlaying(playing: boolean, resumeAt: number | null = null): void {
    session.playing = playing;
    session.resumeAt = playing ? resumeAt : null;
    if (!playing) session.preload = null;
}

export function setDraftFrame(i: number | null): void {
    session.draftFrame = i === null ? null : clampFrame(i, frameMax());
}
