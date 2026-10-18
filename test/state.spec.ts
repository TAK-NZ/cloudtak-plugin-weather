import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
    settings, session, defaultSettings, rainOn, loadSettings, bindStorage, flushSave, toggleLayer, setOpacity, setPalette,
    setCoverage, setRadarsPrecipType, setTileSize, setTimeZone, resetSettings, setFrame, setDraftFrame, setPlayForecast, setPlaying,
} from '../lib/state.ts';
import { STORAGE_KEY } from '../lib/constants.ts';
import type { StorageLike } from '../lib/types.ts';
import { setRain } from './helpers.ts';

function memory(initial?: string): StorageLike & { data: Map<string, string>; setItem: ReturnType<typeof vi.fn> } {
    const data = new Map<string, string>();
    if (initial !== undefined) data.set(STORAGE_KEY, initial);
    return {
        data,
        getItem: (k: string) => data.get(k) ?? null,
        setItem: vi.fn((k: string, v: string) => { data.set(k, v); }),
    };
}

beforeEach(() => {
    vi.useFakeTimers();
    bindStorage(memory());
    session.frame = 0;
    session.draftFrame = null;
    session.latest = {};
});

afterEach(() => {
    vi.useRealTimers();
});

describe('defaults', () => {
    it('are all layers off, 512 tiles and New Zealand time', () => {
        expect(defaultSettings()).toEqual({
            version: 3,
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
            playForecast: false,
        });
        expect(settings).toEqual(defaultSettings());
    });
});

describe('loadSettings', () => {
    const stored = (o: unknown): StorageLike => memory(JSON.stringify(o));

    it('returns defaults when getItem returns undefined (test stub)', () => {
        expect(loadSettings({ getItem: () => undefined, setItem: () => undefined })).toEqual(defaultSettings());
    });

    it('returns defaults for null storage, null item, a throwing getItem', () => {
        expect(loadSettings(null)).toEqual(defaultSettings());
        expect(loadSettings(memory())).toEqual(defaultSettings());
        expect(loadSettings({ getItem: () => { throw new Error('denied'); }, setItem: () => undefined })).toEqual(defaultSettings());
    });

    it('returns defaults for corrupt JSON and non-object JSON', () => {
        expect(loadSettings(memory('{nope'))).toEqual(defaultSettings());
        expect(loadSettings(memory('[1,2]'))).toEqual(defaultSettings());
        expect(loadSettings(memory('42'))).toEqual(defaultSettings());
        expect(loadSettings(memory('null'))).toEqual(defaultSettings());
    });

    it('returns defaults for an unknown version', () => {
        expect(loadSettings(stored({ ...defaultSettings(), version: 4, clouds: true }))).toEqual(defaultSettings());
        expect(loadSettings(stored({ ...defaultSettings(), version: '3', clouds: true }))).toEqual(defaultSettings());
        expect(loadSettings(stored({ ...defaultSettings(), version: '2', clouds: true }))).toEqual(defaultSettings());
        expect(loadSettings(stored({ ...defaultSettings(), version: null, clouds: true }))).toEqual(defaultSettings());
        expect(loadSettings(stored({ ...defaultSettings(), version: NaN, clouds: true }))).toEqual(defaultSettings());
    });

    it('treats an object with no version as old and migrates it', () => {
        const out = loadSettings(stored({ clouds: true, palette: { precip: '0', radars: '0' } }));
        expect(out).toEqual({ ...defaultSettings(), clouds: true });
        expect(out.version).toBe(3);
    });

    it('gives palette 4 for Rain and Radar on fresh storage', () => {
        expect(loadSettings(memory()).palette).toEqual({ precip: '4', radars: '4' });
    });

    it('keeps valid stored values', () => {
        const s = { ...defaultSettings(), precipGlobal: true, precipRegional: true, clouds: true, radars: true, coverage: true, radarsPrecipType: true, tileSize: 256, timeZone: 'UTC',
            opacity: { clouds: 0.3, 'precip-global': 0.6, precip: 0.9, radars: 0.25 }, palette: { precip: 'dbz_u8', radars: '4' } };
        expect(loadSettings(stored(s))).toEqual(s);
    });

    it('sanitises wrong types field by field', () => {
        const out = loadSettings(stored({
            version: 1, precip: 'both', clouds: 'yes', radars: 1, coverage: null, radarsPrecipType: [],
            tileSize: 300, timeZone: 'Mars/Base', opacity: 'high', palette: { precip: 11, radars: 'x' },
        }));
        expect(out).toEqual(defaultSettings());
        const v3 = loadSettings(stored({
            version: 3, precipRegional: 'yes', precipGlobal: 1, clouds: 'yes', radars: 1, coverage: null, radarsPrecipType: [],
            tileSize: 300, timeZone: 'Mars/Base', opacity: 'high', palette: { precip: 11, radars: 'x' },
        }));
        expect(v3).toEqual(defaultSettings());
    });

    it('clamps out-of-range opacity and ignores non-numbers', () => {
        const out = loadSettings(stored({ version: 1, opacity: { clouds: 5, precip: -3, radars: 'a' } }));
        expect(out.opacity).toEqual({ clouds: 1, 'precip-global': 0.1, precip: 0.1, radars: 0.7 });
        expect(loadSettings(stored({ version: 1, opacity: { clouds: null, precip: NaN } })).opacity).toEqual(defaultSettings().opacity);
    });

    it('treats a string-typed tile size or palette number as invalid', () => {
        const out = loadSettings(stored({ version: 1, tileSize: '256', palette: { precip: 3 } }));
        expect(out.tileSize).toBe(512);
        expect(out.palette.precip).toBe('4');
    });

    it('keeps valid fields next to invalid ones', () => {
        const out = loadSettings(stored({ version: 1, clouds: true, precip: 'nonsense' }));
        expect(out.clouds).toBe(true);
        expect([out.precipRegional, out.precipGlobal]).toEqual([false, false]);
    });
});

