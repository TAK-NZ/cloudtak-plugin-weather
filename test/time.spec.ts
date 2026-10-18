import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import {
    clock, applyServerTime, snapshotAt, clampFrame, frameToMinutes, frameTimeS, frameBounds, validLatest, anchorFrom,
    lowerGuard, rainFrame, holdSnapshot, formatClock, formatHm, frameLabel, debounce, rolloverJitterMs,
    TIMELINE, FRAME_COUNT, FRAME_MIN, FRAME_MAX,
} from '../lib/time.ts';

afterEach(() => {
    vi.useRealTimers();
    clock.offsetMs = 0;
});

describe('snapshotAt', () => {
    it('matches the relay formula floor(t/600)*600-600', () => {
        const t0 = Date.parse('2026-01-15T00:20:00Z');
        const base = t0 / 1000;
        expect(snapshotAt(t0)).toBe(base - 600);
        expect(snapshotAt(t0 + 599_999)).toBe(base - 600);
        expect(snapshotAt(t0 + 600_000)).toBe(base);
        expect(snapshotAt(t0 - 1)).toBe(base - 1200);
    });

    it('is always a multiple of 600', () => {
        for (let i = 0; i < 50; i++) {
            expect(snapshotAt(1_768_435_200_000 + i * 123_457) % 600).toBe(0);
        }
    });

    it('steps at :00 and :09:59 boundaries', () => {
        const at = (iso: string): number => snapshotAt(Date.parse(iso));
        const s = Date.parse('2026-01-15T00:10:00Z') / 1000 - 600;
        expect(at('2026-01-15T00:10:00Z')).toBe(s);
        expect(at('2026-01-15T00:19:59Z')).toBe(s);
        expect(at('2026-01-15T00:20:00Z')).toBe(s + 600);
    });
});

describe('server clock', () => {
    it('applyServerTime sets the offset so now() follows the server', () => {
        vi.useFakeTimers();
        vi.setSystemTime(Date.parse('2026-01-15T00:09:30Z'));
        const server = Date.parse('2026-01-15T00:10:05Z') / 1000;
        applyServerTime(server);
        expect(clock.offsetMs).toBe(35_000);
        expect(clock.now()).toBe(server * 1000);
    });

    it('applyServerTime + snapshotAt equals the relay formula', () => {
        vi.useFakeTimers();
        vi.setSystemTime(Date.parse('2026-01-15T00:09:30Z'));
        const server = Date.parse('2026-01-15T00:10:05Z') / 1000;
        applyServerTime(server);
        expect(snapshotAt(clock.now())).toBe(Math.floor(server / 600) * 600 - 600);
        vi.advanceTimersByTime(60_000);
        expect(snapshotAt(clock.now())).toBe(Math.floor((server + 60) / 600) * 600 - 600);
    });

    it('supports a browser clock ahead of the server', () => {
        vi.useFakeTimers();
        vi.setSystemTime(Date.parse('2026-01-15T00:10:30Z'));
        applyServerTime(Date.parse('2026-01-15T00:09:59Z') / 1000);
        expect(clock.offsetMs).toBe(-31_000);
        expect(snapshotAt(clock.now())).toBe(Date.parse('2026-01-15T00:00:00Z') / 1000 - 600);
    });
});

