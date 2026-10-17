import { describe, it, expect } from 'vitest';
import {
    SLOT_ORDER, layerId, sourceId, markerAnchor, planBeforeId, requestsFor, computeDesired, LayerStack,
    type DesiredLayer, type RasterLayerSpec, type RasterSourceSpec,
} from '../lib/layers.ts';
import { buildTileTemplate } from '../lib/relay-client.ts';
import { defaultSettings } from '../lib/state.ts';
import { ATTRIBUTION, ID_PREFIX } from '../lib/constants.ts';
import type { LayerSlot, WeatherSettings } from '../lib/types.ts';
import { FakeMap } from './fake-map.ts';

const SNAP = 1768434600;
const ORIGIN = 'https://cot.test';

interface Sess {
    frame: number;
    snapshot: number;
}

type Ev = 'clouds' | 'radars' | 'none' | 'regional' | 'global';

function permutations<T>(items: T[]): T[][] {
    if (items.length <= 1) return [items.slice()];
    const out: T[][] = [];
    items.forEach((item, i) => {
        const rest = [...items.slice(0, i), ...items.slice(i + 1)];
        for (const p of permutations(rest)) out.push([item, ...p]);
    });
    return out;
}

function apply(s: WeatherSettings, ev: Ev): void {
    if (ev === 'clouds') s.clouds = !s.clouds;
    else if (ev === 'radars') s.radars = !s.radars;
    else if (ev === 'none') s.precip = 'none';
    else if (ev === 'regional') s.precip = 'precip';
    else s.precip = 'precip-global';
}

function selected(s: WeatherSettings): Set<LayerSlot> {
    const out = new Set<LayerSlot>();
    if (s.clouds) out.add('clouds');
    if (s.precip !== 'none') out.add('precip');
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

    // I2: clouds < precip < radars
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

const MEMBERS: Ev[] = ['clouds', 'regional', 'radars'];

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
    it('planBeforeId returns the insertion table for all slot/present combinations', () => {
        const A = 'anchor';
        const set = (...s: LayerSlot[]): Set<LayerSlot> => new Set(s);
        const c = layerId('clouds'), p = layerId('precip'), r = layerId('radars');

        expect(planBeforeId('clouds', set(), A)).toBe(A);
        expect(planBeforeId('clouds', set('precip'), A)).toBe(p);
        expect(planBeforeId('clouds', set('radars'), A)).toBe(r);
        expect(planBeforeId('clouds', set('precip', 'radars'), A)).toBe(p);

        expect(planBeforeId('precip', set(), A)).toBe(A);
        expect(planBeforeId('precip', set('clouds'), A)).toBe(A);
        expect(planBeforeId('precip', set('radars'), A)).toBe(r);
        expect(planBeforeId('precip', set('clouds', 'radars'), A)).toBe(r);

        for (const present of [set(), set('clouds'), set('precip'), set('clouds', 'precip')]) {
            expect(planBeforeId('radars', present, A)).toBe(A);
        }

        expect(planBeforeId('radars', set(), undefined)).toBeUndefined();
        expect(c).toBe('taknz-wx-clouds');
    });
});

describe('requestsFor and computeDesired', () => {
    it('returns one entry per slot, bottom to top', () => {
        const d = desired(defaultSettings(), { frame: 0, snapshot: SNAP });
        expect(d.map((x) => x.slot)).toEqual(['clouds', 'precip', 'radars']);
        expect(d.every((x) => !x.on)).toBe(true);
    });

    it('only the rain request carries the forecast frame', () => {
        const s = defaultSettings();
        s.clouds = true;
        s.radars = true;
        s.precip = 'precip';
        const r = requestsFor(s, { frame: 12, snapshot: SNAP });
        expect(r.precip?.query).toContainEqual(['forecast', '120']);
        expect(r.clouds?.query.map(([k]) => k)).toEqual(['layer', 'snapshot']);
        expect(r.radars?.query.map(([k]) => k)).not.toContain('forecast');
    });

    it('sets maxzoom, tileSize and opacity per slot', () => {
        const s = defaultSettings();
        s.clouds = true;
        s.radars = true;
        s.precip = 'precip-global';
        s.tileSize = 256;
        const d = desired(s, { frame: 0, snapshot: SNAP });
        expect(d.map((x) => x.maxzoom)).toEqual([7, 9, 7]);
        expect(d.map((x) => x.tileSize)).toEqual([256, 256, 256]);
        expect(d.map((x) => x.opacity)).toEqual([0.5, 0.7, 0.7]);
    });

    it('treats a selected slot without a tile URL as off', () => {
        const s = defaultSettings();
        s.clouds = true;
        const d = computeDesired(s, { frame: 0, snapshot: SNAP }, {});
        expect(d[0].on).toBe(false);
    });
});

