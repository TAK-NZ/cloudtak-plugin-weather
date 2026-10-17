import { describe, it, expect, vi } from 'vitest';
import { HealthMonitor, PAUSE_MS } from '../lib/health.ts';
import type { HealthState } from '../lib/types.ts';

function setup(): { h: HealthMonitor; t: { now: number }; log: { warn: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> }; changes: HealthState[] } {
    const t = { now: 1_000_000 };
    const log = { warn: vi.fn(), error: vi.fn() };
    const changes: HealthState[] = [];
    const h = new HealthMonitor({ now: () => t.now, log, onChange: (s) => changes.push(s) });
    return { h, t, log, changes };
}

const err = (status?: number, sourceId = 'taknz-wx-precip-src') => ({
    sourceId,
    error: status === undefined ? new Error('network') : Object.assign(new Error('http'), { status }),
});

describe('HealthMonitor', () => {
    it('starts ok with no message', () => {
        const { h } = setup();
        expect(h.state).toEqual({ kind: 'ok' });
        expect(h.message()).toBe('');
        expect(h.gate()).toBe(true);
    });

    it('ignores errors of other sources', () => {
        const { h } = setup();
        expect(h.onMapError(err(500, 'basemap'))).toBe('none');
        expect(h.onMapError({ error: { status: 500 } })).toBe('none');
        expect(h.onMapError({ sourceId: 7, error: { status: 500 } })).toBe('none');
        expect(h.state.kind).toBe('ok');
    });

    it('429 -> limited for 60 s', () => {
        const { h, t } = setup();
        expect(h.onMapError(err(429))).toBe('none');
        expect(h.state).toEqual({ kind: 'limited', until: t.now + PAUSE_MS });
        expect(h.message()).toBe('Rate limited, retrying');
    });

    it('a second 429 inside the window does not extend it', () => {
        const { h, t } = setup();
        h.onMapError(err(429));
        const first = h.state;
        t.now += 20_000;
        h.onMapError(err(429));
        expect(h.state).toBe(first);
    });

    it('401 -> denied, refreshes the token once and never loops', () => {
        const { h } = setup();
        expect(h.onMapError(err(401))).toBe('refresh-token');
        expect(h.state).toEqual({ kind: 'denied', status: 401 });
        expect(h.message()).toBe('Session expired: reload CloudTAK');
        expect(h.onMapError(err(401))).toBe('none');
        expect(h.onMapError(err(401))).toBe('none');
    });

    it('401 refresh is available again after a success', () => {
        const { h } = setup();
        h.onMapError(err(401));
        h.onTileLoaded('taknz-wx-precip-src');
        expect(h.onMapError(err(401))).toBe('refresh-token');
    });

    it('403 -> denied and asks for a status re-fetch', () => {
        const { h } = setup();
        expect(h.onMapError(err(403))).toBe('refetch-status');
        expect(h.state).toEqual({ kind: 'denied', status: 403 });
        expect(h.message()).toBe('Weather is disabled by an administrator');
    });

    it.each([400, 404])('%i -> degraded "Weather unavailable" and one console.error', (status) => {
        const { h, log } = setup();
        h.onMapError(err(status));
        h.onMapError(err(status));
        expect(h.state).toMatchObject({ kind: 'degraded', status });
        expect(h.message()).toBe('Weather unavailable');
        expect(log.error).toHaveBeenCalledTimes(1);
    });

    it.each([500, 502, 503])('%i -> degraded "Weather service unavailable"', (status) => {
        const { h } = setup();
        h.onMapError(err(status));
        expect(h.state).toMatchObject({ kind: 'degraded', status });
        expect(h.message()).toBe('Weather service unavailable');
    });

    it('ignores other client errors (for example 416)', () => {
        const { h } = setup();
        h.onMapError(err(416));
        expect(h.state.kind).toBe('ok');
    });

    it('five status-less errors within 10 s -> degraded', () => {
        const { h, t } = setup();
        for (let i = 0; i < 4; i++) {
            h.onMapError(err());
            t.now += 2000;
        }
        expect(h.state.kind).toBe('ok');
        h.onMapError(err());
        expect(h.state).toMatchObject({ kind: 'degraded' });
        expect((h.state as { status?: number }).status).toBeUndefined();
        expect(h.message()).toBe('Weather service unavailable');
    });

    it('status-less errors spread over more than 10 s do not degrade', () => {
        const { h, t } = setup();
        for (let i = 0; i < 10; i++) {
            h.onMapError(err());
            t.now += 3000;
        }
        expect(h.state.kind).toBe('ok');
    });

    it('a loaded tile resets the status-less counter', () => {
        const { h } = setup();
        for (let i = 0; i < 4; i++) h.onMapError(err());
        h.onTileLoaded('taknz-wx-clouds-src');
        for (let i = 0; i < 4; i++) h.onMapError(err());
        expect(h.state.kind).toBe('ok');
    });

    it('recovers to ok on the first loaded tile of a weather source', () => {
        const { h, changes } = setup();
        h.onMapError(err(502));
        h.onTileLoaded('basemap');
        expect(h.state.kind).toBe('degraded');
        h.onTileLoaded('taknz-wx-precip-src');
        expect(h.state).toEqual({ kind: 'ok' });
        expect(changes.at(-1)).toEqual({ kind: 'ok' });
    });

    it('warns once per transition and never logs a URL', () => {
        const { h, log } = setup();
        h.onMapError({ sourceId: 'taknz-wx-precip-src', error: { status: 502, url: 'https://x/api?token=SECRET' } });
        h.onMapError(err(502));
        h.onMapError(err(502));
        expect(log.warn).toHaveBeenCalledTimes(1);
        const text = [...log.warn.mock.calls, ...log.error.mock.calls].flat().join(' ');
        expect(text).not.toMatch(/https?:|token|SECRET/);
    });

    it('notifies listeners on every change', () => {
        const { h, changes } = setup();
        h.onMapError(err(429));
        h.onMapError(err(502));
        h.onTileLoaded();
        expect(changes.map((c) => c.kind)).toEqual(['limited', 'degraded', 'ok']);
    });
});

describe('HealthMonitor gate (queued tile-URL changes)', () => {
    it('queues changes while degraded, then allows one retry after 60 s', () => {
        const { h, t } = setup();
        h.onMapError(err(502));
        expect(h.gate()).toBe(false);
        t.now += PAUSE_MS - 1;
        expect(h.gate()).toBe(false);
        t.now += 1;
        expect(h.gate()).toBe(true);
        expect(h.gate()).toBe(false);
        t.now += PAUSE_MS;
        expect(h.gate()).toBe(true);
    });

    it('a user action earns exactly one retry', () => {
        const { h } = setup();
        h.onMapError(err(502));
        expect(h.gate()).toBe(false);
        h.noteUserAction();
        expect(h.gate()).toBe(true);
        expect(h.gate()).toBe(false);
    });

    it('noteUserAction does nothing while ok', () => {
        const { h } = setup();
        h.noteUserAction();
        h.onMapError(err(502));
        expect(h.gate()).toBe(false);
    });

    it('limited waits until the 60 s pause has passed', () => {
        const { h, t } = setup();
        h.onMapError(err(429));
        expect(h.gate()).toBe(false);
        t.now += PAUSE_MS;
        expect(h.gate()).toBe(true);
    });

    it('everything is allowed again once recovered', () => {
        const { h } = setup();
        h.onMapError(err(502));
        h.onTileLoaded('taknz-wx-precip-src');
        expect(h.gate()).toBe(true);
        expect(h.gate()).toBe(true);
    });
});
