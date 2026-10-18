import { afterEach, describe, expect, it } from 'vitest';
import { FALLBACK_TILES, FramePacer, SEEN_MS, TokenBucket, estimateTiles, pacing } from '../lib/pacing.ts';
import { requestFor } from '../lib/layers.ts';
import { defaultSettings } from '../lib/state.ts';

const MIN = 60_000;

afterEach(() => {
    Object.assign(pacing, { enabled: true, ratePerMin: 180, burst: 90 });
});

function clock(start = 1_000_000): { now: () => number; advance: (ms: number) => void } {
    let t = start;
    return { now: () => t, advance: (ms) => { t += ms; } };
}

describe('pacing defaults', () => {
    it('is on, 180 tiles a minute with a burst of 90', () => {
        expect(pacing).toEqual({ enabled: true, ratePerMin: 180, burst: 90 });
    });
});

describe('TokenBucket', () => {
    const params = () => ({ ratePerMin: 180, burst: 90 });

    it('starts full and pays for a cost up to the burst at once', () => {
        const c = clock();
        const b = new TokenBucket(c.now, params);
        expect(b.delayMs(90)).toBe(0);
        b.take(90);
        expect(b.delayMs(1)).toBeGreaterThan(0);
    });

    it('refills 3 tokens a second', () => {
        const c = clock();
        const b = new TokenBucket(c.now, params);
        b.take(90);
        expect(b.delayMs(60)).toBe(20_000);
        c.advance(10_000);
        expect(b.delayMs(60)).toBe(10_000);
        c.advance(10_000);
        expect(b.delayMs(60)).toBe(0);
    });

    it('never holds more than the burst', () => {
        const c = clock();
        const b = new TokenBucket(c.now, params);
        c.advance(10 * MIN);
        b.take(90);
        expect(b.delayMs(1)).toBeGreaterThan(0);
    });

    it('grows the capacity to a cost larger than the burst', () => {
        const c = clock();
        const b = new TokenBucket(c.now, params);
        b.take(90);
        // 120 > burst: it waits for 120 tokens, which a capacity of 90 could never hold
        expect(b.delayMs(120)).toBe(40_000);
        c.advance(40_000);
        expect(b.delayMs(120)).toBe(0);
        b.take(120);
        expect(b.delayMs(120)).toBe(40_000);
    });

    it('allows a debt and pays it off first', () => {
        const c = clock();
        const b = new TokenBucket(c.now, params);
        b.take(150);
        // -60 tokens: 60 for the debt and 30 for the cost
        expect(b.delayMs(30)).toBe(30_000);
    });

    it('follows a changed rate', () => {
        const c = clock();
        const p = { ratePerMin: 180, burst: 90 };
        const b = new TokenBucket(c.now, () => p);
        b.take(90);
        p.ratePerMin = 360;
        expect(b.delayMs(60)).toBe(10_000);
    });

    it('costs nothing to ask for nothing', () => {
        const b = new TokenBucket(clock().now, params);
        expect(b.delayMs(0)).toBe(0);
        b.take(0);
        expect(b.delayMs(90)).toBe(0);
    });
});

describe('estimateTiles', () => {
    it('is 20 at 1900 x 1400 with 512 px tiles', () => {
        expect(estimateTiles(1900, 1400, 512)).toBe(20);
    });

    it('is about four times as many at 256 px', () => {
        expect(estimateTiles(1900, 1400, 256)).toBe(63);
    });

    it('counts the partly covered edge tiles', () => {
        expect(estimateTiles(390, 844, 512)).toBe(2 * 3);
        expect(estimateTiles(512, 512, 512)).toBe(4);
    });

    it('falls back for an unknown size', () => {
        expect(estimateTiles(0, 0, 512)).toBe(FALLBACK_TILES);
        expect(estimateTiles(Number.NaN, 500, 512)).toBe(FALLBACK_TILES);
        expect(FALLBACK_TILES).toBe(20);
    });
});