describe('LayerStack: source and layer specs', () => {
    it('creates raster sources and layers with the documented options', () => {
        const { map, stack, s, sess } = fresh();
        s.precip = 'precip-global';
        s.clouds = true;
        sync(stack, s, sess);

        const src = map.getSource(sourceId('precip'))?.spec as RasterSourceSpec;
        expect(src).toMatchObject({ type: 'raster', tileSize: 512, minzoom: 0, maxzoom: 9, attribution: ATTRIBUTION });
        expect((map.getSource(sourceId('clouds'))?.spec as RasterSourceSpec).maxzoom).toBe(7);

        const layer = map.getLayer(layerId('precip')) as unknown as RasterLayerSpec;
        expect(layer.type).toBe('raster');
        expect(layer.paint).toEqual({ 'raster-opacity': 0.7, 'raster-fade-duration': 0, 'raster-resampling': 'linear' });
    });
});

describe('Case A: enable-order matrices', () => {
    it('all 8 subsets in every permutation of enabling (16 sequences)', () => {
        let sequences = 0;
        for (let mask = 0; mask < 8; mask++) {
            const members = MEMBERS.filter((_, i) => mask & (1 << i));
            for (const order of permutations(members)) {
                const { map, stack, s, sess } = fresh();
                for (const ev of order) {
                    apply(s, ev);
                    sync(stack, s, sess);
                    assertInvariants(map, s, sess);
                }
                expect(map.counters.moveLayer).toBe(0);
                sequences++;
            }
        }
        expect(sequences).toBe(16);
    });

    it('27 sequences over the 12 precip variants', () => {
        let sequences = 0;
        let states = 0;
        for (const precip of ['none', 'regional', 'global'] as const) {
            for (const clouds of [false, true]) {
                for (const radars of [false, true]) {
                    states++;
                    const members: Ev[] = [];
                    if (clouds) members.push('clouds');
                    if (precip !== 'none') members.push(precip);
                    if (radars) members.push('radars');

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
            }
        }
        expect(states).toBe(12);
        expect(sequences).toBe(27);
    });

    it('from all-three-on, disabling in every one of the 6 orders', () => {
        for (const order of permutations<Ev>(['clouds', 'regional', 'radars'])) {
            const { map, stack, s, sess } = fresh();
            for (const ev of MEMBERS) apply(s, ev);
            sync(stack, s, sess);
            assertInvariants(map, s, sess);

            for (const ev of order) {
                apply(s, ev === 'regional' ? 'none' : ev);
                sync(stack, s, sess);
                assertInvariants(map, s, sess);
            }
            expect(map.layers.some((l) => l.id.startsWith(ID_PREFIX))).toBe(false);
            expect(map.counters.moveLayer).toBe(0);
        }
    });

    it('from all-three-on, every removal followed by re-adding in every order', () => {
        let cases = 0;
        for (let mask = 1; mask < 8; mask++) {
            const removed = MEMBERS.filter((_, i) => mask & (1 << i));
            for (const readd of permutations(removed)) {
                const { map, stack, s, sess } = fresh();
                for (const ev of MEMBERS) apply(s, ev);
                sync(stack, s, sess);

                for (const ev of removed) {
                    apply(s, ev === 'regional' ? 'none' : ev);
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
        expect(cases).toBe(3 * 1 + 3 * 2 + 1 * 6);
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

describe('Case B: exhaustive event sequences of length 1..5', () => {
    it('keeps invariants I1-I6 and never calls moveLayer (3905 sequences)', () => {
        const events: Ev[] = ['clouds', 'radars', 'none', 'regional', 'global'];
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
        expect(total).toBe(3905);
    });
});

describe('Case C: rain variant switch', () => {
    it('regional <-> global with clouds and radar on is one setTiles and no add/remove', () => {
        const { map, stack, s, sess } = fresh();
        s.clouds = true;
        s.radars = true;
        s.precip = 'precip';
        sync(stack, s, sess);
        const before = map.getStyle().layers.map((l) => l.id);
        map.resetCounters();

        s.precip = 'precip-global';
        sync(stack, s, sess);
        assertInvariants(map, s, sess);
        expect(map.counters).toEqual({ addSource: 0, addLayer: 0, removeLayer: 0, removeSource: 0, moveLayer: 0, setTiles: 1, setPaintProperty: 0 });
        expect(map.getStyle().layers.map((l) => l.id)).toEqual(before);
        expect(map.getSource(sourceId('precip'))?.tiles[0]).toContain('layer=precip-global');

        s.precip = 'precip';
        sync(stack, s, sess);
        expect(map.counters.setTiles).toBe(2);
        expect(map.counters.addLayer).toBe(0);
        expect(map.counters.removeLayer).toBe(0);
    });

    it('a forecast slider commit is exactly one setTiles, on the rain source', () => {
        const { map, stack, s, sess } = fresh();
        s.clouds = true;
        s.radars = true;
        s.precip = 'precip';
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
        expect(map.counters.setTiles).toBe(3);
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
        expect(ids.slice(-4)).toEqual([layerId('clouds'), layerId('precip'), layerId('radars'), 'labels']);
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
        expect(map.counters.addLayer).toBe(3);
        expect(map.counters.removeLayer).toBe(3);
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
        expect(map.counters.addLayer).toBe(3);
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
