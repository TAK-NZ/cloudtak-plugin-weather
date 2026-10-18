import { describe, it, expect } from 'vitest';
import { tileRequest } from '../lib/tile-url.ts';
import type { PaletteCode } from '../lib/types.ts';

const S = 1768434600;
const qs = (q: [string, string][]): string => q.map(([k, v]) => `${k}=${v}`).join('&');
const keys = (q: [string, string][]): string[] => q.map(([k]) => k);

describe('tileRequest: precip and precip-global', () => {
    it.each(['precip', 'precip-global'] as const)('%s emits layer, color, forecast, snapshot in order', (layer) => {
        const r = tileRequest(layer, { color: '0', forecast: 0, snapshot: S, coverage: false });
        expect(r.layer).toBe(layer);
        expect(qs(r.query)).toBe(`layer=${layer}&color=0&forecast=0&snapshot=${S}`);
    });

    it('always emits forecast, including 0', () => {
        const r = tileRequest('precip', { color: '1', forecast: 0, snapshot: S, coverage: false });
        expect(keys(r.query)).toContain('forecast');
    });

    it('adds coverage=1 last when the mask is on', () => {
        const r = tileRequest('precip', { color: '9', forecast: 240, snapshot: S, coverage: true });
        expect(qs(r.query)).toBe(`layer=precip&color=9&forecast=240&snapshot=${S}&coverage=1`);
    });

    it('never emits use_precip_type', () => {
        const r = tileRequest('precip', { color: '0', forecast: 10, snapshot: S, coverage: true });
        expect(keys(r.query)).not.toContain('use_precip_type');
    });

    it('accepts every step 0..240', () => {
        for (let f = 0; f <= 240; f += 10) {
            expect(() => tileRequest('precip', { color: '0', forecast: f, snapshot: S, coverage: false })).not.toThrow();
        }
    });
});

describe('tileRequest: clouds', () => {
    it('emits only layer and snapshot', () => {
        const r = tileRequest('clouds', { snapshot: S });
        expect(r.query).toEqual([['layer', 'clouds'], ['snapshot', String(S)]]);
    });

    it('ignores extra options passed at runtime', () => {
        const opts = { snapshot: S, color: '3', forecast: 60, coverage: true, usePrecipType: true } as { snapshot: number };
        expect(keys(tileRequest('clouds', opts).query)).toEqual(['layer', 'snapshot']);
    });
});

describe('tileRequest: radars', () => {
    it('emits layer, color, snapshot and never forecast', () => {
        const r = tileRequest('radars', { color: '0', snapshot: S, coverage: false, usePrecipType: false });
        expect(qs(r.query)).toBe(`layer=radars&color=0&snapshot=${S}`);
    });

    it('adds coverage and use_precip_type only when on', () => {
        expect(qs(tileRequest('radars', { color: '2', snapshot: S, coverage: true, usePrecipType: false }).query))
            .toBe(`layer=radars&color=2&snapshot=${S}&coverage=1`);
        expect(qs(tileRequest('radars', { color: '2', snapshot: S, coverage: false, usePrecipType: true }).query))
            .toBe(`layer=radars&color=2&snapshot=${S}&use_precip_type=1`);
        expect(qs(tileRequest('radars', { color: '2', snapshot: S, coverage: true, usePrecipType: true }).query))
            .toBe(`layer=radars&color=2&snapshot=${S}&coverage=1&use_precip_type=1`);
    });

    it('never emits forecast even when passed at runtime', () => {
        const opts = { color: '0', snapshot: S, coverage: false, usePrecipType: false, forecast: 60 } as {
            color: PaletteCode; snapshot: number; coverage: boolean; usePrecipType: boolean;
        };
        expect(keys(tileRequest('radars', opts).query)).not.toContain('forecast');
    });
});

describe('tileRequest: forbidden parameters', () => {
    it('never emits api, key, provider, size or token', () => {
        const all = [
            tileRequest('precip', { color: '0', forecast: 60, snapshot: S, coverage: true }),
            tileRequest('precip-global', { color: '0', forecast: 60, snapshot: S, coverage: true }),
            tileRequest('clouds', { snapshot: S }),
            tileRequest('radars', { color: '0', snapshot: S, coverage: true, usePrecipType: true }),
        ];
        for (const r of all) {
            for (const bad of ['api', 'key', 'provider', 'size', 'token']) {
                expect(keys(r.query)).not.toContain(bad);
            }
        }
    });
});

describe('tileRequest: guards', () => {
    const base = { color: '0' as PaletteCode, forecast: 0, snapshot: S, coverage: false };

    it.each([-10, 5, 15, 250, 241, 1.5, NaN, Infinity])('rejects forecast %s', (forecast) => {
        expect(() => tileRequest('precip', { ...base, forecast })).toThrow(RangeError);
    });

    it('rejects an unknown palette for every layer that has one', () => {
        const bad = '10' as PaletteCode;
        expect(() => tileRequest('precip', { ...base, color: bad })).toThrow(RangeError);
        expect(() => tileRequest('precip-global', { ...base, color: bad })).toThrow(RangeError);
        expect(() => tileRequest('radars', { color: bad, snapshot: S, coverage: false, usePrecipType: false })).toThrow(RangeError);
    });

    it.each([0, -600, S + 1, 1.5, NaN])('rejects snapshot %s', (snapshot) => {
        expect(() => tileRequest('clouds', { snapshot })).toThrow(RangeError);
        expect(() => tileRequest('precip', { ...base, snapshot })).toThrow(RangeError);
    });
});
