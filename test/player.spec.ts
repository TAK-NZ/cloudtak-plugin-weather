import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    FRAME_MS, HOLD_MS, MAX_SUSPEND_MS, MAX_WAIT_MS, Player, bindPlayer, playRange, stopPlay, togglePlay,
} from '../lib/player.ts';
import type { PlayerDeps } from '../lib/player.ts';
import { FramePacer } from '../lib/pacing.ts';

interface Rig {
    player: Player;
    shows: { frame: number; preload: number | null; at: number }[];
    states: { playing: boolean; resumeAt: number | null }[];
    deps: PlayerDeps;
    ready: Set<number>;
    /** Every key preloadReady() was asked about, with the frame shown at that moment. */
    asked: { key: number; frame: number }[];
    current: { frame: number; range: { first: number; last: number }; layers: boolean };
}

function rig(over: Partial<Rig['current']> = {}, pace?: PlayerDeps['pace']): Rig {
    const shows: Rig['shows'] = [];
    const states: Rig['states'] = [];
    const ready = new Set<number>();
    const asked: Rig['asked'] = [];
    const current = { frame: 0, range: { first: -12, last: 0 }, layers: true, ...over };
    const deps: PlayerDeps = {
        range: () => current.range,
        hasLayers: () => current.layers,
        frame: () => current.frame,
        show: (frame, preload) => {
            current.frame = frame;
            shows.push({ frame, preload, at: Date.now() });
        },
        preloadReady: (key) => {
            asked.push({ key, frame: current.frame });
            return ready.has(key);
        },
        now: () => Date.now(),
        setTimer: (fn, ms) => setTimeout(fn, ms),
        clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
        onState: (playing, resumeAt) => states.push({ playing, resumeAt }),
    };
    if (pace) deps.pace = pace;
    return { player: new Player(deps), shows, states, deps, ready, asked, current };
}

/** Every preload is ready at once. */
function allReady(r: Rig): void {
    for (let k = -12; k <= 24; k++) r.ready.add(k);
}

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
});
afterEach(() => {
    bindPlayer(null);
    vi.useRealTimers();
});

describe('playRange', () => {
    it('is the last two hours, and the forecast only with Rain and the option', () => {
        expect(playRange(false, false)).toEqual({ first: -12, last: 0 });
        expect(playRange(true, false)).toEqual({ first: -12, last: 0 });
        expect(playRange(false, true)).toEqual({ first: -12, last: 0 });
        expect(playRange(true, true)).toEqual({ first: -12, last: 24 });
    });
});

describe('Player: cadence', () => {
    it('runs -12..0 with 13 shows, 700 ms apart, from Now', () => {
        const r = rig();
        allReady(r);
        r.player.start();
        expect(r.shows).toHaveLength(1);
        expect(r.shows[0]).toMatchObject({ frame: -12, preload: -11 });
        vi.advanceTimersByTime(12 * FRAME_MS);
        expect(r.shows.map((s) => s.frame)).toEqual([-12, -11, -10, -9, -8, -7, -6, -5, -4, -3, -2, -1, 0]);
        const gaps = r.shows.slice(1).map((s, i) => s.at - r.shows[i].at);
        expect(gaps).toEqual(Array(12).fill(FRAME_MS));
    });

    it('preloads exactly one frame ahead, and the restart frame while holding on Now', () => {
        const r = rig();
        allReady(r);
        r.player.start();
        vi.advanceTimersByTime(12 * FRAME_MS);
        for (const s of r.shows.slice(0, 12)) expect(s.preload).toBe(s.frame + 1);
        expect(r.shows[12]).toMatchObject({ frame: 0, preload: -12 });
        expect(r.asked.every((a) => a.key >= -12 && a.key <= 0)).toBe(true);
    });

    it('holds 1200 ms on Now, then restarts at -12', () => {
        const r = rig();
        allReady(r);
        r.player.start();
        vi.advanceTimersByTime(12 * FRAME_MS);
        const atNow = r.shows[12].at;
        vi.advanceTimersByTime(HOLD_MS - 1);
        expect(r.shows).toHaveLength(13);
        vi.advanceTimersByTime(1);
        expect(r.shows).toHaveLength(14);
        expect(r.shows[13]).toMatchObject({ frame: -12, preload: -11, at: atNow + HOLD_MS });
        vi.advanceTimersByTime(FRAME_MS);
        expect(r.shows[14].frame).toBe(-11);
    });

    it('starts at the committed frame when it is inside the range, else at -12', () => {
        const a = rig({ frame: -5 });
        allReady(a);
        a.player.start();
        expect(a.shows[0].frame).toBe(-5);
        const b = rig({ frame: 0 });
        b.player.start();
        expect(b.shows[0].frame).toBe(-12);
        const c = rig({ frame: 7, range: { first: -12, last: 24 } });
        c.player.start();
        expect(c.shows[0].frame).toBe(7);
    });

    it('with the forecast option and Rain it runs to +24, then restarts', () => {
        const r = rig({ range: playRange(true, true) });
        allReady(r);
        r.player.start();
        vi.advanceTimersByTime(36 * FRAME_MS);
        expect(r.shows.map((s) => s.frame)).toEqual(Array.from({ length: 37 }, (_, i) => i - 12));
        expect(r.shows[36].preload).toBe(-12);
        vi.advanceTimersByTime(HOLD_MS);
        expect(r.shows[37].frame).toBe(-12);
    });

    it('reports playing once and does nothing on a second start', () => {
        const r = rig();
        r.player.start();
        r.player.start();
        expect(r.shows).toHaveLength(1);
        expect(r.states).toEqual([{ playing: true, resumeAt: null }]);
        expect(r.player.isPlaying).toBe(true);
    });
});

