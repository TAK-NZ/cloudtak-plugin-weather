import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
    SLOT_ORDER, layerId, sourceId, markerAnchor, planBeforeId, requestsFor, requestFor, computeDesired, LayerStack,
    type DesiredLayer, type RasterLayerSpec, type RasterSourceSpec,
} from '../lib/layers.ts';
import { buildTileTemplate } from '../lib/relay-client.ts';
import { defaultSettings } from '../lib/state.ts';
import { clock } from '../lib/time.ts';
import { ATTRIBUTION, ID_PREFIX } from '../lib/constants.ts';
import type { LayerSlot, WeatherLayer, WeatherSettings } from '../lib/types.ts';
import { FakeMap } from './fake-map.ts';

const SNAP = 1768434600;
// "Now" is 5 minutes after the anchor, so the relay window is SNAP - 7200 .. SNAP.
beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime((SNAP + 900) * 1000);
    clock.offsetMs = 0;
});
afterEach(() => {
    vi.useRealTimers();
});
const ORIGIN = 'https://cot.test';

interface Sess {
    frame: number;
    snapshot: number;
    latest?: Partial<Record<WeatherLayer, number>>;
}

type Ev = 'clouds' | 'radars' | 'regional' | 'global';

function permutations<T>(items: T[]): T[][] {
    if (items.length <= 1) return [items.slice()];
    const out: T[][] = [];
    items.forEach((item, i) => {
        const rest = [...items.slice(0, i), ...items.slice(i + 1)];
        for (const p of permutations(rest)) out.push([item, ...p]);
    });
    return out;
}

/** Every event flips one of the four independent switches. */
function apply(s: WeatherSettings, ev: Ev): void {
    if (ev === 'clouds') s.clouds = !s.clouds;
    else if (ev === 'radars') s.radars = !s.radars;
    else if (ev === 'regional') s.precipRegional = !s.precipRegional;
    else s.precipGlobal = !s.precipGlobal;
}

function selected(s: WeatherSettings): Set<LayerSlot> {
    const out = new Set<LayerSlot>();
    if (s.clouds) out.add('clouds');
    if (s.precipGlobal) out.add('precip-global');
    if (s.precipRegional) out.add('precip');
    if (s.radars) out.add('radars');
    return out;
}

function urlsFor(s: WeatherSettings, sess: Sess): Partial<Record<LayerSlot, string>> {
    const reqs = requestsFor(s, sess);
    const out: Partial<Record<LayerSlot, string>> = {};
    for (const slot of SLOT_ORDER) {
        const r = reqs[slot];
        if (r) out[slot] = buildTileTemplate(ORIGIN, r, 'TOKEN');
    }
    return out;
}

function desired(s: WeatherSettings, sess: Sess): DesiredLayer[] {
    return computeDesired(s, sess, urlsFor(s, sess));
}

function sync(stack: LayerStack, s: WeatherSettings, sess: Sess): void {
    stack.sync(desired(s, sess));
}

const FOREIGN = FakeMap.initialLayers().map((l) => l.id);

function anchorOf(map: FakeMap): string | undefined {
    const foreign = map.layers.filter((l) => !l.id.startsWith(ID_PREFIX));
    return foreign.find((l) => l.source === '-1')?.id ?? foreign.find((l) => l.type === 'symbol')?.id;
}

function assertInvariants(map: FakeMap, s: WeatherSettings, sess: Sess, foreignExpected: string[] = FOREIGN): void {
    const ids = map.layers.map((l) => l.id);
    const ours = ids.filter((id) => id.startsWith(ID_PREFIX));
    const want = selected(s);

    // I1: plugin layer set equals the selection
    expect(new Set(ours)).toEqual(new Set([...want].map(layerId)));

    // I2: clouds < precip-global < precip < radars
    const ranks = ours.map((id) => SLOT_ORDER.findIndex((slot) => layerId(slot) === id));
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));

    // I3: below the marker anchor
    const anchor = anchorOf(map);
    if (anchor !== undefined) {
        const a = ids.indexOf(anchor);
        for (const id of ours) expect(ids.indexOf(id)).toBeLessThan(a);
    }

    // I4: unique ids, each layer has its source, no orphan sources
    expect(new Set(ids).size).toBe(ids.length);
    for (const slot of want) {
        expect(map.getLayer(layerId(slot))?.source).toBe(sourceId(slot));
        expect(map.getSource(sourceId(slot))).toBeDefined();
    }
    const ourSources = [...map.sources.keys()].filter((k) => k.startsWith(ID_PREFIX));
    expect(new Set(ourSources)).toEqual(new Set([...want].map(sourceId)));

    // I5: tile URLs equal the builder output
    const urls = urlsFor(s, sess);
    for (const slot of want) {
        expect(map.getSource(sourceId(slot))?.tiles).toEqual([urls[slot]]);
    }

    // I6: foreign layers keep their relative order
    expect(ids.filter((id) => !id.startsWith(ID_PREFIX))).toEqual(foreignExpected);
}

