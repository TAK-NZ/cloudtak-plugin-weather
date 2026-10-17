import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import {
    clock, applyServerTime, snapshotAt, clampFrame, frameToMinutes, minutesToFrame, validTimeS, dataAgeMin,
    formatClock, frameLabel, debounce, rolloverJitterMs, SNAPSHOT_EXACT, APPROXIMATE_TOOLTIP, TIMELINE, FRAME_COUNT,
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
    it('has 25 frames covering 0..240 minutes', () => {
        expect(FRAME_COUNT).toBe(25);
        expect(TIMELINE).toEqual({ pastFrames: 0, futureFrames: 24 });
    });

    it.each([
        [NaN, 0], [-5, 0], [-0.4, 0], [0, 0], [0.4, 0], [0.6, 1], [12, 12], [24, 24], [25, 24], [1000, 24], [Infinity, 24], [-Infinity, 0],
    ])('clampFrame(%s) = %s', (input, expected) => {
        expect(clampFrame(input)).toBe(expected);
    });

    it('converts between frames and minutes', () => {
        expect(frameToMinutes(0)).toBe(0);
        expect(frameToMinutes(12)).toBe(120);
        expect(frameToMinutes(99)).toBe(240);
        expect(frameToMinutes(NaN)).toBe(0);
        expect(minutesToFrame(240)).toBe(24);
        expect(minutesToFrame(55)).toBe(6);
        expect(minutesToFrame(-30)).toBe(0);
    });

    it('validTimeS supports signed frames', () => {
        expect(validTimeS(1000, 0)).toBe(1000);
        expect(validTimeS(1000, 6)).toBe(4600);
        expect(validTimeS(1000, -2)).toBe(-200);
    });

    it('dataAgeMin never goes negative', () => {
        expect(dataAgeMin(1_000_000, (1_000_000 + 12 * 60) * 1000)).toBe(12);
        expect(dataAgeMin(1_000_000, 900_000 * 1000)).toBe(0);
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

    it('maps GMT+13 / GMT+12 from the formatter to NZDT / NZST', () => {
        const fake = (name: string) => () => ({
            formatToParts: () => [
                { type: 'weekday', value: 'Thu' }, { type: 'literal', value: ' ' },
                { type: 'hour', value: '14' }, { type: 'literal', value: ':' },
                { type: 'minute', value: '20' }, { type: 'timeZoneName', value: name },
            ],
        }) as unknown as Intl.DateTimeFormat;
        expect(formatClock(0, 'Pacific/Auckland', fake('GMT+13'))).toBe('Thu 14:20 NZDT');
        expect(formatClock(0, 'Pacific/Auckland', fake('GMT+12'))).toBe('Thu 14:20 NZST');
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

describe('frameLabel', () => {
    const snapshot = Date.parse('2026-01-15T00:00:00Z') / 1000;
    const nowMs = (snapshot + 14 * 60) * 1000;

    it('is approximate while SNAPSHOT_EXACT is false', () => {
        expect(SNAPSHOT_EXACT).toBe(false);
    });

    it('labels frame 0 as Now with the data age', () => {
        expect(frameLabel({ frame: 0, snapshot, nowMs, tz: 'Pacific/Auckland', precip: true })).toEqual({
            primary: 'Now',
            time: '~Thu 13:00 NZDT',
            secondary: 'data 14 min old',
            tooltip: APPROXIMATE_TOOLTIP,
        });
    });

    it('labels a forecast frame with its clock time and offset', () => {
        expect(frameLabel({ frame: 12, snapshot, nowMs, tz: 'Pacific/Auckland', precip: true })).toEqual({
            primary: '~Thu 15:00 NZDT',
            time: '',
            secondary: '+120 min',
            tooltip: APPROXIMATE_TOOLTIP,
        });
    });

    it('uses the selected time zone', () => {
        expect(frameLabel({ frame: 6, snapshot, nowMs, tz: 'UTC', precip: true }).primary).toBe('~Thu 01:00 UTC');
    });

    it('clamps a bad frame', () => {
        expect(frameLabel({ frame: 99, snapshot, nowMs, tz: 'UTC', precip: true }).secondary).toBe('+240 min');
        expect(frameLabel({ frame: NaN, snapshot, nowMs, tz: 'UTC', precip: true }).primary).toBe('Now');
    });

    it('says Current data when no rain layer is selected', () => {
        expect(frameLabel({ frame: 5, snapshot, nowMs, tz: 'UTC', precip: false })).toEqual({
            primary: 'Current data', time: '', secondary: '',
        });
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
