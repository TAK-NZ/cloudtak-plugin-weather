import { describe, it, expect } from 'vitest';
import { zoneLabel } from '../lib/zone-label.ts';
import type { ZoneFormatterFactory } from '../lib/zone-label.ts';
import type { TimeZoneSetting } from '../lib/types.ts';

const ms = (iso: string): number => Date.parse(iso);

/** A factory that formats in a fixed zone, like a device set to that zone. */
function deviceIn(zone: string, strip = false, deviceLocale = 'en-US'): ZoneFormatterFactory {
    return (locale, options) => {
        const f = new Intl.DateTimeFormat(locale ?? deviceLocale, { ...options, timeZone: zone });
        if (!strip) return f;
        return {
            formatToParts: (d?: Date | number) => f.formatToParts(d).filter((p) => p.type !== 'timeZoneName'),
        } as Intl.DateTimeFormat;
    };
}

describe('zoneLabel Pacific/Auckland', () => {
    it('is NZDT in summer and NZST in winter', () => {
        expect(zoneLabel(ms('2026-01-15T00:00:00Z'), 'Pacific/Auckland')).toBe('NZDT');
        expect(zoneLabel(ms('2026-07-15T00:00:00Z'), 'Pacific/Auckland')).toBe('NZST');
    });
    it('switches at the spring transition (02:00 NZST -> 03:00 NZDT)', () => {
        expect(zoneLabel(ms('2026-09-26T13:59:00Z'), 'Pacific/Auckland')).toBe('NZST');
        expect(zoneLabel(ms('2026-09-26T14:00:00Z'), 'Pacific/Auckland')).toBe('NZDT');
    });
    it('switches at the autumn transition (03:00 NZDT -> 02:00 NZST)', () => {
        expect(zoneLabel(ms('2026-04-04T13:59:00Z'), 'Pacific/Auckland')).toBe('NZDT');
        expect(zoneLabel(ms('2026-04-04T14:00:00Z'), 'Pacific/Auckland')).toBe('NZST');
    });
    it('ignores milliseconds of the instant', () => {
        expect(zoneLabel(ms('2026-09-26T13:59:59Z') + 999, 'Pacific/Auckland')).toBe('NZST');
    });
});

describe('zoneLabel UTC', () => {
    it('is the literal UTC', () => {
        expect(zoneLabel(ms('2026-01-15T00:00:00Z'), 'UTC')).toBe('UTC');
        expect(zoneLabel(ms('2026-07-15T00:00:00Z'), 'UTC')).toBe('UTC');
    });
});

describe('zoneLabel local', () => {
    it('keeps the short name the device gives', () => {
        expect(zoneLabel(ms('2026-07-15T12:00:00Z'), 'local', deviceIn('America/Los_Angeles'))).toBe('PDT');
        expect(zoneLabel(ms('2026-01-15T12:00:00Z'), 'local', deviceIn('America/Los_Angeles'))).toBe('PST');
        expect(zoneLabel(ms('2026-07-15T12:00:00Z'), 'local', deviceIn('Europe/Berlin', false, 'en-GB'))).toBe('CEST');
    });
    it('computes GMT+h[:mm] when the device gives no name', () => {
        expect(zoneLabel(ms('2026-07-15T12:00:00Z'), 'local', deviceIn('Asia/Kolkata', true))).toBe('GMT+5:30');
        expect(zoneLabel(ms('2026-01-15T12:00:00Z'), 'local', deviceIn('Pacific/Auckland', true))).toBe('GMT+13');
        expect(zoneLabel(ms('2026-01-15T12:00:00Z'), 'local', deviceIn('America/St_Johns', true))).toBe('GMT-3:30');
        expect(zoneLabel(ms('2026-01-15T12:00:00Z'), 'local', deviceIn('UTC', true))).toBe('GMT');
    });
    it('is never empty on this machine', () => {
        expect(zoneLabel(ms('2026-01-15T12:00:00Z'), 'local')).not.toBe('');
    });
});

describe('zoneLabel invalid zone', () => {
    it('falls back to UTC', () => {
        expect(zoneLabel(ms('2026-01-15T12:00:00Z'), 'Not/AZone' as TimeZoneSetting)).toBe('UTC');
    });
});