/** An object as versions 1 and 2 stored it: Rain was one mode. */
function legacy(version: number | undefined, over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        ...(version === undefined ? {} : { version }),
        precip: 'none',
        clouds: false,
        radars: false,
        opacity: { clouds: 0.5, precip: 0.7, radars: 0.7 },
        palette: { precip: '0', radars: '0' },
        coverage: false,
        radarsPrecipType: false,
        tileSize: 512,
        timeZone: 'Pacific/Auckland',
        ...over,
    };
}

describe('settings migration', () => {
    const v1 = (o: Record<string, unknown>) => memory(JSON.stringify(legacy(1, o)));
    const v2 = (o: Record<string, unknown>) => memory(JSON.stringify(legacy(2, o)));

    it.each([
        ['none', false, false],
        ['precip', true, false],
        ['precip-global', false, true],
        ['garbage', false, false],
    ])('turns the version 2 Rain mode %s into Regional=%s, Global=%s', (mode, regional, global) => {
        const out = loadSettings(v2({ precip: mode, clouds: true }));
        expect(out.version).toBe(3);
        expect(out.precipRegional).toBe(regional);
        expect(out.precipGlobal).toBe(global);
        expect(out.clouds).toBe(true);
        expect(out).not.toHaveProperty('precip');
    });

    it('turns the version 1 and unversioned Rain mode into the two switches as well', () => {
        expect(loadSettings(v1({ precip: 'precip-global' }))).toMatchObject({ precipRegional: false, precipGlobal: true });
        const unversioned = memory(JSON.stringify(legacy(undefined, { precip: 'precip' })));
        expect(loadSettings(unversioned)).toMatchObject({ version: 3, precipRegional: true, precipGlobal: false });
    });

    it('gives Global Rain the stored Rain opacity and keeps the shared Rain palette', () => {
        const out = loadSettings(v2({ precip: 'precip-global', opacity: { clouds: 0.4, precip: 0.35, radars: 0.9 }, palette: { precip: '3', radars: '0' } }));
        expect(out.opacity).toEqual({ clouds: 0.4, 'precip-global': 0.35, precip: 0.35, radars: 0.9 });
        expect(out.palette).toEqual({ precip: '3', radars: '0' });
    });

    it('writes a version 2 object once, immediately, as version 3', () => {
        const store = v2({ precip: 'precip', clouds: true, tileSize: 256 });
        bindStorage(store);
        expect(store.setItem).toHaveBeenCalledTimes(1);
        const written = JSON.parse((store.setItem.mock.calls[0] as [string, string])[1]) as Record<string, unknown>;
        expect(written).toMatchObject({ version: 3, precipRegional: true, precipGlobal: false, clouds: true, tileSize: 256 });
        expect(written).not.toHaveProperty('precip');
        expect(settings.precipRegional).toBe(true);
        bindStorage(store);
        expect(store.setItem).toHaveBeenCalledTimes(1);
    });

    it('upgrades version 1 and 2 objects to playForecast false, in the one write', () => {
        for (const store of [v1({ clouds: true }), v2({ clouds: true })]) {
            bindStorage(store);
            expect(store.setItem).toHaveBeenCalledTimes(1);
            const written = JSON.parse((store.setItem.mock.calls[0] as [string, string])[1]) as Record<string, unknown>;
            expect(written).toMatchObject({ version: 3, clouds: true, playForecast: false });
            expect(settings.playForecast).toBe(false);
        }
    });
    it('a version 3 object without playForecast loads with false and is not rewritten', () => {
        const { playForecast, ...stored } = defaultSettings();
        void playForecast;
        const store = memory(JSON.stringify({ ...stored, clouds: true }));
        bindStorage(store);
        expect(settings).toEqual({ ...defaultSettings(), clouds: true });
        expect(store.setItem).not.toHaveBeenCalled();
    });
    it('round-trips playForecast and ignores a stored value that is not a boolean', () => {
        expect(loadSettings(memory(JSON.stringify({ ...defaultSettings(), playForecast: true }))).playForecast).toBe(true);
        for (const junk of ['yes', 1, null, {}]) {
            expect(loadSettings(memory(JSON.stringify({ ...defaultSettings(), playForecast: junk }))).playForecast).toBe(false);
        }
    });
    it('a version 2 object with extra junk keys still loads', () => {
        const out = loadSettings(v2({ precip: 'precip', surprise: { a: 1 }, playForecast: 'maybe' }));
        expect(out).toMatchObject({ version: 3, precipRegional: true, playForecast: false });
        expect(out).not.toHaveProperty('surprise');
    });
    it('reads a version 3 object as it is and does not rewrite it', () => {
        const stored = { ...defaultSettings(), precipRegional: true, precipGlobal: true };
        const store = memory(JSON.stringify(stored));
        bindStorage(store);
        expect(settings).toEqual(stored);
        expect(store.setItem).not.toHaveBeenCalled();
    });

    it('moves palette 0 to 4 and keeps every other field', () => {
        const store = v1({
            palette: { precip: '0', radars: '0' }, clouds: true, opacity: { clouds: 0.5, precip: 0.3, radars: 0.7 }, tileSize: 256,
        });
        expect(loadSettings(store)).toEqual({
            ...defaultSettings(),
            clouds: true,
            opacity: { clouds: 0.5, 'precip-global': 0.3, precip: 0.3, radars: 0.7 },
            palette: { precip: '4', radars: '4' },
            tileSize: 256,
            version: 3,
        });
    });

    it('migrates each slot on its own', () => {
        expect(loadSettings(v1({ palette: { precip: '0', radars: '2' } })).palette).toEqual({ precip: '4', radars: '2' });
        expect(loadSettings(v1({ palette: { precip: '3', radars: '0' } })).palette).toEqual({ precip: '3', radars: '4' });
    });

    it('leaves non-zero chosen palettes untouched', () => {
        expect(loadSettings(v1({ palette: { precip: '3', radars: 'dbz_u8' } })).palette).toEqual({ precip: '3', radars: 'dbz_u8' });
    });

    it('keeps palette 0 in a version 2 object and in a version 3 object', () => {
        expect(loadSettings(v2({})).palette).toEqual({ precip: '0', radars: '0' });
        const store = memory(JSON.stringify({ ...defaultSettings(), palette: { precip: '0', radars: '0' } }));
        expect(loadSettings(store).palette).toEqual({ precip: '0', radars: '0' });
        bindStorage(store);
        expect(settings.palette).toEqual({ precip: '0', radars: '0' });
        expect(store.setItem).not.toHaveBeenCalled();
    });

    it('writes the migrated object once, immediately, and does not write again on reload', () => {
        const store = v1({ palette: { precip: '0', radars: '0' }, clouds: true });
        bindStorage(store);
        expect(store.setItem).toHaveBeenCalledTimes(1);
        const [key, value] = store.setItem.mock.calls[0] as [string, string];
        expect(key).toBe(STORAGE_KEY);
        expect(JSON.parse(value)).toEqual({ ...defaultSettings(), clouds: true });
        expect(settings.palette).toEqual({ precip: '4', radars: '4' });

        bindStorage(store);
        expect(store.setItem).toHaveBeenCalledTimes(1);
        vi.advanceTimersByTime(1000);
        expect(store.setItem).toHaveBeenCalledTimes(1);
    });

    it('still returns the migrated settings when setItem throws', () => {
        const store = v1({ palette: { precip: '0', radars: '0' } });
        store.setItem.mockImplementation(() => { throw new Error('quota'); });
        expect(() => bindStorage(store)).not.toThrow();
        expect(settings.palette).toEqual({ precip: '4', radars: '4' });
        expect(settings.version).toBe(3);
    });
});

