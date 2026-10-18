import type { TimeZoneSetting } from './types.ts';

export type ZoneFormatterFactory = (locale: string | undefined, options: Intl.DateTimeFormatOptions) => Intl.DateTimeFormat;

const defaultMake: ZoneFormatterFactory = (locale, options) => new Intl.DateTimeFormat(locale, options);

function num(parts: Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPartTypes): number {
    return Number(parts.find((p) => p.type === type)?.value ?? 0);
}

/**
 * UTC offset in minutes of `timeZone` (the device zone when undefined) at an instant.
 * Numeric parts only, so the result does not depend on the locale or on zone names.
 */
function offsetMinutes(instantMs: number, timeZone: string | undefined, make: ZoneFormatterFactory): number {
    const whole = Math.floor(instantMs / 1000) * 1000;
    const parts = make('en-US', {
        ...(timeZone ? { timeZone } : {}),
        hourCycle: 'h23',
        year: 'numeric',
        month: 'numeric',
        day: 'numeric',
        hour: 'numeric',
        minute: 'numeric',
        second: 'numeric',
    }).formatToParts(new Date(whole));
    const asUtc = Date.UTC(
        num(parts, 'year'), num(parts, 'month') - 1, num(parts, 'day'),
        num(parts, 'hour') % 24, num(parts, 'minute'), num(parts, 'second')
    );
    return Math.round((asUtc - whole) / 60000);
}

/** "GMT+13", "GMT+5:30", "GMT-3:30" or "GMT". */
function gmtLabel(minutes: number): string {
    if (minutes === 0) return 'GMT';
    const abs = Math.abs(minutes);
    const mm = abs % 60;
    return `GMT${minutes < 0 ? '-' : '+'}${Math.floor(abs / 60)}${mm ? `:${String(mm).padStart(2, '0')}` : ''}`;
}

/**
 * Short zone name of the instant for the selected setting: NZDT / NZST, UTC, or the device's own
 * short name (PDT, CEST, GMT+13). Never empty. New Zealand is decided from the UTC offset of that
 * instant, not from an Intl name, because those names differ between browsers and locales.
 */
export function zoneLabel(instantMs: number, tz: TimeZoneSetting, make: ZoneFormatterFactory = defaultMake): string {
    try {
        if (tz === 'UTC') return 'UTC';
        if (tz === 'local') {
            const parts = make(undefined, { timeZoneName: 'short' }).formatToParts(new Date(instantMs));
            const name = parts.find((p) => p.type === 'timeZoneName')?.value ?? '';
            return name || gmtLabel(offsetMinutes(instantMs, undefined, make));
        }
        const offset = offsetMinutes(instantMs, tz, make);
        if (tz === 'Pacific/Auckland') {
            if (offset === 780) return 'NZDT';
            if (offset === 720) return 'NZST';
        }
        return gmtLabel(offset);
    } catch (err) {
        if (!(err instanceof RangeError)) throw err;
        return 'UTC';
    }
}