function fresh(): { map: FakeMap; stack: LayerStack; s: WeatherSettings; sess: Sess } {
    const map = new FakeMap();
    return { map, stack: new LayerStack(map), s: defaultSettings(), sess: { frame: 0, snapshot: SNAP } };
}

const MEMBERS: Ev[] = ['clouds', 'global', 'regional', 'radars'];

describe('markerAnchor and planBeforeId', () => {
    it('prefers the first Map Features layer', () => {
        expect(markerAnchor(new FakeMap().getStyle())).toBe('mf-polygons');
    });

    it('falls back to the first symbol layer', () => {
        const map = new FakeMap(FakeMap.initialLayers().filter((l) => l.source !== '-1'));
        expect(markerAnchor(map.getStyle())).toBe('labels');
    });

    it('is undefined without Map Features or symbol layers', () => {
        const map = new FakeMap([{ id: 'background', type: 'background' }, { id: 'basemap', type: 'raster', source: 'basemap' }]);
        expect(markerAnchor(map.getStyle())).toBeUndefined();
    });

    it('ignores its own layers', () => {
        const style = { layers: [{ id: 'taknz-wx-x', source: '-1' }, { id: 'taknz-wx-y', type: 'symbol' }] };
        expect(markerAnchor(style)).toBeUndefined();
    });

    // Case I
    it('planBeforeId returns the nearest present higher slot, else the anchor, for all 4 x 16 combinations', () => {
        const A = 'anchor';
        let checked = 0;
        for (const slot of SLOT_ORDER) {
            for (let mask = 0; mask < 16; mask++) {
                const present = new Set(SLOT_ORDER.filter((_, i) => mask & (1 << i)));
                const above = SLOT_ORDER.slice(SLOT_ORDER.indexOf(slot) + 1).find((x) => present.has(x));
                expect(planBeforeId(slot, present, A)).toBe(above ? layerId(above) : A);
                checked++;
            }
        }
        expect(checked).toBe(64);
        expect(planBeforeId('radars', new Set(), undefined)).toBeUndefined();
        expect(planBeforeId('clouds', new Set<LayerSlot>(['precip-global']), A)).toBe('taknz-wx-precip-global');
        expect(planBeforeId('precip-global', new Set<LayerSlot>(['precip', 'radars']), A)).toBe('taknz-wx-precip');
    });
});