describe('setters', () => {
    it('Rain Regional and Rain Global are independent switches', () => {
        toggleLayer('precipRegional');
        expect([settings.precipRegional, settings.precipGlobal]).toEqual([true, false]);
        toggleLayer('precipGlobal');
        expect([settings.precipRegional, settings.precipGlobal]).toEqual([true, true]);
        toggleLayer('precipRegional', false);
        expect([settings.precipRegional, settings.precipGlobal]).toEqual([false, true]);
        toggleLayer('precipGlobal');
        expect([settings.precipRegional, settings.precipGlobal]).toEqual([false, false]);
    });

    it('rainOn is true when either Rain layer is on', () => {
        expect(rainOn(settings)).toBe(false);
        toggleLayer('precipGlobal', true);
        expect(rainOn(settings)).toBe(true);
        toggleLayer('precipRegional', true);
        toggleLayer('precipGlobal', false);
        expect(rainOn(settings)).toBe(true);
    });

    it('ignores invalid values', () => {
        setPalette('precip', 'zz' as '0');
        setTileSize(300 as 256);
        setTimeZone('Mars' as 'UTC');
        setOpacity('clouds', NaN);
        expect(settings).toEqual(defaultSettings());
    });

    it('toggles and sets layers', () => {
        toggleLayer('clouds');
        expect(settings.clouds).toBe(true);
        toggleLayer('clouds');
        expect(settings.clouds).toBe(false);
        toggleLayer('radars', true);
        toggleLayer('radars', true);
        expect(settings.radars).toBe(true);
    });

    it('clamps opacity and stores palettes, coverage, precip type, tile size, zone', () => {
        setOpacity('precip', 7);
        expect(settings.opacity.precip).toBe(1);
        setOpacity('precip', 0);
        expect(settings.opacity.precip).toBe(0.1);
        setOpacity('precip-global', 0.4);
        expect(settings.opacity['precip-global']).toBe(0.4);
        expect(settings.opacity.precip).toBe(0.1);
        setPalette('radars', '9');
        setCoverage(true);
        setRadarsPrecipType(true);
        setTileSize(256);
        setTimeZone('local');
        expect(settings.palette.radars).toBe('9');
        expect(settings.coverage).toBe(true);
        expect(settings.radarsPrecipType).toBe(true);
        expect(settings.tileSize).toBe(256);
        expect(settings.timeZone).toBe('local');
    });

    it('setPlayForecast stores a boolean, saves it and ignores anything else', () => {
        const store = memory();
        bindStorage(store);
        setPlayForecast(true);
        expect(settings.playForecast).toBe(true);
        setPlayForecast('yes' as never);
        setPlayForecast(undefined as never);
        expect(settings.playForecast).toBe(true);
        vi.advanceTimersByTime(1000);
        expect(JSON.parse(store.data.get(STORAGE_KEY) as string).playForecast).toBe(true);
    });
    it('resetSettings restores playForecast false', () => {
        setPlayForecast(true);
        resetSettings();
        expect(settings.playForecast).toBe(false);
    });
    it('resetSettings restores defaults', () => {
        setRain('precip');
        toggleLayer('clouds', true);
        setOpacity('clouds', 0.9);
        resetSettings();
        expect(settings).toEqual(defaultSettings());
        expect(settings.palette).toEqual({ precip: '4', radars: '4' });
    });
});

