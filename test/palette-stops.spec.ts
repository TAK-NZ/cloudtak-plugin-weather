import { describe, it, expect } from 'vitest';
import { PALETTE_NAMES, RAIN_STOPS, SNOW_STOPS, gradientCss } from '../lib/palette-stops.ts';
import { PALETTES } from '../lib/constants.ts';
describe('palette stops', () => {
    it('names palettes 0 to 9 in the dropdown order', () => {
        expect(PALETTES.map((c) => PALETTE_NAMES[c])).toEqual(['Rainbow', 'TWC', 'Dark Sky', 'Meteored', 'Nexrad', 'Rainviewer', 'Selex', 'Titan', 'Universal Blue', 'TWC RV']);
    });
    it('has rain and snow stops for every palette, as plain hex colours, at least 4 each', () => {
        for (const code of PALETTES) {
            for (const set of [RAIN_STOPS[code], SNOW_STOPS[code]]) {
                expect(set.length).toBeGreaterThanOrEqual(4);
                expect(set.length).toBeLessThanOrEqual(16);
                for (const colour of set) expect(colour).toMatch(/^#[0-9a-f]{6}$/);
            }
        }
        expect(Object.keys(RAIN_STOPS)).toEqual([...PALETTES]);
        expect(Object.keys(SNOW_STOPS)).toEqual([...PALETTES]);
    });
    it('shares the Snow stops of identical strips', () => {
        expect(SNOW_STOPS['6']).toBe(SNOW_STOPS['2']);
        expect(SNOW_STOPS['9']).toBe(SNOW_STOPS['2']);
        expect(SNOW_STOPS['8']).toBe(SNOW_STOPS['7']);
        expect(SNOW_STOPS['7']).not.toBe(SNOW_STOPS['2']);
    });
    it('builds a left to right CSS gradient', () => {
        expect(gradientCss(['#000000', '#ffffff'])).toBe('linear-gradient(to right, #000000, #ffffff)');
    });
});