describe('requestsFor and computeDesired', () => {
    it('returns one entry per slot, bottom to top', () => {
        const d = desired(defaultSettings(), { frame: 0, snapshot: SNAP });
        expect(d.map((x) => x.slot)).toEqual(['clouds', 'precip-global', 'precip', 'radars']);
        expect(d.every((x) => !x.on)).toBe(true);
    });

    it('only the rain request carries the forecast frame', () => {
        const s = defaultSettings();
        s.clouds = true;
        s.radars = true;
        s.precipRegional = true;
        s.precipGlobal = true;
        const r = requestsFor(s, { frame: 12, snapshot: SNAP });
        expect(r.precip?.query).toContainEqual(['forecast', '120']);
        expect(r['precip-global']?.query).toContainEqual(['forecast', '120']);
        expect(r.clouds?.query.map(([k]) => k)).toEqual(['layer', 'snapshot']);
        expect(r.radars?.query.map(([k]) => k)).not.toContain('forecast');
    });

    it('sets maxzoom, tileSize and opacity per slot', () => {
        const s = defaultSettings();
        s.clouds = true;
        s.radars = true;
        s.precipGlobal = true;
        s.precipRegional = true;
        s.tileSize = 256;
        s.opacity['precip-global'] = 0.4;
        const d = desired(s, { frame: 0, snapshot: SNAP });
        expect(d.map((x) => x.maxzoom)).toEqual([7, 9, 9, 7]);
        expect(d.map((x) => x.tileSize)).toEqual([256, 256, 256, 256]);
        expect(d.map((x) => x.opacity)).toEqual([0.5, 0.4, 0.7, 0.7]);
    });

    it('treats a selected slot without a tile URL as off', () => {
        const s = defaultSettings();
        s.clouds = true;
        const d = computeDesired(s, { frame: 0, snapshot: SNAP }, {});
        expect(d[0].on).toBe(false);
    });

    it('requestFor throws a RangeError for an invalid snapshot, computeDesired does not', () => {
        const s = defaultSettings();
        s.clouds = true;
        expect(() => requestFor('clouds', s, { frame: 0, snapshot: NaN })).toThrow(RangeError);
        expect(requestFor('radars', s, { frame: 0, snapshot: NaN })).toBeNull();
        expect(() => computeDesired(s, { frame: 0, snapshot: NaN }, {})).not.toThrow();
    });
});
describe('timeline requests', () => {
    const q = (r: ReturnType<typeof requestFor>): Record<string, string> => Object.fromEntries(r?.query ?? []);
    const ON: LayerSlot[] = ['clouds', 'precip', 'radars'];
    function all(): WeatherSettings {
        const s = defaultSettings();
        s.clouds = true;
        s.radars = true;
        s.precipRegional = true;
        return s;
    }
    it('Now: every layer uses the anchor and Rain has no forecast', () => {
        const r = requestsFor(all(), { frame: 0, snapshot: SNAP });
        expect(q(r.precip)).toMatchObject({ layer: 'precip', snapshot: String(SNAP), forecast: '0' });
        expect(q(r.clouds)).toEqual({ layer: 'clouds', snapshot: String(SNAP) });
        expect(q(r.radars)).toMatchObject({ layer: 'radars', snapshot: String(SNAP) });
    });
    it('the past is exact for every layer, with no forecast', () => {
        const r = requestsFor(all(), { frame: -4, snapshot: SNAP });
        for (const slot of ON) expect(q(r[slot]).snapshot).toBe(String(SNAP - 2400));
        expect(q(r.precip).forecast).toBe('0');
        expect(r.clouds?.query.map(([k]) => k)).toEqual(['layer', 'snapshot']);
    });
    it('the forecast: Rain takes forecast minutes, clouds and radar hold the anchor', () => {
        const r = requestsFor(all(), { frame: 3, snapshot: SNAP });
        expect(q(r.precip)).toMatchObject({ snapshot: String(SNAP), forecast: '30' });
        expect(q(r.clouds).snapshot).toBe(String(SNAP));
        expect(q(r.radars).snapshot).toBe(String(SNAP));
        expect(q(r.radars).forecast).toBeUndefined();
    });
    it('Rain forecasts from its own latest snapshot', () => {
        const sess = { frame: 6, snapshot: SNAP, latest: { precip: SNAP - 600, clouds: SNAP - 1200, radars: SNAP } };
        expect(q(requestFor('precip', all(), sess))).toMatchObject({ snapshot: String(SNAP - 600), forecast: '60' });
        const global = all();
        global.precipRegional = false;
        global.precipGlobal = true;
        expect(q(requestFor('precip-global', global, sess))).toMatchObject({ layer: 'precip-global', snapshot: String(SNAP), forecast: '60' });
        expect(requestFor('precip', global, sess)).toBeNull();
        const both = all();
        both.precipGlobal = true;
        const latest = { precip: SNAP - 600, 'precip-global': SNAP - 1200, clouds: SNAP, radars: SNAP };
        expect(q(requestFor('precip', both, { ...sess, latest }))).toMatchObject({ layer: 'precip', snapshot: String(SNAP - 600), forecast: '60' });
        expect(q(requestFor('precip-global', both, { ...sess, latest }))).toMatchObject({ layer: 'precip-global', snapshot: String(SNAP - 1200), forecast: '60' });
    });
    it('lagging clouds: the anchor is the newest layer, clouds are asked for the anchor and the relay clamps', () => {
        // plan D4: precip/radars latest = A, clouds latest = A - 600
        const sess = { frame: 0, snapshot: SNAP, latest: { precip: SNAP, 'precip-global': SNAP, radars: SNAP, clouds: SNAP - 600 } };
        const r = requestsFor(all(), sess);
        expect(q(r.clouds).snapshot).toBe(String(SNAP));
        expect(q(r.radars).snapshot).toBe(String(SNAP));
        expect(q(r.precip).snapshot).toBe(String(SNAP));
        expect(q(requestFor('clouds', all(), { ...sess, frame: -1 })).snapshot).toBe(String(SNAP - 600));
        expect(q(requestFor('clouds', all(), { ...sess, frame: 3 })).snapshot).toBe(String(SNAP));
    });
    it('the lower guard keeps -120 min inside the relay window while the anchor lags the clock', () => {
        vi.setSystemTime((SNAP + 1200 + 20) * 1000);
        const sess = { frame: -12, snapshot: SNAP };
        for (const slot of ON) expect(q(requestFor(slot, all(), sess)).snapshot).toBe(String(SNAP - 7200 + 600));
        expect(q(requestFor('precip', all(), { ...sess, frame: -11 })).snapshot).toBe(String(SNAP - 7200 + 600));
    });
    it('a relay without latest gives the plain anchor URLs at Now', () => {
        const withLatest = requestsFor(all(), { frame: 0, snapshot: SNAP, latest: {} });
        expect(withLatest).toEqual(requestsFor(all(), { frame: 0, snapshot: SNAP }));
        expect(q(withLatest.precip).snapshot).toBe(String(SNAP));
    });
    it('clamps a stale frame to what the settings allow', () => {
        const s = all();
        s.precipRegional = false;
        expect(requestFor('precip', s, { frame: 6, snapshot: SNAP })).toBeNull();
        expect(q(requestFor('clouds', s, { frame: 6, snapshot: SNAP })).snapshot).toBe(String(SNAP));
        expect(q(requestFor('clouds', all(), { frame: -99, snapshot: SNAP })).snapshot).toBe(String(SNAP - 7200));
        expect(q(requestFor('precip', all(), { frame: 99, snapshot: SNAP })).forecast).toBe('240');
    });
    it('an explicit frame overrides the committed one', () => {
        const r = requestFor('precip', all(), { frame: 0, snapshot: SNAP }, 5);
        expect(q(r)).toMatchObject({ snapshot: String(SNAP), forecast: '50' });
    });
    it('never emits api, provider or size', () => {
        const urls = ON.map((slot) => buildTileTemplate(ORIGIN, requestFor(slot, all(), { frame: -3, snapshot: SNAP }) as never, 't'));
        for (const u of urls) expect(u).not.toMatch(/[?&](api|provider|size)=/);
    });
});
describe('LayerStack: source and layer specs', () => {
    it('creates raster sources and layers with the documented options', () => {
        const { map, stack, s, sess } = fresh();
        s.precipGlobal = true;
        s.clouds = true;
        sync(stack, s, sess);

        const src = map.getSource(sourceId('precip-global'))?.spec as RasterSourceSpec;
        expect(src).toMatchObject({ type: 'raster', tileSize: 512, minzoom: 0, maxzoom: 9, attribution: ATTRIBUTION });
        expect((map.getSource(sourceId('clouds'))?.spec as RasterSourceSpec).maxzoom).toBe(7);

        const layer = map.getLayer(layerId('precip-global')) as unknown as RasterLayerSpec;
        expect(layer.type).toBe('raster');
        expect(layer.paint).toEqual({ 'raster-opacity': 0.7, 'raster-fade-duration': 0, 'raster-resampling': 'linear' });
    });
});