describe('frame', () => {
    it('setFrame clamps to -12..24 with Rain on and clears the draft', () => {
        setRain('precip');
        setDraftFrame(7);
        expect(session.draftFrame).toBe(7);
        setFrame(12);
        expect(session.frame).toBe(12);
        expect(session.draftFrame).toBeNull();
        setFrame(99);
        expect(session.frame).toBe(24);
        setFrame(-99);
        expect(session.frame).toBe(-12);
        setFrame(-13);
        expect(session.frame).toBe(-12);
        setFrame(NaN);
        expect(session.frame).toBe(0);
    });
    it('without Rain the frame stops at Now but the past stays selectable', () => {
        setFrame(6);
        expect(session.frame).toBe(0);
        setFrame(-6);
        expect(session.frame).toBe(-6);
        setDraftFrame(9);
        expect(session.draftFrame).toBe(0);
    });
    it('setDraftFrame clamps and accepts null', () => {
        setRain('precip');
        setDraftFrame(-40);
        expect(session.draftFrame).toBe(-12);
        setDraftFrame(40);
        expect(session.draftFrame).toBe(24);
        setDraftFrame(null);
        expect(session.draftFrame).toBeNull();
    });
    it('turning Rain off ends a forecast frame at Now and keeps a past frame', () => {
        setRain('precip');
        setFrame(6);
        setRain('none');
        expect(session.frame).toBe(0);
        setRain('precip');
        setFrame(-4);
        setRain('none');
        expect(session.frame).toBe(-4);
    });
    it('either Rain layer allows the forecast, and the last Rain layer ending it returns to Now', () => {
        setRain('precip-global');
        setFrame(24);
        expect(session.frame).toBe(24);
        toggleLayer('precipRegional', true);
        toggleLayer('precipGlobal', false);
        expect(session.frame).toBe(24);
        setRain('both');
        toggleLayer('precipRegional', false);
        expect(session.frame).toBe(24);
        toggleLayer('precipGlobal', false);
        expect(session.frame).toBe(0);
        setFrame(24);
        expect(session.frame).toBe(0);
    });
    it('the session starts without per-layer latest', () => {
        expect(session.latest).toEqual({});
    });
    it('is never written to storage', () => {
        const store = memory();
        bindStorage(store);
        setRain('precip');
        setFrame(18);
        setDraftFrame(20);
        session.latest = { precip: 600 };
        vi.advanceTimersByTime(1000);
        const written = store.setItem.mock.calls.map((c) => String(c[1])).join('');
        expect(written).not.toContain('frame');
        expect(written).not.toContain('draft');
        expect(written).not.toContain('snapshot');
        expect(JSON.parse(store.data.get(STORAGE_KEY) as string)).toEqual({ ...defaultSettings(), precipRegional: true });
    });

    it('the play state starts idle, setPlaying keeps the resume time only while playing and drops the preload on stop', () => {
        expect(session).toMatchObject({ playing: false, preload: null, resumeAt: null });
        setPlaying(true, 5000);
        session.preload = -7;
        expect(session).toMatchObject({ playing: true, preload: -7, resumeAt: 5000 });
        setPlaying(true);
        expect(session).toMatchObject({ playing: true, preload: -7, resumeAt: null });
        setPlaying(false, 9);
        expect(session).toMatchObject({ playing: false, preload: null, resumeAt: null });
    });
    it('the play state is never written to storage', () => {
        const store = memory();
        bindStorage(store);
        setPlaying(true, 1);
        session.preload = 3;
        setCoverage(true);
        vi.advanceTimersByTime(1000);
        const written = store.setItem.mock.calls.map((c) => String(c[1])).join('');
        for (const word of ['playing', 'preload', 'resumeAt']) expect(written).not.toContain(word);
    });
    it('setFrame alone writes nothing', () => {
        const store = memory();
        bindStorage(store);
        setFrame(-5);
        vi.advanceTimersByTime(1000);
        expect(store.setItem).not.toHaveBeenCalled();
    });
});