describe('FramePacer', () => {
    /** Keys per frame: `layers` slots in the past, only `rain` for k > 0. */
    function pacer(c: ReturnType<typeof clock>, layers = 3, tiles = 20) {
        return new FramePacer({
            keysOf: (k) => {
                const keys = [`rain:${k}`];
                if (k <= 0) for (let i = 1; i < layers; i++) keys.push(`l${i}:${k}`);
                return keys;
            },
            tilesPerSlot: () => tiles,
            now: c.now,
        });
    }

    it('costs the unseen keys times the tiles per slot', () => {
        const c = clock();
        const p = pacer(c);
        p.charge(-12);
        p.charge(-11);
        // 90 - 60 - 60 = -30
        expect(p.delayMs(-10)).toBe(30_000);
    });

    it('lets the first frame through and then waits at 3 tokens a second', () => {
        const c = clock();
        const p = pacer(c);
        expect(p.delayMs(-12)).toBe(0);
        p.charge(-12);
        // 30 tokens left, the next frame costs 60
        expect(p.delayMs(-11)).toBe(10_000);
        c.advance(10_000);
        expect(p.delayMs(-11)).toBe(0);
    });

    it('a second pass costs nothing', () => {
        const c = clock();
        const p = pacer(c);
        for (let k = -12; k <= 0; k++) p.charge(k);
        expect(p.delayMs(1)).toBeGreaterThan(0);
        // the keys are seen, so the second pass is free although the bucket is in debt
        for (let k = -12; k <= 0; k++) expect(p.delayMs(k)).toBe(0);
    });

    it('charging a frame twice costs it once', () => {
        const c = clock();
        const p = pacer(c);
        p.charge(-12);
        p.charge(-12);
        expect(p.delayMs(-11)).toBe(10_000);
    });

    it('forgets a key after 50 minutes', () => {
        const c = clock();
        const p = pacer(c);
        p.charge(-12);
        c.advance(SEEN_MS - 1);
        expect(p.delayMs(-12)).toBe(0);
        c.advance(1);
        // the bucket is full again, and the key costs tokens again
        p.charge(-12);
        expect(p.delayMs(-12)).toBe(0);
        p.charge(-11);
        expect(p.delayMs(-10)).toBeGreaterThan(0);
    });

    it('forecast frames cost the Rain layer only', () => {
        const c = clock();
        const p = pacer(c);
        // empty the bucket
        p.charge(-12);
        p.charge(-11);
        const wait = p.delayMs(1);
        // rain only: 20 tokens, not 60
        expect(wait).toBe(16_667);
    });

    it('a frame with no requests costs nothing', () => {
        const c = clock();
        const p = new FramePacer({ keysOf: () => [], tilesPerSlot: () => 20, now: c.now });
        p.charge(3);
        expect(p.delayMs(3)).toBe(0);
        expect(p.delayMs(4)).toBe(0);
    });

    it('uses the tiles per slot at the time of the call', () => {
        const c = clock();
        let tiles = 20;
        const p = new FramePacer({ keysOf: (k) => [`a${k}`], tilesPerSlot: () => tiles, now: c.now });
        expect(p.delayMs(1)).toBe(0);
        tiles = 120;
        expect(p.delayMs(1)).toBe(10_000);
    });
});

describe('requests of a frame as pacing keys', () => {
    it('hidden Clouds and Radar have no request in forecast frames, Rain has one', () => {
        const s = defaultSettings();
        s.clouds = true;
        s.radars = true;
        s.precipRegional = true;
        const session = { frame: 0, snapshot: 1_700_000_000 };
        const slots = ['clouds', 'precip-global', 'precip', 'radars'] as const;
        const at = (k: number) => slots.filter((slot) => requestFor(slot, s, session, k) !== null);
        expect(at(-3)).toEqual(['clouds', 'precip', 'radars']);
        expect(at(0)).toEqual(['clouds', 'precip', 'radars']);
        expect(at(5)).toEqual(['precip']);
    });
});