describe('Case A: enable-order matrices', () => {
    it('all 16 subsets of the four slots in every permutation of enabling (65 sequences)', () => {
        let sequences = 0;
        for (let mask = 0; mask < 16; mask++) {
            const members = MEMBERS.filter((_, i) => mask & (1 << i));
            for (const order of permutations(members)) {
                const { map, stack, s, sess } = fresh();
                for (const ev of order) {
                    apply(s, ev);
                    sync(stack, s, sess);
                    assertInvariants(map, s, sess);
                }
                expect(map.counters.moveLayer).toBe(0);
                expect(map.counters.addLayer).toBe(members.length);
                sequences++;
            }
        }
        expect(sequences).toBe(65);
    });
    it('the stacking matrix: for each of the 16 subsets the order and beforeId placement are exact', () => {
        for (let mask = 0; mask < 16; mask++) {
            const { map, stack, s, sess } = fresh();
            const members = MEMBERS.filter((_, i) => mask & (1 << i));
            for (const ev of members) apply(s, ev);
            sync(stack, s, sess);
            assertInvariants(map, s, sess);
            const want = SLOT_ORDER.filter((slot) => selected(s).has(slot)).map(layerId);
            const ids = map.layers.map((l) => l.id);
            expect(ids.filter((id) => id.startsWith(ID_PREFIX))).toEqual(want);
            // the weather layers are one contiguous block directly below the marker anchor
            const anchor = anchorOf(map) as string;
            if (want.length > 0) {
                expect(ids.indexOf(want[0]) + want.length - 1).toBe(ids.indexOf(want[want.length - 1]));
                expect(ids[ids.indexOf(anchor) - 1]).toBe(want[want.length - 1]);
            }
            // every layer was inserted in place (just below the next higher present layer or the anchor)
            expect(map.counters.moveLayer).toBe(0);
        }
    });
    it('from all-four-on, disabling in every one of the 24 orders', () => {
        for (const order of permutations<Ev>(['clouds', 'global', 'regional', 'radars'])) {
            const { map, stack, s, sess } = fresh();
            for (const ev of MEMBERS) apply(s, ev);
            sync(stack, s, sess);
            assertInvariants(map, s, sess);

            for (const ev of order) {
                apply(s, ev);
                sync(stack, s, sess);
                assertInvariants(map, s, sess);
            }
            expect(map.layers.some((l) => l.id.startsWith(ID_PREFIX))).toBe(false);
            expect(map.counters.moveLayer).toBe(0);
        }
    });

    it('from all-four-on, every removal followed by re-adding in every order', () => {
        let cases = 0;
        for (let mask = 1; mask < 16; mask++) {
            const removed = MEMBERS.filter((_, i) => mask & (1 << i));
            for (const readd of permutations(removed)) {
                const { map, stack, s, sess } = fresh();
                for (const ev of MEMBERS) apply(s, ev);
                sync(stack, s, sess);

                for (const ev of removed) {
                    apply(s, ev);
                    sync(stack, s, sess);
                    assertInvariants(map, s, sess);
                }
                for (const ev of readd) {
                    apply(s, ev);
                    sync(stack, s, sess);
                    assertInvariants(map, s, sess);
                }
                expect(map.counters.moveLayer).toBe(0);
                cases++;
            }
        }
        expect(cases).toBe(4 * 1 + 6 * 2 + 4 * 6 + 1 * 24);
    });

    it('is idempotent: a second sync of the same state changes nothing', () => {
        const { map, stack, s, sess } = fresh();
        for (const ev of MEMBERS) apply(s, ev);
        sync(stack, s, sess);
        map.resetCounters();
        sync(stack, s, sess);
        expect(map.counters).toEqual({ addSource: 0, addLayer: 0, removeLayer: 0, removeSource: 0, moveLayer: 0, setTiles: 0, setPaintProperty: 0 });
    });
});

