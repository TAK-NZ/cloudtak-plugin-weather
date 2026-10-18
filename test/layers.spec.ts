import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
    SLOT_ORDER, HIDDEN_OPACITY, SETTLE_RENDERS, layerId, sourceId, bufferLayerId, bufferSourceId, markerAnchor, planBeforeId, requestsFor, requestFor,
    computeDesired, noForecastAt, LayerStack,
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
    lastUrls = {};
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

/** The URLs on the map, like `act.applied` in index.ts: a slot without a forecast keeps its last URL. */
let lastUrls: Partial<Record<LayerSlot, string>> = {};
function urlsFor(s: WeatherSettings, sess: Sess): Partial<Record<LayerSlot, string>> {
    const reqs = requestsFor(s, sess);
    const out: Partial<Record<LayerSlot, string>> = {};
    for (const slot of SLOT_ORDER) {
        const r = reqs[slot];
        if (r) out[slot] = buildTileTemplate(ORIGIN, r, 'TOKEN');
        else if (noForecastAt(slot, s, sess.frame) && lastUrls[slot] !== undefined) out[slot] = lastUrls[slot];
    }
    lastUrls = { ...out };
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
    const urls = urlsFor(s, sess);
    // a slot that was never shown before the forecast has no layer
    const want = new Set([...selected(s)].filter((slot) => urls[slot] !== undefined));

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
        expect(r.clouds).toBeNull();
        expect(r.radars).toBeNull();
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

    it('marks a selected Clouds or Radar slot without a forecast as hidden, only at k > 0 with Rain on', () => {
        const s = defaultSettings();
        s.clouds = true;
        s.radars = true;
        s.precipRegional = true;
        const keep = { clouds: 'https://x/c', radars: 'https://x/r', precip: 'https://x/p' };
        const at = (frame: number, urls: Partial<Record<LayerSlot, string>> = keep) => computeDesired(s, { frame, snapshot: SNAP }, urls);
        for (const frame of [1, 3, 24]) {
            expect(at(frame).map((d) => Boolean(d.hidden))).toEqual([true, false, false, true]);
            // the last URL keeps the slot on the map, hidden
            expect(at(frame).map((d) => d.on)).toEqual([true, false, true, true]);
        }
        for (const frame of [0, -1, -12]) expect(at(frame).some((d) => d.hidden)).toBe(false);
        // never shown before: nothing to keep, the slot stays off
        expect(at(3, { precip: 'https://x/p' }).map((d) => d.on)).toEqual([false, false, true, false]);
        // a switched-off slot is not "hidden"
        s.clouds = false;
        expect(at(3)[0].hidden).toBeUndefined();
        // without Rain the frame clamps to Now
        s.precipRegional = false;
        expect(at(3).some((d) => d.hidden)).toBe(false);
    });
    it('a hidden slot has nothing to wait for when the preload frame is a forecast frame too', () => {
        const s = defaultSettings();
        s.clouds = true;
        s.precipRegional = true;
        const urls = { clouds: 'https://x/c', precip: 'https://x/p' };
        const pre = (key: number) => computeDesired(s, { frame: 3, snapshot: SNAP }, urls, { key, tiles: key > 0 ? { precip: 'https://x/p2' } : { precip: 'https://x/p2', clouds: 'https://x/c2' } });
        expect(pre(4)[0]).toMatchObject({ hidden: true, preloadNone: 4 });
        expect(pre(4)[0].preload).toBeUndefined();
        expect(pre(-12)[0].preload).toEqual({ tiles: 'https://x/c2', key: -12 });
        expect(pre(-12)[0].preloadNone).toBeUndefined();
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
    it('the forecast: Rain takes forecast minutes, clouds and radar have no request', () => {
        for (const frame of [1, 3, 24]) {
            const r = requestsFor(all(), { frame, snapshot: SNAP });
            expect(q(r.precip)).toMatchObject({ snapshot: String(SNAP), forecast: String(frame * 10) });
            expect(r.clouds).toBeNull();
            expect(r.radars).toBeNull();
        }
        // Now and the past are unchanged
        for (const frame of [0, -1, -12]) {
            const r = requestsFor(all(), { frame, snapshot: SNAP });
            expect(r.clouds).not.toBeNull();
            expect(r.radars).not.toBeNull();
        }
    });
    it('an explicit forecast frame gives no clouds or radar request, a past frame does', () => {
        expect(requestFor('clouds', all(), { frame: 0, snapshot: SNAP }, 5)).toBeNull();
        expect(requestFor('radars', all(), { frame: 0, snapshot: SNAP }, 5)).toBeNull();
        expect(q(requestFor('clouds', all(), { frame: 24, snapshot: SNAP }, -12)).snapshot).toBe(String(SNAP - 7200));
        expect(q(requestFor('radars', all(), { frame: 24, snapshot: SNAP }, -12)).snapshot).toBe(String(SNAP - 7200));
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
        expect(requestFor('clouds', all(), { ...sess, frame: 3 })).toBeNull();
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

// ---------------------------------------------------------------------------------------------
// Double buffering
// ---------------------------------------------------------------------------------------------

type Buf = 0 | 1;
const BUFS: readonly Buf[] = [0, 1];

interface Frames {
    /** The shown frame. */
    f: number;
    /** The frame the hidden buffers load, or null. */
    pre: number | null;
}

/** The relay URL of each slot that has a request at `frame`. */
function preUrlsAt(s: WeatherSettings, sess: Sess, frame: number): Partial<Record<LayerSlot, string>> {
    const reqs = requestsFor(s, sess, frame);
    const out: Partial<Record<LayerSlot, string>> = {};
    for (const slot of SLOT_ORDER) {
        const r = reqs[slot];
        if (r) out[slot] = buildTileTemplate(ORIGIN, r, 'TOKEN');
    }
    return out;
}

/** The URLs of the shown frame, like `act.applied` in index.ts: a slot without a forecast keeps its last URL. */
function urlsAt(s: WeatherSettings, sess: Sess, frame: number): Partial<Record<LayerSlot, string>> {
    const out = preUrlsAt(s, sess, frame);
    for (const slot of SLOT_ORDER) {
        if (out[slot] === undefined && noForecastAt(slot, s, frame) && lastUrls[slot] !== undefined) out[slot] = lastUrls[slot];
    }
    lastUrls = { ...out };
    return out;
}

function desiredAt(s: WeatherSettings, sess: Sess, fr: Frames): DesiredLayer[] {
    const shown = { ...sess, frame: fr.f };
    return computeDesired(s, shown, urlsAt(s, shown, fr.f), fr.pre === null ? undefined : { key: fr.pre, tiles: preUrlsAt(s, shown, fr.pre) });
}

/** Let MapLibre render long enough for a swap to settle. */
function settle(stack: LayerStack): void {
    for (let i = 0; i < SETTLE_RENDERS; i++) stack.noteMapEvent('render');
}

/** Sync only: no render events reach the stack. */
function syncRaw(stack: LayerStack, s: WeatherSettings, sess: Sess, fr: Frames): void {
    stack.sync(desiredAt(s, sess, fr));
}

/** Sync, then let the swap settle, so a stopped preload is gone again. */
function syncAt(stack: LayerStack, s: WeatherSettings, sess: Sess, fr: Frames): void {
    stack.sync(desiredAt(s, sess, fr));
    settle(stack);
}

/** Invariants I1-I9 for a stack with buffers. */
function assertBuffers(map: FakeMap, s: WeatherSettings, sess: Sess, fr: Frames, foreignExpected: string[] = FOREIGN): void {
    const ids = map.layers.map((l) => l.id);
    const shown = { ...sess, frame: fr.f };
    const urls = urlsAt(s, shown, fr.f);
    const want = new Set([...selected(s)].filter((slot) => urls[slot] !== undefined));
    const preUrls = fr.pre === null ? {} : preUrlsAt(s, shown, fr.pre);

    // I2: flattened order clouds < global < regional < radars with a below b, and nothing unknown
    const flat: string[] = [];
    for (const slot of SLOT_ORDER) {
        for (const buf of BUFS) if (ids.includes(bufferLayerId(slot, buf))) flat.push(bufferLayerId(slot, buf));
    }
    expect(ids.filter((id) => id.startsWith(ID_PREFIX))).toEqual(flat);

    // I3: below the marker anchor
    const anchor = anchorOf(map);
    if (anchor !== undefined) for (const id of flat) expect(ids.indexOf(id)).toBeLessThan(ids.indexOf(anchor));

    const sources: string[] = [];
    for (const slot of SLOT_ORDER) {
        const present = BUFS.filter((b) => ids.includes(bufferLayerId(slot, b)));
        if (!want.has(slot)) {
            expect(present).toEqual([]);
            continue;
        }
        // I7: one or two buffers; a directly below b
        expect(present.length).toBeGreaterThanOrEqual(1);
        if (present.length === 2) expect(ids.indexOf(bufferLayerId(slot, 1))).toBe(ids.indexOf(bufferLayerId(slot, 0)) + 1);

        // I8: the visible buffer has the user opacity, the hidden one HIDDEN_OPACITY
        const opacity = (b: Buf): unknown => map.getLayer(bufferLayerId(slot, b))?.paint?.['raster-opacity'];
        const visible = present.filter((b) => opacity(b) === s.opacity[slot]);
        const hidden = present.filter((b) => opacity(b) === HIDDEN_OPACITY);
        expect(visible.length).toBe(1);
        expect(visible.length + hidden.length).toBe(present.length);

        // I5: the visible buffer shows the frame, the hidden one the preload (and only when it differs)
        expect(map.getSource(bufferSourceId(slot, visible[0]))?.tiles).toEqual([urls[slot]]);
        // (a layout-hidden slot is not loading its shown buffer, so an equal URL loads in the other buffer too)
        if (fr.pre !== null && preUrls[slot] !== undefined && (preUrls[slot] !== urls[slot] || noForecastAt(slot, s, fr.f))) {
            expect(hidden.length).toBe(1);
            expect(map.getSource(bufferSourceId(slot, hidden[0]))?.tiles).toEqual([preUrls[slot]]);
            // the preloading buffer is drawn (opacity 0) so MapLibre loads it
            expect(map.isDrawn(bufferLayerId(slot, hidden[0]))).toBe(true);
        } else {
            expect(hidden.length).toBe(0);
        }
        // a slot without a forecast at the shown frame is layout-hidden: no tile requests
        expect(map.isDrawn(bufferLayerId(slot, visible[0]))).toBe(!noForecastAt(slot, s, fr.f));

        for (const b of present) {
            expect(map.getLayer(bufferLayerId(slot, b))?.source).toBe(bufferSourceId(slot, b));
            sources.push(bufferSourceId(slot, b));
        }
    }

    // I4/I9: unique ids; every source has a layer, every layer a source; no orphans
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set([...map.sources.keys()].filter((k) => k.startsWith(ID_PREFIX)))).toEqual(new Set(sources));

    // I6: foreign layers keep their order
    expect(ids.filter((id) => !id.startsWith(ID_PREFIX))).toEqual(foreignExpected);
}

function freshBuf(): ReturnType<typeof fresh> & { fr: Frames } {
    return { ...fresh(), fr: { f: -8, pre: null } };
}

describe('buffer ids', () => {
    it('layerId and sourceId give the a buffer; bufferLayerId gives both', () => {
        expect(layerId('precip')).toBe('taknz-wx-precip');
        expect(sourceId('precip')).toBe('taknz-wx-precip-src');
        expect(bufferLayerId('precip', 0)).toBe('taknz-wx-precip');
        expect(bufferLayerId('precip', 1)).toBe('taknz-wx-precip-b');
        expect(bufferSourceId('precip-global', 1)).toBe('taknz-wx-precip-global-b-src');
    });
    it('slots.map(layerId) is not confused by the array index', () => {
        expect(SLOT_ORDER.map(layerId)).toEqual(SLOT_ORDER.map((slot) => bufferLayerId(slot, 0)));
    });
    it('the hidden buffer is invisible but not hidden from MapLibre', () => {
        expect(HIDDEN_OPACITY).toBe(0);
    });
});

describe('Case I: double buffering', () => {
    it('keeps invariants I1-I9 and never calls moveLayer (4680 sequences over 8 events)', () => {
        type E = 'clouds' | 'radars' | 'regional' | 'global' | 'start' | 'advance' | 'stop' | 'jump';
        const events: E[] = ['clouds', 'radars', 'regional', 'global', 'start', 'advance', 'stop', 'jump'];
        let total = 0;

        const run = (seq: E[]): void => {
            const { map, stack, s, sess, fr } = freshBuf();
            for (const ev of seq) {
                if (ev === 'clouds' || ev === 'radars' || ev === 'regional' || ev === 'global') apply(s, ev);
                else if (ev === 'start') fr.pre = fr.f + 1;
                else if (ev === 'advance') {
                    fr.f += 1;
                    fr.pre = fr.f + 1;
                } else if (ev === 'stop') fr.pre = null;
                else {
                    fr.f += 3;
                    if (fr.pre !== null) fr.pre = fr.f + 1;
                }
                syncAt(stack, s, sess, fr);
                assertBuffers(map, s, sess, fr);
            }
            expect(map.counters.moveLayer).toBe(0);
            stack.removeAll();
            expect(map.layers.map((l) => l.id)).toEqual(FOREIGN);
            expect([...map.sources.keys()].filter((k) => k.startsWith(ID_PREFIX))).toEqual([]);
            total++;
        };

        let level: E[][] = [[]];
        for (let len = 1; len <= 4; len++) {
            level = level.flatMap((seq) => events.map((e) => [...seq, e]));
            level.forEach(run);
        }
        expect(total).toBe(4680);
    });

    it('all 16 subsets, preload off then on then advanced six times', () => {
        for (let mask = 0; mask < 16; mask++) {
            const { map, stack, s, sess, fr } = freshBuf();
            for (const ev of MEMBERS.filter((_, i) => mask & (1 << i))) apply(s, ev);
            syncAt(stack, s, sess, fr);
            assertBuffers(map, s, sess, fr);
            const n = selected(s).size;
            expect(map.layers.filter((l) => l.id.startsWith(ID_PREFIX)).length).toBe(n);

            fr.pre = fr.f + 1;
            syncAt(stack, s, sess, fr);
            assertBuffers(map, s, sess, fr);
            expect(map.layers.filter((l) => l.id.startsWith(ID_PREFIX)).length).toBe(2 * n);

            for (let i = 0; i < 6; i++) {
                fr.f += 1;
                fr.pre = fr.f + 1;
                syncAt(stack, s, sess, fr);
                assertBuffers(map, s, sess, fr);
            }
            expect(map.counters.moveLayer).toBe(0);
        }
    });

    it('creates the hidden buffer above the visible one with the same options, at HIDDEN_OPACITY', () => {
        const { map, stack, s, sess, fr } = freshBuf();
        s.precipRegional = true;
        s.tileSize = 256;
        syncAt(stack, s, sess, fr);
        fr.pre = -7;
        syncAt(stack, s, sess, fr);
        const a = map.getSource('taknz-wx-precip-src')?.spec as RasterSourceSpec;
        const b = map.getSource('taknz-wx-precip-b-src')?.spec as RasterSourceSpec;
        expect({ ...b, tiles: a.tiles }).toEqual(a);
        expect(b.attribution).toBe(ATTRIBUTION);
        expect(map.getLayer('taknz-wx-precip-b')?.paint).toEqual({ 'raster-opacity': 0, 'raster-fade-duration': 0, 'raster-resampling': 'linear' });
        const ids = map.layers.map((l) => l.id);
        expect(ids.indexOf('taknz-wx-precip-b')).toBe(ids.indexOf('taknz-wx-precip') + 1);
        expect(ids[ids.indexOf('taknz-wx-precip-b') + 1]).toBe('mf-polygons');
    });

    it('a frame step swaps with exactly two setPaintProperty calls, one setTiles on the hidden buffer and no add/remove/move', () => {
        const { map, stack, s, sess, fr } = freshBuf();
        s.precipRegional = true;
        s.clouds = true;
        fr.pre = -7;
        syncAt(stack, s, sess, fr);
        map.resetCounters();

        fr.f = -7;
        fr.pre = -6;
        syncAt(stack, s, sess, fr);
        assertBuffers(map, s, sess, fr);
        expect(map.counters).toEqual({ addSource: 0, addLayer: 0, removeLayer: 0, removeSource: 0, moveLayer: 0, setTiles: 2, setPaintProperty: 4 });
        // the new frame becomes visible, the old one is hidden
        expect(map.paintLog.filter((p) => p.layer === 'taknz-wx-precip-b')).toEqual([{ layer: 'taknz-wx-precip-b', name: 'raster-opacity', value: 0.7 }]);
        expect(map.paintLog.filter((p) => p.layer === 'taknz-wx-precip')).toEqual([{ layer: 'taknz-wx-precip', name: 'raster-opacity', value: HIDDEN_OPACITY }]);
        // only the hidden source (the old visible one) was retargeted
        expect(map.tilesLog.map((t) => t.source).sort()).toEqual(['taknz-wx-clouds-src', 'taknz-wx-precip-src']);
    });

    it('seven swaps in a row keep adjacency, ids and the opacity roles', () => {
        const { map, stack, s, sess, fr } = freshBuf();
        for (const ev of MEMBERS) apply(s, ev);
        fr.pre = fr.f + 1;
        syncAt(stack, s, sess, fr);
        const ids = map.layers.map((l) => l.id);
        for (let i = 0; i < 7; i++) {
            fr.f += 1;
            fr.pre = fr.f + 1;
            syncAt(stack, s, sess, fr);
            assertBuffers(map, s, sess, fr);
            expect(map.layers.map((l) => l.id)).toEqual(ids);
        }
        expect(map.counters.moveLayer).toBe(0);
        expect(map.counters.addLayer).toBe(8);
    });

    it('stopping the preload removes the hidden buffer (layer then source) and keeps the shown frame', () => {
        const { map, stack, s, sess, fr } = freshBuf();
        for (const ev of MEMBERS) apply(s, ev);
        fr.pre = -7;
        syncAt(stack, s, sess, fr);
        fr.f = -7;
        fr.pre = -6;
        syncAt(stack, s, sess, fr);
        map.resetCounters();
        fr.pre = null;
        syncAt(stack, s, sess, fr);
        assertBuffers(map, s, sess, fr);
        expect(map.counters).toEqual({ addSource: 0, addLayer: 0, removeLayer: 4, removeSource: 4, moveLayer: 0, setTiles: 0, setPaintProperty: 0 });
        // the `a` buffers were hidden after the swap, so the `b` ones remain: they keep their position
        expect(stack.lowestLayerId('precip')).toBe('taknz-wx-precip-b');
        expect(map.layers.filter((l) => l.id.startsWith(ID_PREFIX)).map((l) => l.id)).toEqual([
            'taknz-wx-clouds-b', 'taknz-wx-precip-global-b', 'taknz-wx-precip-b', 'taknz-wx-radars-b',
        ]);
    });

    it('with only a b buffer left, later layers still go in the right place and the next preload goes below it', () => {
        const { map, stack, s, sess, fr } = freshBuf();
        s.precipRegional = true;
        fr.pre = -7;
        syncAt(stack, s, sess, fr);
        fr.f = -7;
        fr.pre = null;
        syncAt(stack, s, sess, fr);
        expect(map.layers.map((l) => l.id).filter((id) => id.startsWith(ID_PREFIX))).toEqual(['taknz-wx-precip-b']);
        s.clouds = true;
        s.radars = true;
        s.precipGlobal = true;
        syncAt(stack, s, sess, fr);
        assertBuffers(map, s, sess, fr);
        fr.pre = -6;
        syncAt(stack, s, sess, fr);
        assertBuffers(map, s, sess, fr);
        const ids = map.layers.map((l) => l.id);
        expect(ids.indexOf('taknz-wx-precip')).toBe(ids.indexOf('taknz-wx-precip-b') - 1);
        expect(map.counters.moveLayer).toBe(0);
    });

    it('removing a slot removes both of its buffers and their sources', () => {
        const { map, stack, s, sess, fr } = freshBuf();
        for (const ev of MEMBERS) apply(s, ev);
        fr.pre = -7;
        syncAt(stack, s, sess, fr);
        s.precipRegional = false;
        syncAt(stack, s, sess, fr);
        assertBuffers(map, s, sess, fr);
        expect(map.getLayer('taknz-wx-precip')).toBeUndefined();
        expect(map.getLayer('taknz-wx-precip-b')).toBeUndefined();
        expect(map.getSource('taknz-wx-precip-src')).toBeUndefined();
        expect(map.getSource('taknz-wx-precip-b-src')).toBeUndefined();
        for (const ev of MEMBERS) if (ev !== 'regional') apply(s, ev);
        syncAt(stack, s, sess, fr);
        expect([...map.sources.keys()].filter((k) => k.startsWith(ID_PREFIX))).toEqual([]);
    });

    it('a palette change while preloading retargets both buffers without adding or removing anything', () => {
        const { map, stack, s, sess, fr } = freshBuf();
        s.precipRegional = true;
        s.precipGlobal = true;
        fr.pre = -7;
        syncAt(stack, s, sess, fr);
        map.resetCounters();
        s.palette.precip = '7';
        syncAt(stack, s, sess, fr);
        assertBuffers(map, s, sess, fr);
        expect(map.counters).toEqual({ addSource: 0, addLayer: 0, removeLayer: 0, removeSource: 0, moveLayer: 0, setTiles: 4, setPaintProperty: 0 });
        expect(map.getSource('taknz-wx-precip-b-src')?.tiles[0]).toContain('color=7');
    });

    it('switching Regional off and Global on while preloading touches only those two slots', () => {
        const { map, stack, s, sess, fr } = freshBuf();
        s.clouds = true;
        s.precipRegional = true;
        fr.pre = -7;
        syncAt(stack, s, sess, fr);
        map.resetCounters();
        s.precipRegional = false;
        s.precipGlobal = true;
        syncAt(stack, s, sess, fr);
        assertBuffers(map, s, sess, fr);
        expect(map.counters).toEqual({ addSource: 2, addLayer: 2, removeLayer: 2, removeSource: 2, moveLayer: 0, setTiles: 0, setPaintProperty: 0 });
    });

    it('a tileSize change re-creates both buffers in place', () => {
        const { map, stack, s, sess, fr } = freshBuf();
        for (const ev of MEMBERS) apply(s, ev);
        fr.pre = -7;
        syncAt(stack, s, sess, fr);
        const before = map.layers.map((l) => l.id);
        map.resetCounters();
        s.tileSize = 256;
        syncAt(stack, s, sess, fr);
        assertBuffers(map, s, sess, fr);
        expect(map.layers.map((l) => l.id)).toEqual(before);
        expect(map.counters.addLayer).toBe(8);
        expect(map.counters.removeLayer).toBe(8);
        expect(map.counters.moveLayer).toBe(0);
        expect((map.getSource('taknz-wx-precip-b-src')?.spec as RasterSourceSpec).tileSize).toBe(256);
    });

    it('syncing an unchanged state with a preload makes no map call at all', () => {
        const { map, stack, s, sess, fr } = freshBuf();
        for (const ev of MEMBERS) apply(s, ev);
        fr.pre = -7;
        syncAt(stack, s, sess, fr);
        fr.f = -7;
        fr.pre = -6;
        syncAt(stack, s, sess, fr);
        map.resetCounters();
        syncAt(stack, s, sess, fr);
        expect(map.counters).toEqual({ addSource: 0, addLayer: 0, removeLayer: 0, removeSource: 0, moveLayer: 0, setTiles: 0, setPaintProperty: 0 });
    });

    it('an opacity change touches only the visible buffer', () => {
        const { map, stack, s, sess, fr } = freshBuf();
        s.precipRegional = true;
        fr.pre = -7;
        syncAt(stack, s, sess, fr);
        map.resetCounters();
        s.opacity.precip = 0.4;
        syncAt(stack, s, sess, fr);
        expect(map.paintLog).toEqual([{ layer: 'taknz-wx-precip', name: 'raster-opacity', value: 0.4 }]);
        expect(map.getLayer('taknz-wx-precip-b')?.paint?.['raster-opacity']).toBe(HIDDEN_OPACITY);
        // and the swap afterwards shows the new opacity
        fr.f = -7;
        fr.pre = -6;
        syncAt(stack, s, sess, fr);
        expect(map.getLayer('taknz-wx-precip-b')?.paint?.['raster-opacity']).toBe(0.4);
    });

    it('frames that repeat (clouds and radar after Now) load nothing into a hidden buffer', () => {
        const { map, stack, s, sess } = freshBuf();
        s.clouds = true;
        s.radars = true;
        s.precipRegional = true;
        const fr: Frames = { f: 0, pre: 1 };
        syncAt(stack, s, sess, fr);
        assertBuffers(map, s, sess, fr);
        expect(map.getLayer('taknz-wx-clouds-b')).toBeUndefined();
        expect(map.getLayer('taknz-wx-radars-b')).toBeUndefined();
        expect(map.getLayer('taknz-wx-precip-b')).toBeDefined();
    });

    it('stacking matrix: 16 subsets x frames -12, 0, +3, +24 keep the order, hide Clouds and Radar after Now and never move a layer', () => {
        const sequence = [-12, 0, 3, 24, 3, 0, -12, 24, -12];
        let checked = 0;
        for (let mask = 1; mask < 16; mask++) {
            const { map, stack, s, sess } = freshBuf();
            s.clouds = Boolean(mask & 1);
            s.precipGlobal = Boolean(mask & 2);
            s.precipRegional = Boolean(mask & 4);
            s.radars = Boolean(mask & 8);
            const rain = s.precipGlobal || s.precipRegional;
            for (const [i, f] of sequence.entries()) {
                if (f > 0 && !rain) continue;
                const next = sequence[(i + 1) % sequence.length];
                const fr: Frames = { f, pre: next > 0 && !rain ? null : next };
                const d = desiredAt(s, sess, fr);
                // desired layers at k > 0: Clouds and Radar are never drawn
                for (const x of d) {
                    if (x.slot === 'clouds' || x.slot === 'radars') expect(Boolean(x.hidden)).toBe(f > 0 && selected(s).has(x.slot));
                    else expect(x.hidden).toBeUndefined();
                }
                syncAt(stack, s, sess, fr);
                assertBuffers(map, s, sess, fr);
                const main = [...new Set(map.layers.map((l) => l.id).filter((id) => id.startsWith(ID_PREFIX)).map((id) => id.replace(/-b$/, '')))];
                expect(main).toEqual(SLOT_ORDER.filter((slot) => selected(s).has(slot)).map(layerId));
                for (const slot of ['clouds', 'radars'] as const) {
                    if (!selected(s).has(slot)) continue;
                    const drawn = BUFS.some((b) => map.isDrawn(bufferLayerId(slot, b)) && map.getLayer(bufferLayerId(slot, b))?.paint?.['raster-opacity'] !== HIDDEN_OPACITY);
                    expect(drawn).toBe(f <= 0);
                }
                checked++;
            }
            expect(map.counters.moveLayer).toBe(0);
        }
        expect(checked).toBeGreaterThan(100);
    });

    it('Play through the forecast: Clouds and Radar are layout-hidden with no buffer, then return in place at the wrap', () => {
        const { map, stack, s, sess } = freshBuf();
        s.clouds = true;
        s.radars = true;
        s.precipRegional = true;
        const order = ['taknz-wx-clouds', 'taknz-wx-precip', 'taknz-wx-radars'];
        const mains = (): string[] => map.layers.map((l) => l.id).filter((id) => id.startsWith(ID_PREFIX) && !id.endsWith('-b'));
        for (let f = -12; f <= 23; f++) {
            const fr: Frames = { f, pre: f + 1 };
            syncAt(stack, s, sess, fr);
            assertBuffers(map, s, sess, fr);
            expect(mains()).toEqual(order);
            // not drawn in any forecast frame, drawn again up to Now
            for (const id of ['taknz-wx-clouds', 'taknz-wx-radars']) expect(map.isDrawn(id)).toBe(f <= 0);
            // the frame and the next one are both forecast frames: no buffer, nothing to load
            if (f > 0) {
                expect(map.getLayer('taknz-wx-clouds-b')).toBeUndefined();
                expect(map.getLayer('taknz-wx-radars-b')).toBeUndefined();
            }
        }
        expect(map.counters.moveLayer).toBe(0);

        // at +24 the next frame is -12: Clouds and Radar preload it (drawn at opacity 0)
        const last: Frames = { f: 24, pre: -12 };
        syncAt(stack, s, sess, last);
        assertBuffers(map, s, sess, last);
        for (const id of ['taknz-wx-clouds', 'taknz-wx-radars']) {
            expect(map.isDrawn(id)).toBe(false);
            expect(map.isDrawn(`${id}-b`)).toBe(true);
            expect(map.getLayer(`${id}-b`)?.paint?.['raster-opacity']).toBe(HIDDEN_OPACITY);
        }

        // the wrap: they return on the preloaded buffer, no new layer, no move, same order
        map.resetCounters();
        const wrap: Frames = { f: -12, pre: -11 };
        syncAt(stack, s, sess, wrap);
        assertBuffers(map, s, sess, wrap);
        expect(map.counters.addLayer).toBe(0);
        expect(map.counters.moveLayer).toBe(0);
        expect(mains()).toEqual(order);
        for (const id of ['taknz-wx-clouds', 'taknz-wx-radars']) expect(map.isDrawn(id) || map.isDrawn(`${id}-b`)).toBe(true);
    });
});

describe('Case I: removing the hidden buffer waits for a swap to settle', () => {
    function swapped(): ReturnType<typeof freshBuf> {
        const f = freshBuf();
        f.s.precipRegional = true;
        f.fr.pre = -7;
        syncAt(f.stack, f.s, f.sess, f.fr);
        f.fr.f = -7;
        f.fr.pre = -6;
        syncRaw(f.stack, f.s, f.sess, f.fr);
        return f;
    }

    it('stopping right after a swap keeps the buffer until enough renders have passed, then removes it', () => {
        const { map, stack, s, sess, fr } = swapped();
        fr.pre = null;
        map.resetCounters();
        stack.sync(desiredAt(s, sess, fr));
        expect(map.counters.removeLayer).toBe(0);
        expect(map.getLayer('taknz-wx-precip')).toBeDefined();
        expect(map.getLayer('taknz-wx-precip-b')).toBeDefined();
        expect(stack.preloadReady(-6)).toBe(false);
        for (let i = 0; i < SETTLE_RENDERS - 1; i++) stack.noteMapEvent('render');
        expect(map.counters.removeLayer).toBe(0);
        stack.noteMapEvent('render');
        expect(map.counters).toMatchObject({ removeLayer: 1, removeSource: 1, moveLayer: 0 });
        assertBuffers(map, s, sess, fr);
        // and it stays gone
        stack.noteMapEvent('render');
        expect(map.counters.removeLayer).toBe(1);
    });

    it('a later sync removes it as well once enough renders have passed', () => {
        const { map, stack, s, sess, fr } = swapped();
        fr.pre = null;
        stack.sync(desiredAt(s, sess, fr));
        for (let i = 0; i < SETTLE_RENDERS; i++) stack.noteMapEvent('render');
        expect(map.getLayer('taknz-wx-precip')).toBeUndefined();
    });

    it('a new preload during the wait reuses the buffer and cancels the removal', () => {
        const { map, stack, s, sess, fr } = swapped();
        fr.pre = null;
        stack.sync(desiredAt(s, sess, fr));
        fr.pre = -5;
        map.resetCounters();
        stack.sync(desiredAt(s, sess, fr));
        expect(map.counters).toMatchObject({ addLayer: 0, removeLayer: 0, setTiles: 1 });
        settle(stack);
        assertBuffers(map, s, sess, fr);
        expect(map.getLayer('taknz-wx-precip')).toBeDefined();
    });

    it('a stop without a recent swap removes the buffer at once', () => {
        const { map, stack, s, sess, fr } = freshBuf();
        s.precipRegional = true;
        fr.pre = -7;
        syncAt(stack, s, sess, fr);
        fr.pre = null;
        map.resetCounters();
        stack.sync(desiredAt(s, sess, fr));
        expect(map.counters).toMatchObject({ removeLayer: 1, removeSource: 1 });
    });

    it('removeAll and a slot switched off do not wait', () => {
        const { map, stack, s, sess, fr } = swapped();
        s.precipRegional = false;
        stack.sync(desiredAt(s, sess, fr));
        expect(map.layers.some((l) => l.id.startsWith('taknz-wx-'))).toBe(false);
        const g = swapped();
        g.fr.pre = null;
        g.stack.sync(desiredAt(g.s, g.sess, g.fr));
        g.stack.removeAll();
        expect(g.map.layers.map((l) => l.id)).toEqual(FOREIGN);
        expect([...g.map.sources.keys()].filter((k) => k.startsWith('taknz-wx-'))).toEqual([]);
    });
});

describe('Case I: foreign interference with buffer pairs', () => {
    function allPaired(): ReturnType<typeof freshBuf> {
        const f = freshBuf();
        for (const ev of MEMBERS) apply(f.s, ev);
        f.fr.pre = f.fr.f + 1;
        syncAt(f.stack, f.s, f.sess, f.fr);
        return f;
    }

    it('is a no-op when the pairs are in place', () => {
        const f = allPaired();
        f.map.resetCounters();
        expect(f.stack.ensureOrder()).toBe(false);
        expect(f.map.counters.moveLayer).toBe(0);
    });

    it('repairs moved pairs to the flattened order, below the anchor, with a below b', () => {
        const f = allPaired();
        f.map.moveForeign('taknz-wx-radars-b');
        f.map.moveForeign('taknz-wx-clouds');
        f.map.moveForeign('taknz-wx-precip-b');
        expect(f.stack.ensureOrder()).toBe(true);
        assertBuffers(f.map, f.s, f.sess, f.fr);
        f.map.resetCounters();
        expect(f.stack.ensureOrder()).toBe(false);
        expect(f.map.counters.moveLayer).toBe(0);
    });

    it('repairs a foreign layer inserted between the pairs and the anchor', () => {
        const f = allPaired();
        f.map.addForeign({ id: 'intruder', type: 'raster', source: 'intr' }, 'mf-polygons');
        f.stack.ensureOrder();
        assertBuffers(f.map, f.s, f.sess, f.fr, [...FOREIGN.slice(0, 3), 'intruder', ...FOREIGN.slice(3)]);
    });

    it('Map Features removed and re-added at the top keep the pairs below them', () => {
        const f = allPaired();
        f.map.removeForeign('mf-polygons');
        f.map.removeForeign('mf-lines');
        f.map.addForeign({ id: 'mf-polygons', type: 'fill', source: '-1' });
        f.map.addForeign({ id: 'mf-lines', type: 'line', source: '-1' });
        f.stack.ensureOrder();
        assertBuffers(f.map, f.s, f.sess, f.fr, ['background', 'basemap', 'overlay-7', 'labels', 'mf-polygons', 'mf-lines']);
        f.map.resetCounters();
        expect(f.stack.ensureOrder()).toBe(false);
    });
});

describe('Case I: map loss and failures with buffers', () => {
    it('removeAll tolerates a map that lost its layers, pairs included, and leaves nothing behind', () => {
        const { map, stack, s, sess, fr } = freshBuf();
        for (const ev of MEMBERS) apply(s, ev);
        fr.pre = -7;
        syncAt(stack, s, sess, fr);
        map.dropPrefixed(ID_PREFIX);
        expect(() => stack.removeAll()).not.toThrow();
        expect(stack.stackIds()).toEqual([]);
        expect(() => stack.removeAll()).not.toThrow();
    });

    it('removeAll removes both buffers and every source', () => {
        const { map, stack, s, sess, fr } = freshBuf();
        for (const ev of MEMBERS) apply(s, ev);
        fr.pre = -7;
        syncAt(stack, s, sess, fr);
        stack.removeAll();
        expect(map.layers.map((l) => l.id)).toEqual(FOREIGN);
        expect([...map.sources.keys()].filter((k) => k.startsWith(ID_PREFIX))).toEqual([]);
    });

    it('a hidden buffer that vanished from the map is created again', () => {
        const { map, stack, s, sess, fr } = freshBuf();
        s.precipRegional = true;
        fr.pre = -7;
        syncAt(stack, s, sess, fr);
        map.removeLayer('taknz-wx-precip-b');
        map.removeSource('taknz-wx-precip-b-src');
        syncAt(stack, s, sess, fr);
        assertBuffers(map, s, sess, fr);
    });

    it('sync after the map lost everything re-adds the visible buffer and the preload', () => {
        const { map, stack, s, sess, fr } = freshBuf();
        for (const ev of MEMBERS) apply(s, ev);
        fr.pre = -7;
        syncAt(stack, s, sess, fr);
        map.dropPrefixed(ID_PREFIX);
        syncAt(stack, s, sess, fr);
        assertBuffers(map, s, sess, fr);
    });

    it('a failing hidden buffer is given up: the shown frame stays and the next sync tries again', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const { map, stack, s, sess, fr } = freshBuf();
        s.precipRegional = true;
        syncAt(stack, s, sess, fr);
        const add = map.addLayer.bind(map);
        let fail = true;
        map.addLayer = (spec, before) => {
            if (fail && spec.id.endsWith('-b')) throw new Error('boom');
            add(spec, before);
        };
        fr.pre = -7;
        expect(() => syncAt(stack, s, sess, fr)).not.toThrow();
        expect(map.getLayer('taknz-wx-precip')).toBeDefined();
        expect(map.getLayer('taknz-wx-precip-b')).toBeUndefined();
        expect(map.getSource('taknz-wx-precip-b-src')).toBeUndefined();
        expect(stack.preloadReady(-7)).toBe(false);
        fail = false;
        syncAt(stack, s, sess, fr);
        assertBuffers(map, s, sess, fr);
        expect(warn).toHaveBeenCalledTimes(1);
        warn.mockRestore();
    });

    it('a failing swap re-creates the slot at the wanted frame', () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        const { map, stack, s, sess, fr } = freshBuf();
        s.precipRegional = true;
        fr.pre = -7;
        syncAt(stack, s, sess, fr);
        const paint = map.setPaintProperty.bind(map);
        map.setPaintProperty = () => {
            map.setPaintProperty = paint;
            throw new Error('boom');
        };
        fr.f = -7;
        fr.pre = -6;
        expect(() => syncAt(stack, s, sess, fr)).not.toThrow();
        assertBuffers(map, s, sess, fr);
        warn.mockRestore();
    });
});

describe('preloadReady and noteMapEvent', () => {
    function setup(): ReturnType<typeof freshBuf> {
        const f = freshBuf();
        f.map.controlLoading();
        f.s.precipRegional = true;
        f.s.clouds = true;
        return f;
    }

    it('is false without a preload or without a layer', () => {
        const { stack, s, sess, fr } = setup();
        expect(stack.preloadReady(-7)).toBe(false);
        syncRaw(stack, s, sess, fr);
        expect(stack.preloadReady(-7)).toBe(false);
        stack.removeAll();
        expect(stack.preloadReady(-7)).toBe(false);
    });

    it('needs the matching key, a source event and a loaded source in every slot', () => {
        const { map, stack, s, sess, fr } = setup();
        fr.pre = -7;
        syncRaw(stack, s, sess, fr);
        map.loadedIds.add('taknz-wx-precip-b-src');
        map.loadedIds.add('taknz-wx-clouds-b-src');
        // loaded, but no event since the tiles changed: still the old answer
        expect(stack.preloadReady(-7)).toBe(false);
        stack.noteMapEvent('sourcedata', { sourceId: 'taknz-wx-precip-b-src' });
        expect(stack.preloadReady(-7)).toBe(false);
        stack.noteMapEvent('sourcedata', { sourceId: 'taknz-wx-clouds-b-src' });
        expect(stack.preloadReady(-7)).toBe(true);
        expect(stack.preloadReady(-6)).toBe(false);
        map.loadedIds.delete('taknz-wx-clouds-b-src');
        expect(stack.preloadReady(-7)).toBe(false);
    });

    it('a slot whose next frame is the shown frame needs nothing', () => {
        const { map, stack, s, sess } = setup();
        const fr: Frames = { f: 0, pre: 1 };
        syncRaw(stack, s, sess, fr);
        map.loadedIds.add('taknz-wx-precip-b-src');
        stack.noteMapEvent('sourcedata', { sourceId: 'taknz-wx-precip-b-src' });
        expect(stack.preloadReady(1)).toBe(true);
    });

    it('a new setTiles on the hidden buffer resets its readiness', () => {
        const { map, stack, s, sess, fr } = setup();
        s.clouds = false;
        fr.pre = -7;
        syncRaw(stack, s, sess, fr);
        map.loadedIds.add('taknz-wx-precip-b-src');
        stack.noteMapEvent('sourcedata', { sourceId: 'taknz-wx-precip-b-src' });
        expect(stack.preloadReady(-7)).toBe(true);
        fr.pre = -6;
        syncRaw(stack, s, sess, fr);
        expect(stack.preloadReady(-6)).toBe(false);
        stack.noteMapEvent('render');
        stack.noteMapEvent('render');
        expect(stack.preloadReady(-6)).toBe(true);
    });

    it('after a swap the freed buffer takes the next frame and is not ready until it loads', () => {
        const { map, stack, s, sess, fr } = setup();
        s.clouds = false;
        fr.pre = -7;
        syncRaw(stack, s, sess, fr);
        map.loadedIds.add('taknz-wx-precip-b-src');
        stack.noteMapEvent('sourcedata', { sourceId: 'taknz-wx-precip-b-src' });
        fr.f = -7;
        fr.pre = -6;
        syncRaw(stack, s, sess, fr);
        // the hidden buffer is now `a`, freshly retargeted
        map.loadedIds.add('taknz-wx-precip-src');
        expect(stack.preloadReady(-6)).toBe(false);
        stack.noteMapEvent('sourcedata', { sourceId: 'taknz-wx-precip-src' });
        expect(stack.preloadReady(-6)).toBe(true);
    });
});

describe('sourcesLoaded covers both buffers', () => {
    it('is false while the hidden buffer still loads', () => {
        const { map, stack, s, sess, fr } = freshBuf();
        s.precipRegional = true;
        fr.pre = -7;
        syncAt(stack, s, sess, fr);
        map.controlLoading();
        map.loadedIds.add('taknz-wx-precip-src');
        expect(stack.sourcesLoaded()).toBe(false);
        map.loadedIds.add('taknz-wx-precip-b-src');
        expect(stack.sourcesLoaded()).toBe(true);
    });
});