describe('frames', () => {
    it('has 37 frames covering -120..+240 minutes', () => {
        expect(FRAME_MIN).toBe(-12);
        expect(FRAME_MAX).toBe(24);
        expect(FRAME_COUNT).toBe(37);
        expect(TIMELINE).toEqual({ pastFrames: 12, futureFrames: 24 });
    });
    it('frameBounds follows the Rain layer', () => {
        expect(frameBounds(true)).toEqual({ min: -12, max: 24 });
        expect(frameBounds(false)).toEqual({ min: -12, max: 0 });
    });
    it.each([
        [NaN, 0], [-13, -12], [-12, -12], [-5, -5], [-0.4, 0], [0, 0], [0.4, 0], [0.6, 1], [12, 12], [24, 24], [25, 24], [1000, 24],
        [Infinity, 24], [-Infinity, -12],
    ])('clampFrame(%s) = %s', (input, expected) => {
        expect(clampFrame(input)).toBe(expected);
    });
    it('clampFrame honours a lower maximum (Rain off)', () => {
        expect(clampFrame(6, 0)).toBe(0);
        expect(clampFrame(-6, 0)).toBe(-6);
        expect(clampFrame(40, 10)).toBe(10);
        expect(clampFrame(40, 99)).toBe(24);
    });
    it('frameToMinutes is the forecast offset only', () => {
        expect(frameToMinutes(0)).toBe(0);
        expect(frameToMinutes(-5)).toBe(0);
        expect(frameToMinutes(12)).toBe(120);
        expect(frameToMinutes(99)).toBe(240);
        expect(frameToMinutes(NaN)).toBe(0);
    });
    it('frameTimeS puts frames on a 10 minute axis', () => {
        expect(frameTimeS(1000, 0)).toBe(1000);
        expect(frameTimeS(1000, 6)).toBe(4600);
        expect(frameTimeS(1000, -2)).toBe(-200);
    });
});
describe('timeline snapshots', () => {
    // now = 23:25, precip/precip-global/radars latest 23:20, clouds latest 23:10 (plan D4)
    const day = Date.parse('2026-01-14T00:00:00Z') / 1000;
    const hm = (h: number, m: number): number => day + h * 3600 + m * 60;
    const nowMs = hm(23, 25) * 1000;
    const latest = { precip: hm(23, 20), 'precip-global': hm(23, 20), clouds: hm(23, 10), radars: hm(23, 20) };
    const A = hm(23, 20);
    it('anchorFrom takes the newest latest of the four layers', () => {
        expect(anchorFrom(latest, hm(23, 10), nowMs)).toBe(A);
        expect(anchorFrom({ clouds: hm(23, 10) }, hm(23, 20), nowMs)).toBe(hm(23, 10));
        expect(anchorFrom({ clouds: hm(23, 10), radars: hm(23, 20) }, undefined, nowMs)).toBe(A);
    });
    it('anchorFrom ignores implausible entries and falls back to the status snapshot', () => {
        const bad = { precip: hm(23, 20) + 5, clouds: day, radars: hm(23, 20) + 6000, 'precip-global': 1.5 };
        expect(anchorFrom(bad, hm(23, 10), nowMs)).toBe(hm(23, 10));
        expect(anchorFrom(undefined, hm(23, 10), nowMs)).toBe(hm(23, 10));
        expect(anchorFrom({}, hm(23, 10), nowMs)).toBe(hm(23, 10));
    });
    it('anchorFrom falls back to the computed snapshot', () => {
        expect(anchorFrom(undefined, undefined, nowMs)).toBe(snapshotAt(nowMs));
        expect(anchorFrom({}, 1234, nowMs)).toBe(snapshotAt(nowMs));
    });
    it('validLatest keeps plausible entries only', () => {
        expect(validLatest({ ...latest, clouds: 7 }, nowMs)).toEqual({ precip: A, 'precip-global': A, radars: A });
        expect(validLatest(undefined, nowMs)).toEqual({});
    });
    it('lowerGuard never goes below the relay window', () => {
        expect(lowerGuard(hm(21, 20), nowMs)).toBe(hm(21, 20));
        expect(lowerGuard(hm(21, 0), nowMs)).toBe(hm(21, 10));
        expect(lowerGuard(hm(23, 0), nowMs)).toBe(hm(23, 0));
    });
    it('rain: exact past, forecast from its own latest', () => {
        expect(rainFrame(0, A, A, nowMs)).toEqual({ snapshot: A, forecast: 0 });
        expect(rainFrame(-1, A, A, nowMs)).toEqual({ snapshot: hm(23, 10), forecast: 0 });
        expect(rainFrame(-12, A, A, nowMs)).toEqual({ snapshot: hm(21, 20), forecast: 0 });
        expect(rainFrame(3, A, A, nowMs)).toEqual({ snapshot: A, forecast: 30 });
        expect(rainFrame(24, A, hm(23, 10), nowMs)).toEqual({ snapshot: hm(23, 10), forecast: 240 });
        expect(rainFrame(3, A, undefined, nowMs)).toEqual({ snapshot: A, forecast: 30 });
    });
    it('clouds and radar hold their newest frame after Now', () => {
        expect(holdSnapshot(3, A, nowMs)).toBe(A);
        expect(holdSnapshot(24, A, nowMs)).toBe(A);
        expect(holdSnapshot(0, A, nowMs)).toBe(A);
        expect(holdSnapshot(-1, A, nowMs)).toBe(hm(23, 10));
        expect(holdSnapshot(-12, A, nowMs)).toBe(hm(21, 20));
    });
    it('the lower guard repeats frame -11 for -12 while the window has slid but the anchor has not', () => {
        // 23:40:20: the relay window is already 21:30..23:30 but the anchor is still 23:20
        const later = (hm(23, 40) + 20) * 1000;
        expect(holdSnapshot(-12, A, later)).toBe(hm(21, 30));
        expect(holdSnapshot(-11, A, later)).toBe(hm(21, 30));
        expect(rainFrame(-12, A, A, later).snapshot).toBe(hm(21, 30));
    });
});
describe('formatClock', () => {
    it('formats NZDT (summer)', () => {
        expect(formatClock(Date.parse('2026-01-15T00:00:00Z') / 1000, 'Pacific/Auckland')).toBe('Thu 13:00 NZDT');
    });

    it('formats NZST (winter)', () => {
        expect(formatClock(Date.parse('2026-07-15T00:00:00Z') / 1000, 'Pacific/Auckland')).toBe('Wed 12:00 NZST');
    });

    it('formats UTC', () => {
        expect(formatClock(Date.parse('2026-01-15T00:00:00Z') / 1000, 'UTC')).toBe('Thu 00:00 UTC');
    });

    it('uses the device zone for local', () => {
        const out = formatClock(Date.parse('2026-01-15T00:00:00Z') / 1000, 'local');
        expect(out).toMatch(/^[A-Z][a-z]{2} \d{2}:\d{2}/);
    });

    it('falls back to UTC for an invalid zone', () => {
        const out = formatClock(Date.parse('2026-01-15T00:00:00Z') / 1000, 'Not/AZone' as 'UTC');
        expect(out).toBe('Thu 00:00 UTC');
    });

    it('renders midnight as 00', () => {
        expect(formatClock(Date.parse('2026-01-15T11:00:00Z') / 1000, 'Pacific/Auckland')).toBe('Fri 00:00 NZDT');
    });
});