describe('persistence', () => {
    it('writes once, 300 ms after the last change', () => {
        const store = memory();
        bindStorage(store);
        setRain('precip');
        vi.advanceTimersByTime(200);
        toggleLayer('clouds', true);
        vi.advanceTimersByTime(299);
        expect(store.setItem).not.toHaveBeenCalled();
        vi.advanceTimersByTime(1);
        expect(store.setItem).toHaveBeenCalledTimes(1);
        const [key, value] = store.setItem.mock.calls[0] as [string, string];
        expect(key).toBe(STORAGE_KEY);
        expect(JSON.parse(value)).toMatchObject({ version: 3, precipRegional: true, precipGlobal: false, clouds: true });
    });

    it('flushSave writes immediately', () => {
        const store = memory();
        bindStorage(store);
        setCoverage(true);
        flushSave();
        expect(store.setItem).toHaveBeenCalledTimes(1);
    });

    it('survives a throwing setItem and a missing storage', () => {
        const store = memory();
        store.setItem.mockImplementation(() => { throw new Error('quota'); });
        bindStorage(store);
        setRain('precip');
        expect(() => vi.advanceTimersByTime(1000)).not.toThrow();

        bindStorage(null);
        setRain('none');
        expect(() => vi.advanceTimersByTime(1000)).not.toThrow();
    });

    it('bindStorage loads what a previous session saved', () => {
        const store = memory();
        bindStorage(store);
        setRain('precip-global');
        toggleLayer('radars', true);
        flushSave();

        resetSettings();
        flushSave();
        bindStorage(memory(JSON.stringify({ ...defaultSettings(), precipGlobal: true, radars: true })));
        expect([settings.precipRegional, settings.precipGlobal]).toEqual([false, true]);
        expect(settings.radars).toBe(true);
    });
});