describe('Player: waiting for tiles', () => {
    it('waits for the next frame to be ready, polling, and advances as soon as it is', () => {
        const r = rig();
        r.player.start();
        vi.advanceTimersByTime(FRAME_MS);
        expect(r.shows).toHaveLength(1);
        vi.advanceTimersByTime(1500);
        expect(r.shows).toHaveLength(1);
        r.ready.add(-11);
        vi.advanceTimersByTime(100);
        expect(r.shows.map((s) => s.frame)).toEqual([-12, -11]);
        expect(r.shows[1].at - r.shows[0].at).toBe(FRAME_MS + 1500 + 100);
    });

    it('never waits longer than 3 s after a frame was shown, even if its tiles never load', () => {
        const r = rig();
        r.player.start();
        vi.advanceTimersByTime(MAX_WAIT_MS - 1);
        expect(r.shows).toHaveLength(1);
        vi.advanceTimersByTime(1);
        expect(r.shows).toHaveLength(2);
        expect(r.shows[1].at - r.shows[0].at).toBe(MAX_WAIT_MS);
    });

    it('asks only about the next frame, never further ahead', () => {
        const r = rig();
        r.player.start();
        vi.advanceTimersByTime(2 * MAX_WAIT_MS);
        expect(r.asked.length).toBeGreaterThan(0);
        expect(r.asked.every((a) => a.key === a.frame + 1)).toBe(true);
        expect(r.shows.every((s) => s.preload === s.frame + 1)).toBe(true);
    });

    it('loads the right frame when the range changes under it', () => {
        const r = rig({ frame: 0 });
        r.current.range = { first: -12, last: 0 };
        r.player.start();
        r.current.frame = 0;
        // a hold on Now: forecast switched on meanwhile
        vi.advanceTimersByTime(12 * MAX_WAIT_MS);
        const holdShow = r.shows.findIndex((s) => s.frame === 0);
        expect(holdShow).toBeGreaterThan(0);
        r.current.range = { first: -12, last: 24 };
        const before = r.shows.length;
        vi.advanceTimersByTime(HOLD_MS);
        expect(r.shows.slice(before - 1).some((s) => s.frame === 0 && s.preload === 1)).toBe(true);
    });

    it('restarts from -12 without errors when the range shrinks below the shown frame', () => {
        const r = rig({ range: { first: -12, last: 24 }, frame: 10 });
        allReady(r);
        r.player.start();
        expect(r.shows[0].frame).toBe(10);
        r.current.range = { first: -12, last: 0 };
        vi.advanceTimersByTime(FRAME_MS);
        expect(r.shows[1].frame).toBe(-12);
    });
});

