import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
    settings, session, defaultSettings, loadSettings, bindStorage, flushSave, setPrecip, toggleLayer, setOpacity, setPalette,
    setCoverage, setRadarsPrecipType, setTileSize, setTimeZone, resetSettings, setFrame, setDraftFrame,
} from '../lib/state.ts';
import { STORAGE_KEY } from '../lib/constants.ts';
import type { StorageLike } from '../lib/types.ts';

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
});

afterEach(() => {
    vi.useRealTimers();
});

describe('defaults', () => {
    it('are all layers off, 512 tiles and New Zealand time', () => {
        expect(defaultSettings()).toEqual({
            version: 2,
            precip: 'none',
            clouds: false,
            radars: false,
            opacity: { clouds: 0.5, precip: 0.7, radars: 0.7 },
            palette: { precip: '4', radars: '4' },
            coverage: false,
            radarsPrecipType: false,
            tileSize: 512,
            timeZone: 'Pacific/Auckland',
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
        expect(loadSettings(stored({ ...defaultSettings(), version: 3, clouds: true }))).toEqual(defaultSettings());
        expect(loadSettings(stored({ ...defaultSettings(), version: '2', clouds: true }))).toEqual(defaultSettings());
        expect(loadSettings(stored({ ...defaultSettings(), version: null, clouds: true }))).toEqual(defaultSettings());
        expect(loadSettings(stored({ ...defaultSettings(), version: NaN, clouds: true }))).toEqual(defaultSettings());
    });

    it('treats an object with no version as old and migrates it', () => {
        const out = loadSettings(stored({ clouds: true, palette: { precip: '0', radars: '0' } }));
        expect(out).toEqual({ ...defaultSettings(), clouds: true });
        expect(out.version).toBe(2);
    });

    it('gives palette 4 for Rain and Radar on fresh storage', () => {
        expect(loadSettings(memory()).palette).toEqual({ precip: '4', radars: '4' });
    });

    it('keeps valid stored values', () => {
        const s = { ...defaultSettings(), precip: 'precip-global', clouds: true, radars: true, coverage: true, radarsPrecipType: true, tileSize: 256, timeZone: 'UTC',
            opacity: { clouds: 0.3, precip: 0.9, radars: 0.25 }, palette: { precip: 'dbz_u8', radars: '4' } };
        expect(loadSettings(stored(s))).toEqual(s);
    });

    it('sanitises wrong types field by field', () => {
        const out = loadSettings(stored({
            version: 1, precip: 'both', clouds: 'yes', radars: 1, coverage: null, radarsPrecipType: [],
            tileSize: 300, timeZone: 'Mars/Base', opacity: 'high', palette: { precip: 11, radars: 'x' },
        }));
        expect(out).toEqual(defaultSettings());
    });

    it('clamps out-of-range opacity and ignores non-numbers', () => {
        const out = loadSettings(stored({ version: 1, opacity: { clouds: 5, precip: -3, radars: 'a' } }));
        expect(out.opacity).toEqual({ clouds: 1, precip: 0.1, radars: 0.7 });
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
        expect(out.precip).toBe('none');
    });
});

describe('settings migration', () => {
    const v1 = (o: Record<string, unknown>) => memory(JSON.stringify({ ...defaultSettings(), version: 1, ...o }));

    it('moves palette 0 to 4 and keeps every other field', () => {
        const store = v1({
            palette: { precip: '0', radars: '0' }, clouds: true, opacity: { clouds: 0.5, precip: 0.3, radars: 0.7 }, tileSize: 256,
        });
        expect(loadSettings(store)).toEqual({
            ...defaultSettings(),
            clouds: true,
            opacity: { clouds: 0.5, precip: 0.3, radars: 0.7 },
            palette: { precip: '4', radars: '4' },
            tileSize: 256,
            version: 2,
        });
    });

    it('migrates each slot on its own', () => {
        expect(loadSettings(v1({ palette: { precip: '0', radars: '2' } })).palette).toEqual({ precip: '4', radars: '2' });
        expect(loadSettings(v1({ palette: { precip: '3', radars: '0' } })).palette).toEqual({ precip: '3', radars: '4' });
    });

    it('leaves non-zero chosen palettes untouched', () => {
        expect(loadSettings(v1({ palette: { precip: '3', radars: 'dbz_u8' } })).palette).toEqual({ precip: '3', radars: 'dbz_u8' });
    });

    it('keeps palette 0 in a version 2 object', () => {
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
        expect(settings.version).toBe(2);
    });
});

describe('setters', () => {
    it('rain modes are mutually exclusive by construction', () => {
        setPrecip('precip');
        expect(settings.precip).toBe('precip');
        setPrecip('precip-global');
        expect(settings.precip).toBe('precip-global');
        setPrecip('none');
        expect(settings.precip).toBe('none');
    });

    it('ignores invalid values', () => {
        setPrecip('bogus' as 'none');
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

    it('resetSettings restores defaults', () => {
        setPrecip('precip');
        toggleLayer('clouds', true);
        setOpacity('clouds', 0.9);
        resetSettings();
        expect(settings).toEqual(defaultSettings());
        expect(settings.palette).toEqual({ precip: '4', radars: '4' });
    });
});

describe('frame', () => {
    it('setFrame clamps and clears the draft', () => {
        setDraftFrame(7);
        expect(session.draftFrame).toBe(7);
        setFrame(12);
        expect(session.frame).toBe(12);
        expect(session.draftFrame).toBeNull();
        setFrame(99);
        expect(session.frame).toBe(24);
        setFrame(NaN);
        expect(session.frame).toBe(0);
    });

    it('setDraftFrame clamps and accepts null', () => {
        setDraftFrame(-4);
        expect(session.draftFrame).toBe(0);
        setDraftFrame(null);
        expect(session.draftFrame).toBeNull();
    });

    it('is never written to storage', () => {
        const store = memory();
        bindStorage(store);
        setPrecip('precip');
        setFrame(18);
        setDraftFrame(20);
        vi.advanceTimersByTime(1000);
        const written = store.setItem.mock.calls.map((c) => String(c[1])).join('');
        expect(written).not.toContain('frame');
        expect(written).not.toContain('draft');
        expect(written).not.toContain('snapshot');
        expect(JSON.parse(store.data.get(STORAGE_KEY) as string)).toEqual({ ...defaultSettings(), precip: 'precip' });
    });

    it('setFrame alone writes nothing', () => {
        const store = memory();
        bindStorage(store);
        setFrame(5);
        vi.advanceTimersByTime(1000);
        expect(store.setItem).not.toHaveBeenCalled();
    });
});

describe('persistence', () => {
    it('writes once, 300 ms after the last change', () => {
        const store = memory();
        bindStorage(store);
        setPrecip('precip');
        vi.advanceTimersByTime(200);
        toggleLayer('clouds', true);
        vi.advanceTimersByTime(299);
        expect(store.setItem).not.toHaveBeenCalled();
        vi.advanceTimersByTime(1);
        expect(store.setItem).toHaveBeenCalledTimes(1);
        const [key, value] = store.setItem.mock.calls[0] as [string, string];
        expect(key).toBe(STORAGE_KEY);
        expect(JSON.parse(value)).toMatchObject({ version: 2, precip: 'precip', clouds: true });
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
        setPrecip('precip');
        expect(() => vi.advanceTimersByTime(1000)).not.toThrow();

        bindStorage(null);
        setPrecip('none');
        expect(() => vi.advanceTimersByTime(1000)).not.toThrow();
    });

    it('bindStorage loads what a previous session saved', () => {
        const store = memory();
        bindStorage(store);
        setPrecip('precip-global');
        toggleLayer('radars', true);
        flushSave();

        resetSettings();
        flushSave();
        bindStorage(memory(JSON.stringify({ ...defaultSettings(), precip: 'precip-global', radars: true })));
        expect(settings.precip).toBe('precip-global');
        expect(settings.radars).toBe(true);
    });
});