describe('Case B: exhaustive event sequences of length 1..5 over the four switches', () => {
    it('keeps invariants I1-I6 and never calls moveLayer (1364 sequences)', () => {
        const events: Ev[] = ['clouds', 'radars', 'regional', 'global'];
        let total = 0;

        const run = (seq: Ev[]): void => {
            const { map, stack, s, sess } = fresh();
            let turnedOn = 0;
            let turnedOff = 0;

            for (const ev of seq) {
                const before = selected(s);
                apply(s, ev);
                const after = selected(s);
                for (const slot of SLOT_ORDER) {
                    if (!before.has(slot) && after.has(slot)) turnedOn++;
                    if (before.has(slot) && !after.has(slot)) turnedOff++;
                }
                sync(stack, s, sess);
                assertInvariants(map, s, sess);
            }

            expect(map.counters.moveLayer).toBe(0);
            expect(map.counters.addLayer).toBe(turnedOn);
            expect(map.counters.removeLayer).toBe(turnedOff);
            total++;
        };

        let level: Ev[][] = [[]];
        for (let len = 1; len <= 5; len++) {
            level = level.flatMap((seq) => events.map((e) => [...seq, e]));
            level.forEach(run);
        }
        expect(total).toBe(1364);
    });
});

describe('Case C: the two Rain layers', () => {
    it('both Rain layers on are two sources and two layers, Regional above Global', () => {
        const { map, stack, s, sess } = fresh();
        s.clouds = true;
        s.radars = true;
        s.precipRegional = true;
        s.precipGlobal = true;
        sync(stack, s, sess);
        assertInvariants(map, s, sess);
        const ours = map.layers.map((l) => l.id).filter((id) => id.startsWith(ID_PREFIX));
        expect(ours).toEqual(['taknz-wx-clouds', 'taknz-wx-precip-global', 'taknz-wx-precip', 'taknz-wx-radars']);
        expect(map.getSource(sourceId('precip'))?.tiles[0]).toContain('layer=precip&');
        expect(map.getSource(sourceId('precip-global'))?.tiles[0]).toContain('layer=precip-global&');
        expect(map.getSource(sourceId('precip'))?.tiles[0]).not.toBe(map.getSource(sourceId('precip-global'))?.tiles[0]);
        expect(map.counters.addSource).toBe(4);
        expect(map.counters.moveLayer).toBe(0);
    });
    it('switching one Rain layer does not touch the other', () => {
        const { map, stack, s, sess } = fresh();
        s.clouds = true;
        s.radars = true;
        s.precipRegional = true;
        s.precipGlobal = true;
        sync(stack, s, sess);
        const regional = map.getSource(sourceId('precip'))?.tiles[0];
        map.resetCounters();
        s.precipGlobal = false;
        sync(stack, s, sess);
        assertInvariants(map, s, sess);
        expect(map.counters).toEqual({ addSource: 0, addLayer: 0, removeLayer: 1, removeSource: 1, moveLayer: 0, setTiles: 0, setPaintProperty: 0 });
        expect(map.getSource(sourceId('precip'))?.tiles[0]).toBe(regional);
        map.resetCounters();
        s.precipGlobal = true;
        s.precipRegional = false;
        sync(stack, s, sess);
        assertInvariants(map, s, sess);
        expect(map.counters).toEqual({ addSource: 1, addLayer: 1, removeLayer: 1, removeSource: 1, moveLayer: 0, setTiles: 0, setPaintProperty: 0 });
    });
    it('the palette is shared and the opacity is per Rain layer', () => {
        const { map, stack, s, sess } = fresh();
        s.precipRegional = true;
        s.precipGlobal = true;
        s.palette.precip = '7';
        s.opacity['precip-global'] = 0.3;
        sync(stack, s, sess);
        expect(map.getSource(sourceId('precip'))?.tiles[0]).toContain('color=7');
        expect(map.getSource(sourceId('precip-global'))?.tiles[0]).toContain('color=7');
        expect((map.getLayer(layerId('precip')) as unknown as RasterLayerSpec).paint['raster-opacity']).toBe(0.7);
        expect((map.getLayer(layerId('precip-global')) as unknown as RasterLayerSpec).paint['raster-opacity']).toBe(0.3);
        map.resetCounters();
        s.opacity['precip-global'] = 0.5;
        sync(stack, s, sess);
        expect(map.counters).toEqual({ addSource: 0, addLayer: 0, removeLayer: 0, removeSource: 0, moveLayer: 0, setTiles: 0, setPaintProperty: 1 });
    });
    it('a forecast slider commit is exactly one setTiles, on the rain source', () => {
        const { map, stack, s, sess } = fresh();
        s.clouds = true;
        s.radars = true;
        s.precipRegional = true;
        sync(stack, s, sess);
        const cloudsTiles = map.getSource(sourceId('clouds'))?.tiles[0];
        const radarsTiles = map.getSource(sourceId('radars'))?.tiles[0];
        map.resetCounters();

        sess.frame = 12;
        sync(stack, s, sess);
        assertInvariants(map, s, sess);
        expect(map.counters.setTiles).toBe(1);
        expect(map.counters.addLayer + map.counters.removeLayer + map.counters.moveLayer).toBe(0);
        expect(map.getSource(sourceId('precip'))?.tiles[0]).toContain('forecast=120');
        expect(map.getSource(sourceId('clouds'))?.tiles[0]).toBe(cloudsTiles);
        expect(map.getSource(sourceId('radars'))?.tiles[0]).toBe(radarsTiles);
    });

    it('a snapshot rollover updates every active source once', () => {
        const { map, stack, s, sess } = fresh();
        for (const ev of MEMBERS) apply(s, ev);
        sync(stack, s, sess);
        map.resetCounters();

        sess.snapshot = SNAP + 600;
        sync(stack, s, sess);
        assertInvariants(map, s, sess);
        expect(map.counters.setTiles).toBe(4);
    });
});