describe('Player: stop and dispose', () => {
    it('stop clears every timer and keeps the shown frame', () => {
        const r = rig();
        allReady(r);
        r.player.start();
        vi.advanceTimersByTime(3 * FRAME_MS);
        expect(vi.getTimerCount()).toBe(1);
        r.player.stop('user');
        expect(vi.getTimerCount()).toBe(0);
        expect(r.states.at(-1)).toEqual({ playing: false, resumeAt: null });
        const n = r.shows.length;
        vi.advanceTimersByTime(10_000);
        expect(r.shows).toHaveLength(n);
        expect(r.current.frame).toBe(-9);
    });

    it('stop while waiting for tiles clears the poll timer', () => {
        const r = rig();
        r.player.start();
        vi.advanceTimersByTime(2000);
        r.player.stop('panel');
        expect(vi.getTimerCount()).toBe(0);
    });

    it('stop when nothing plays is harmless and reports nothing', () => {
        const r = rig();
        r.player.stop('user');
        expect(r.states).toEqual([]);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('start without a layer is a no-op', () => {
        const r = rig({ layers: false });
        r.player.start();
        expect(r.shows).toEqual([]);
        expect(r.states).toEqual([]);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('stops by itself when the last layer goes off', () => {
        const r = rig();
        allReady(r);
        r.player.start();
        r.current.layers = false;
        vi.advanceTimersByTime(FRAME_MS);
        expect(r.player.isPlaying).toBe(false);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('dispose stops for good: no timers, and start does nothing afterwards', () => {
        const r = rig();
        r.player.start();
        r.player.dispose();
        expect(vi.getTimerCount()).toBe(0);
        r.player.start();
        r.player.suspend(Date.now() + 1000);
        expect(vi.getTimerCount()).toBe(0);
        expect(r.shows).toHaveLength(1);
    });

    it('can be started again after a stop and begins at the committed frame', () => {
        const r = rig();
        allReady(r);
        r.player.start();
        vi.advanceTimersByTime(4 * FRAME_MS);
        r.player.stop('user');
        r.player.start();
        expect(r.shows.at(-1)?.frame).toBe(-8);
    });
});

describe('Player: suspend (rate limit)', () => {
    it('drops the preload, keeps playing in the state and resumes at the end of the suspension', () => {
        const r = rig();
        allReady(r);
        r.player.start();
        vi.advanceTimersByTime(2 * FRAME_MS);
        const until = Date.now() + 30_000;
        r.player.suspend(until);
        expect(r.shows.at(-1)).toMatchObject({ frame: -10, preload: null });
        expect(r.states.at(-1)).toEqual({ playing: true, resumeAt: until });
        expect(r.player.isSuspended).toBe(true);
        const n = r.shows.length;
        vi.advanceTimersByTime(29_999);
        expect(r.shows).toHaveLength(n);
        vi.advanceTimersByTime(1);
        expect(r.shows.at(-1)).toMatchObject({ frame: -10, preload: -9 });
        expect(r.states.at(-1)).toEqual({ playing: true, resumeAt: null });
        expect(r.player.isSuspended).toBe(false);
        vi.advanceTimersByTime(FRAME_MS);
        expect(r.shows.at(-1)?.frame).toBe(-9);
    });

    it('never suspends for longer than 60 s', () => {
        const r = rig();
        r.player.start();
        r.player.suspend(Date.now() + 10 * 60_000);
        expect(r.states.at(-1)?.resumeAt).toBe(Date.now() + MAX_SUSPEND_MS);
        const n = r.shows.length;
        vi.advanceTimersByTime(MAX_SUSPEND_MS);
        expect(r.shows.length).toBe(n + 1);
    });

    it('a manual start during the suspension resumes at once', () => {
        const r = rig();
        r.player.start();
        r.player.suspend(Date.now() + 30_000);
        const n = r.shows.length;
        r.player.start();
        expect(r.shows).toHaveLength(n + 1);
        expect(r.shows.at(-1)).toMatchObject({ frame: -12, preload: -11 });
        expect(r.player.isSuspended).toBe(false);
        expect(vi.getTimerCount()).toBe(1);
    });

    it('a second suspend while suspended changes nothing', () => {
        const r = rig();
        r.player.start();
        r.player.suspend(Date.now() + 20_000);
        const state = r.states.at(-1);
        vi.advanceTimersByTime(5000);
        r.player.suspend(Date.now() + 60_000);
        expect(r.states.at(-1)).toBe(state);
        vi.advanceTimersByTime(15_000);
        expect(r.player.isSuspended).toBe(false);
    });

    it('suspend does nothing when not playing; stop during a suspension clears the timer', () => {
        const r = rig();
        r.player.suspend(Date.now() + 1000);
        expect(vi.getTimerCount()).toBe(0);
        r.player.start();
        r.player.suspend(Date.now() + 1000);
        r.player.stop('user');
        expect(vi.getTimerCount()).toBe(0);
        expect(r.states.at(-1)).toEqual({ playing: false, resumeAt: null });
    });
});

describe('togglePlay and stopPlay', () => {
    it('do nothing while no player is bound', () => {
        expect(() => togglePlay()).not.toThrow();
        expect(() => stopPlay()).not.toThrow();
    });

    it('toggle starts, stops, and resumes a suspended player', () => {
        const r = rig();
        bindPlayer(r.player);
        togglePlay();
        expect(r.player.isPlaying).toBe(true);
        togglePlay();
        expect(r.player.isPlaying).toBe(false);
        togglePlay();
        r.player.suspend(Date.now() + 30_000);
        togglePlay();
        expect(r.player.isPlaying).toBe(true);
        expect(r.player.isSuspended).toBe(false);
        stopPlay();
        expect(r.player.isPlaying).toBe(false);
    });
});

/** A pacer that lets a frame start loading once `releaseAt` has passed. */
function fakePace(releaseAt: () => number) {
    const charges: { frame: number; at: number }[] = [];
    return {
        charges,
        pace: {
            delayMs: (): number => Math.max(0, releaseAt() - Date.now()),
            charge: (frame: number): void => {
                charges.push({ frame, at: Date.now() });
            },
        },
    };
}

describe('Player: pacing', () => {
    it('charges the first frame at start, then each preload as it begins', () => {
        const f = fakePace(() => 0);
        const r = rig({}, f.pace);
        allReady(r);
        r.player.start();
        vi.advanceTimersByTime(3 * FRAME_MS);
        expect(f.charges.map((c) => c.frame)).toEqual([-12, -11, -10, -9, -8]);
        const gaps = r.shows.slice(1).map((s, i) => s.at - r.shows[i].at);
        expect(gaps).toEqual(Array(3).fill(FRAME_MS));
    });

    it('does not start the preload until the pacer allows it, and keeps the shown frame', () => {
        const t0 = Date.now();
        const f = fakePace(() => t0 + 5000);
        const r = rig({}, f.pace);
        r.player.start();
        expect(r.shows).toEqual([{ frame: -12, preload: null, at: t0 }]);
        expect(f.charges.map((c) => c.frame)).toEqual([-12]);
        vi.advanceTimersByTime(4999);
        expect(r.shows).toHaveLength(1);
        expect(r.current.frame).toBe(-12);
        expect(r.asked).toEqual([]);
        expect(f.charges.map((c) => c.frame)).toEqual([-12]);
        vi.advanceTimersByTime(1);
        expect(r.shows[1]).toMatchObject({ frame: -12, preload: -11 });
        expect(r.current.frame).toBe(-12);
        expect(f.charges.map((c) => c.frame)).toEqual([-12, -11]);
        r.ready.add(-11);
        vi.advanceTimersByTime(100);
        expect(r.shows.at(-1)).toMatchObject({ frame: -11, preload: -10 });
        expect(f.charges.map((c) => c.frame)).toEqual([-12, -11, -10]);
    });

    it('counts the 3 s limit from the preload start, not from when the frame was shown', () => {
        const t0 = Date.now();
        const f = fakePace(() => t0 + 10_000);
        const r = rig({}, f.pace);
        r.player.start();
        vi.advanceTimersByTime(10_000);
        const started = r.shows.find((s) => s.preload === -11);
        expect(started).toBeDefined();
        const at = started?.at ?? 0;
        // never ready: the swap comes 3 s after the preload began
        vi.advanceTimersByTime(MAX_WAIT_MS - 1);
        expect(r.current.frame).toBe(-12);
        vi.advanceTimersByTime(1);
        expect(r.current.frame).toBe(-11);
        expect(r.shows.find((s) => s.frame === -11)?.at).toBe(at + MAX_WAIT_MS);
    });

    it('waits for the preload to load after a paced wait', () => {
        const t0 = Date.now();
        const f = fakePace(() => t0 + 4000);
        const r = rig({}, f.pace);
        r.player.start();
        vi.advanceTimersByTime(4000 + 2000);
        expect(r.current.frame).toBe(-12);
        r.ready.add(-11);
        vi.advanceTimersByTime(100);
        expect(r.current.frame).toBe(-11);
    });

    it('re-checks the pacer at least every 2 s', () => {
        let releaseAt = Date.now() + 60_000;
        const f = fakePace(() => releaseAt);
        const r = rig({}, f.pace);
        r.player.start();
        vi.advanceTimersByTime(30_000);
        // the pacer lets go early (for instance the keys were seen meanwhile)
        releaseAt = Date.now();
        vi.advanceTimersByTime(2000);
        expect(r.shows.some((s) => s.preload === -11)).toBe(true);
    });

    it('stop clears the timer while Play waits for the pacer', () => {
        const f = fakePace(() => Date.now() + 60_000);
        const r = rig({}, f.pace);
        r.player.start();
        vi.advanceTimersByTime(5000);
        expect(vi.getTimerCount()).toBe(1);
        r.player.stop('user');
        expect(vi.getTimerCount()).toBe(0);
        const n = r.shows.length;
        vi.advanceTimersByTime(120_000);
        expect(r.shows).toHaveLength(n);
        expect(r.current.frame).toBe(-12);
    });

    it('suspend works while Play waits for the pacer, and resumes', () => {
        const t0 = Date.now();
        const f = fakePace(() => t0 + 20_000);
        const r = rig({}, f.pace);
        r.player.start();
        vi.advanceTimersByTime(3000);
        const until = Date.now() + 10_000;
        r.player.suspend(until);
        expect(r.shows.at(-1)).toMatchObject({ frame: -12, preload: null });
        expect(r.states.at(-1)).toEqual({ playing: true, resumeAt: until });
        vi.advanceTimersByTime(10_000);
        expect(r.states.at(-1)).toEqual({ playing: true, resumeAt: null });
        // still paced until t0 + 20 s
        expect(r.shows.at(-1)).toMatchObject({ frame: -12, preload: null });
        vi.advanceTimersByTime(8000);
        expect(r.shows.at(-1)).toMatchObject({ frame: -12, preload: -11 });
    });

    it('without a pacer the cadence is the old one', () => {
        const r = rig();
        allReady(r);
        r.player.start();
        vi.advanceTimersByTime(12 * FRAME_MS);
        expect(r.shows.map((s) => s.frame)).toEqual([-12, -11, -10, -9, -8, -7, -6, -5, -4, -3, -2, -1, 0]);
        for (const s of r.shows.slice(0, 12)) expect(s.preload).toBe(s.frame + 1);
    });

    it('a first pass of 37 frames x 3 layers x 20 tiles never charges more than 270 tiles in 60 s', () => {
        const seen = new Set<string>();
        const keysOf = (k: number): string[] => (k <= 0 ? [`rain:${k}`, `clouds:${k}`, `radar:${k}`] : [`rain:${k}`]);
        const pacer = new FramePacer({ keysOf, tilesPerSlot: () => 20, now: () => Date.now() });
        const log: { at: number; tiles: number }[] = [];
        const pace: PlayerDeps['pace'] = {
            delayMs: (k) => pacer.delayMs(k),
            charge: (k) => {
                const fresh = keysOf(k).filter((key) => !seen.has(key));
                for (const key of fresh) seen.add(key);
                if (fresh.length > 0) log.push({ at: Date.now(), tiles: fresh.length * 20 });
                pacer.charge(k);
            },
        };
        const r = rig({ range: playRange(true, true) }, pace);
        allReady(r);
        r.player.start();
        vi.advanceTimersByTime(15 * 60_000);
        // the whole first pass ran, wrapped to -12 and kept going
        // a paced frame is shown twice: first without a preload, then with it
        const swaps = r.shows.filter((s, i) => i === 0 || s.frame !== r.shows[i - 1].frame);
        const frames = swaps.map((s) => s.frame);
        expect(frames.slice(0, 37)).toEqual(Array.from({ length: 37 }, (_, i) => i - 12));
        expect(frames.slice(37, 40)).toEqual([-12, -11, -10]);
        expect(log.reduce((n, e) => n + e.tiles, 0)).toBe(13 * 60 + 24 * 20);
        let max = 0;
        for (const a of log) {
            const sum = log.filter((b) => b.at >= a.at && b.at < a.at + 60_000).reduce((n, b) => n + b.tiles, 0);
            max = Math.max(max, sum);
        }
        expect(max).toBeLessThanOrEqual(270);
        // between 5 and 9 minutes for the first pass
        const wrapAt = swaps[36].at - swaps[0].at;
        expect(wrapAt).toBeGreaterThan(5 * 60_000);
        expect(wrapAt).toBeLessThan(9 * 60_000);
        // the second pass costs nothing and runs at full speed
        const second = swaps.slice(37, 40).map((s) => s.at);
        expect(second[2] - second[1]).toBe(FRAME_MS);
    });
});