describe('formatHm', () => {
    const t = Date.parse('2026-01-15T00:20:00Z') / 1000;
    it('formats the time of day in each zone', () => {
        expect(formatHm(t, 'Pacific/Auckland')).toBe('13:20');
        expect(formatHm(t, 'UTC')).toBe('00:20');
        expect(formatHm(t, 'local')).toMatch(/^\d{2}:\d{2}$/);
    });
    it('falls back to UTC for an invalid zone', () => {
        expect(formatHm(t, 'Not/AZone' as 'UTC')).toBe('00:20');
    });
});
describe('frameLabel', () => {
    const anchor = Date.parse('2026-01-15T00:00:00Z') / 1000;
    it.each([
        [0, 'Pacific/Auckland', 'Now · 13:00', 'NZDT', 'Now · Thu 13:00 NZDT'],
        [0, 'UTC', 'Now · 00:00', 'UTC', 'Now · Thu 00:00 UTC'],
        [-4, 'Pacific/Auckland', '-40 min · 12:20', 'NZDT', '-40 min · Thu 12:20 NZDT'],
        [-4, 'UTC', '-40 min · 23:20', 'UTC', '-40 min · Wed 23:20 UTC'],
        [-12, 'Pacific/Auckland', '-120 min · 11:00', 'NZDT', '-120 min · Thu 11:00 NZDT'],
        [3, 'Pacific/Auckland', '+30 min · 13:30', 'NZDT', '+30 min · Thu 13:30 NZDT'],
        [3, 'UTC', '+30 min · 00:30', 'UTC', '+30 min · Thu 00:30 UTC'],
        [24, 'Pacific/Auckland', '+240 min · 17:00', 'NZDT', '+240 min · Thu 17:00 NZDT'],
    ] as const)('frame %s in %s', (frame, tz, base, zone, title) => {
        expect(frameLabel({ frame, anchor, tz })).toEqual({ base, zone, text: `${base} ${zone}`, title });
    });
    it('decides the zone from the frame instant across a DST change', () => {
        const edge = Date.parse('2026-09-26T14:00:00Z') / 1000;
        expect(frameLabel({ frame: -1, anchor: edge, tz: 'Pacific/Auckland' }).text).toBe('-10 min · 01:50 NZST');
        expect(frameLabel({ frame: 0, anchor: edge, tz: 'Pacific/Auckland' }).text).toBe('Now · 03:00 NZDT');
    });
    it('uses the device zone for local', () => {
        const l = frameLabel({ frame: -2, anchor, tz: 'local' });
        expect(l.base).toMatch(/^-20 min · \d{2}:\d{2}$/);
        expect(l.text).toBe(`${l.base} ${l.zone}`);
        expect(l.zone).not.toBe('');
        expect(l.title).toMatch(/^-20 min · [A-Z][a-z]{2} \d{2}:\d{2}/);
    });
    it('has no approximation marker', () => {
        expect(frameLabel({ frame: 0, anchor, tz: 'UTC' }).text).not.toContain('~');
    });
    it('clamps a bad frame', () => {
        expect(frameLabel({ frame: 99, anchor, tz: 'UTC' }).text).toBe('+240 min · 04:00 UTC');
        expect(frameLabel({ frame: -99, anchor, tz: 'UTC' }).text).toBe('-120 min · 22:00 UTC');
        expect(frameLabel({ frame: NaN, anchor, tz: 'UTC' }).text).toBe('Now · 00:00 UTC');
    });
});
describe('debounce', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    it('calls once with the last arguments after the delay', () => {
        const fn = vi.fn();
        const d = debounce(fn, 150);
        d(1);
        vi.advanceTimersByTime(100);
        d(2);
        vi.advanceTimersByTime(149);
        expect(fn).not.toHaveBeenCalled();
        vi.advanceTimersByTime(1);
        expect(fn).toHaveBeenCalledTimes(1);
        expect(fn).toHaveBeenCalledWith(2);
    });

    it('cancel drops the pending call', () => {
        const fn = vi.fn();
        const d = debounce(fn, 150);
        d(1);
        d.cancel();
        vi.advanceTimersByTime(1000);
        expect(fn).not.toHaveBeenCalled();
    });

    it('flush runs the pending call immediately and only once', () => {
        const fn = vi.fn();
        const d = debounce(fn, 150);
        d(7);
        d.flush();
        expect(fn).toHaveBeenCalledTimes(1);
        expect(fn).toHaveBeenCalledWith(7);
        vi.advanceTimersByTime(1000);
        expect(fn).toHaveBeenCalledTimes(1);
    });

    it('flush without a pending call does nothing', () => {
        const fn = vi.fn();
        debounce(fn, 150).flush();
        expect(fn).not.toHaveBeenCalled();
    });
});

describe('rolloverJitterMs', () => {
    it('is within 0..60000 and injectable', () => {
        expect(rolloverJitterMs(() => 0)).toBe(0);
        expect(rolloverJitterMs(() => 0.5)).toBe(30000);
        expect(rolloverJitterMs(() => 0.999999)).toBeLessThan(60000);
        const r = rolloverJitterMs();
        expect(r).toBeGreaterThanOrEqual(0);
        expect(r).toBeLessThan(60000);
    });
});