describe('Case D: foreign interference', () => {
    function allOn(): ReturnType<typeof fresh> {
        const f = fresh();
        for (const ev of MEMBERS) apply(f.s, ev);
        sync(f.stack, f.s, f.sess);
        return f;
    }

    function repairAndCheck(f: ReturnType<typeof fresh>, foreignExpected: string[]): void {
        f.stack.ensureOrder();
        assertInvariants(f.map, f.s, f.sess, foreignExpected);
        f.map.resetCounters();
        f.stack.ensureOrder();
        expect(f.map.counters.moveLayer).toBe(0);
    }

    it('is a no-op (zero moveLayer calls) when the stack is already correct', () => {
        const f = allOn();
        f.map.resetCounters();
        expect(f.stack.ensureOrder()).toBe(false);
        expect(f.map.counters.moveLayer).toBe(0);
    });

    it('(1) a foreign layer between the plugin layers and the anchor', () => {
        const f = allOn();
        f.map.addForeign({ id: 'intruder', type: 'raster', source: 'intr' }, 'mf-polygons');
        repairAndCheck(f, [...FOREIGN.slice(0, 3), 'intruder', ...FOREIGN.slice(3)]);
    });

    it('(1b) a foreign layer between two plugin layers', () => {
        const f = allOn();
        f.map.addForeign({ id: 'intruder', type: 'raster', source: 'intr' }, layerId('precip'));
        f.stack.ensureOrder();
        assertInvariants(f.map, f.s, f.sess, [...FOREIGN.slice(0, 3), 'intruder', ...FOREIGN.slice(3)]);
    });

    it('(1c) a new Map Features layer below the plugin layers moves the anchor', () => {
        const f = allOn();
        f.map.addForeign({ id: 'mf-new', type: 'fill', source: '-1' }, 'overlay-7');
        expect(f.stack.ensureOrder()).toBe(true);
        const expected = [...FOREIGN];
        expected.splice(2, 0, 'mf-new');
        assertInvariants(f.map, f.s, f.sess, expected);
        f.map.resetCounters();
        expect(f.stack.ensureOrder()).toBe(false);
    });

    it('(2) Map Features layers removed and re-added at the top', () => {
        const f = allOn();
        f.map.removeForeign('mf-polygons');
        f.map.removeForeign('mf-lines');
        f.map.addForeign({ id: 'mf-polygons', type: 'fill', source: '-1' });
        f.map.addForeign({ id: 'mf-lines', type: 'line', source: '-1' });
        const expected = ['background', 'basemap', 'overlay-7', 'labels', 'mf-polygons', 'mf-lines'];
        repairAndCheck(f, expected);
    });

    it('(3) a user overlay moved to the top', () => {
        const f = allOn();
        f.map.moveForeign('overlay-7');
        repairAndCheck(f, FOREIGN.filter((id) => id !== 'overlay-7').concat('overlay-7'));
    });

    it('(4) plugin layers moved above the anchor and out of order', () => {
        const f = allOn();
        f.map.moveForeign(layerId('radars'));
        f.map.moveForeign(layerId('clouds'));
        f.map.moveForeign(layerId('precip'));
        expect(f.stack.ensureOrder()).toBe(true);
        assertInvariants(f.map, f.s, f.sess);
        f.map.resetCounters();
        f.stack.ensureOrder();
        expect(f.map.counters.moveLayer).toBe(0);
    });

    it('keeps working after a repair: later toggles still stack correctly', () => {
        const f = allOn();
        f.map.moveForeign(layerId('radars'));
        f.stack.ensureOrder();
        apply(f.s, 'clouds');
        sync(f.stack, f.s, f.sess);
        apply(f.s, 'clouds');
        sync(f.stack, f.s, f.sess);
        assertInvariants(f.map, f.s, f.sess);
    });
});

describe('Case E: no Map Features layers', () => {
    it('falls back to the first symbol layer', () => {
        const map = new FakeMap(FakeMap.initialLayers().filter((l) => l.source !== '-1'));
        const stack = new LayerStack(map);
        const s = defaultSettings();
        const sess = { frame: 0, snapshot: SNAP };
        for (const ev of MEMBERS) {
            apply(s, ev);
            sync(stack, s, sess);
        }
        const ids = map.layers.map((l) => l.id);
        expect(ids.slice(-5)).toEqual([layerId('clouds'), layerId('precip-global'), layerId('precip'), layerId('radars'), 'labels']);
        expect(map.counters.moveLayer).toBe(0);
    });

    it('appends to the top without any anchor and ensureOrder still gives clouds < rain < radar', () => {
        const map = new FakeMap([{ id: 'background', type: 'background' }, { id: 'basemap', type: 'raster', source: 'basemap' }]);
        const stack = new LayerStack(map);
        const s = defaultSettings();
        const sess = { frame: 0, snapshot: SNAP };

        for (const ev of ['radars', 'regional', 'clouds'] as Ev[]) {
            apply(s, ev);
            sync(stack, s, sess);
        }
        expect(map.layers.map((l) => l.id)).toEqual(['background', 'basemap', layerId('clouds'), layerId('precip'), layerId('radars')]);
        expect(map.counters.moveLayer).toBe(0);

        map.moveForeign(layerId('precip'));
        expect(stack.ensureOrder()).toBe(true);
        expect(map.layers.map((l) => l.id)).toEqual(['background', 'basemap', layerId('clouds'), layerId('precip'), layerId('radars')]);
        map.resetCounters();
        expect(stack.ensureOrder()).toBe(false);
    });
});

describe('Case F: re-creation keeps the position', () => {
    it('tileSize 512 -> 256 re-creates every layer in place', () => {
        const { map, stack, s, sess } = fresh();
        for (const ev of MEMBERS) apply(s, ev);
        sync(stack, s, sess);
        const before = map.layers.map((l) => l.id);
        map.resetCounters();

        s.tileSize = 256;
        sync(stack, s, sess);
        assertInvariants(map, s, sess);
        expect(map.layers.map((l) => l.id)).toEqual(before);
        expect(map.counters.addLayer).toBe(4);
        expect(map.counters.removeLayer).toBe(4);
        expect(map.counters.moveLayer).toBe(0);
        expect((map.getSource(sourceId('precip'))?.spec as RasterSourceSpec).tileSize).toBe(256);
    });

    it('a maxzoom change re-creates only the rain layer, between clouds and radar', () => {
        const { map, stack, s, sess } = fresh();
        for (const ev of MEMBERS) apply(s, ev);
        sync(stack, s, sess);
        const before = map.layers.map((l) => l.id);
        map.resetCounters();

        stack.sync(desired(s, sess).map((d) => d.slot === 'precip' ? { ...d, maxzoom: 8 } : d));
        expect(map.layers.map((l) => l.id)).toEqual(before);
        expect(map.counters.addLayer).toBe(1);
        expect(map.counters.removeLayer).toBe(1);
        expect(map.counters.moveLayer).toBe(0);
    });
});

describe('Case G: map re-initialisation', () => {
    it('removeAll tolerates a map that lost its layers', () => {
        const { map, stack, s, sess } = fresh();
        for (const ev of MEMBERS) apply(s, ev);
        sync(stack, s, sess);

        map.dropPrefixed(ID_PREFIX);
        expect(() => stack.removeAll()).not.toThrow();
        expect(stack.stackIds()).toEqual([]);
    });

    it('removeAll removes layers before sources and leaves foreign layers alone', () => {
        const { map, stack, s, sess } = fresh();
        for (const ev of MEMBERS) apply(s, ev);
        sync(stack, s, sess);

        stack.removeAll();
        expect(map.layers.map((l) => l.id)).toEqual(FOREIGN);
        expect([...map.sources.keys()].filter((k) => k.startsWith(ID_PREFIX))).toEqual([]);
        expect(() => stack.removeAll()).not.toThrow();
    });

    it('sync re-adds the whole selection after the map lost its layers', () => {
        const { map, stack, s, sess } = fresh();
        for (const ev of MEMBERS) apply(s, ev);
        sync(stack, s, sess);

        map.dropPrefixed(ID_PREFIX);
        sync(stack, s, sess);
        assertInvariants(map, s, sess);
    });

    it('a new stack on a fresh map re-adds the whole selection', () => {
        const first = fresh();
        for (const ev of MEMBERS) apply(first.s, ev);
        sync(first.stack, first.s, first.sess);

        const map = new FakeMap();
        const stack = new LayerStack(map);
        sync(stack, first.s, first.sess);
        assertInvariants(map, first.s, first.sess);
        expect(map.counters.addLayer).toBe(4);
    });
});

describe('Case H: opacity', () => {
    it('an opacity change calls only setPaintProperty', () => {
        const { map, stack, s, sess } = fresh();
        for (const ev of MEMBERS) apply(s, ev);
        sync(stack, s, sess);
        map.resetCounters();

        s.opacity.precip = 0.4;
        sync(stack, s, sess);
        expect(map.counters).toEqual({ addSource: 0, addLayer: 0, removeLayer: 0, removeSource: 0, moveLayer: 0, setTiles: 0, setPaintProperty: 1 });
        expect(map.getLayer(layerId('precip'))?.paint?.['raster-opacity']).toBe(0.4);
    });
});

describe('sourcesLoaded', () => {
    it('is true when the map cannot tell, and follows isSourceLoaded when it can', () => {
        const { map, stack, s, sess } = fresh();
        apply(s, 'clouds');
        apply(s, 'regional');
        sync(stack, s, sess);
        expect(stack.sourcesLoaded()).toBe(true);

        const loaded = new Set<string>([sourceId('clouds')]);
        (map as unknown as { isSourceLoaded: (id: string) => boolean }).isSourceLoaded = (id) => loaded.has(id);
        expect(stack.sourcesLoaded()).toBe(false);
        loaded.add(sourceId('precip'));
        expect(stack.sourcesLoaded()).toBe(true);
    });
});
