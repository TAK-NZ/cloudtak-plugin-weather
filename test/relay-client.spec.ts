import { describe, it, expect, vi, afterEach } from 'vitest';
import { parseStatus, isSupported, fetchStatus, tileTemplate, buildTileTemplate } from '../lib/relay-client.ts';
import { tileRequest } from '../lib/tile-url.ts';
import type { Host } from '../lib/types.ts';

const GOOD = { apiVersion: 1, enabled: true, serverTime: 1768435200, snapshot: 1768434600, layers: ['precip', 'clouds'] };

function res(status: number, body?: unknown, jsonFails = false): Response {
    return {
        status,
        ok: status >= 200 && status < 300,
        json: () => jsonFails ? Promise.reject(new SyntaxError('bad json')) : Promise.resolve(body),
    } as unknown as Response;
}

function makeHost(over: Partial<Host> = {}): Host {
    return {
        origin: () => 'https://cot.test',
        token: async () => 'tok/en+1',
        fetch: async () => res(200, GOOD),
        ...over,
    };
}

afterEach(() => {
    vi.useRealTimers();
});

describe('parseStatus', () => {
    it('accepts a valid status', () => {
        expect(parseStatus(GOOD)).toEqual(GOOD);
    });

    it('does not keep unknown fields or alias the layers array', () => {
        const parsed = parseStatus({ ...GOOD, url: 'https://x', key: 'abc' });
        expect(parsed).toEqual(GOOD);
        expect(parsed?.layers).not.toBe(GOOD.layers);
    });

    it.each([
        ['null', null],
        ['undefined', undefined],
        ['a string', 'x'],
        ['an array', []],
        ['missing apiVersion', { ...GOOD, apiVersion: undefined }],
        ['float apiVersion', { ...GOOD, apiVersion: 1.5 }],
        ['string apiVersion', { ...GOOD, apiVersion: '1' }],
        ['non-boolean enabled', { ...GOOD, enabled: 'true' }],
        ['float serverTime', { ...GOOD, serverTime: 1.5 }],
        ['string serverTime', { ...GOOD, serverTime: '1768435200' }],
        ['snapshot not a multiple of 600', { ...GOOD, snapshot: 1768434601 }],
        ['string snapshot', { ...GOOD, snapshot: '1768434600' }],
        ['layers not an array', { ...GOOD, layers: 'precip' }],
        ['layers with a non-string', { ...GOOD, layers: ['precip', 1] }],
    ])('rejects %s', (_name, raw) => {
        expect(parseStatus(raw)).toBeNull();
    });
});

describe('parseStatus: latest', () => {
    const S = 1768434600;
    const entry = (snapshot: unknown, source: unknown = 'rainbow'): unknown => ({ snapshot, source });

    it('reads the per-layer latest, the step and the window', () => {
        const parsed = parseStatus({
            ...GOOD,
            latest: { precip: entry(S), 'precip-global': entry(S), clouds: entry(S - 600, 'computed'), radars: entry(S) },
            stepSeconds: 600,
            windowSeconds: 7200,
        });
        expect(parsed).toEqual({
            ...GOOD,
            latest: { precip: S, 'precip-global': S, clouds: S - 600, radars: S },
            stepSeconds: 600,
            windowSeconds: 7200,
        });
    });

    it('keeps a partial latest and drops malformed entries without failing the status', () => {
        const parsed = parseStatus({
            ...GOOD,
            latest: {
                precip: entry(S),
                clouds: entry('x'),
                radars: entry(S + 5),
                'precip-global': entry(1.5),
                bogus: entry(S),
            },
        });
        expect(parsed).toEqual({ ...GOOD, latest: { precip: S } });
    });

    it.each([
        ['null', null],
        ['a string', 'x'],
        ['an array', [entry(S)]],
        ['entries that are not objects', { precip: S, clouds: null, radars: [S] }],
        ['an empty object', {}],
    ])('ignores latest given as %s', (_name, latest) => {
        expect(parseStatus({ ...GOOD, latest })).toEqual(GOOD);
    });

    it('ignores a bad stepSeconds or windowSeconds', () => {
        expect(parseStatus({ ...GOOD, stepSeconds: '600', windowSeconds: -1 })).toEqual(GOOD);
        expect(parseStatus({ ...GOOD, stepSeconds: 0.5 })).toEqual(GOOD);
    });

    it('still does not copy unknown fields', () => {
        expect(parseStatus({ ...GOOD, latest: { precip: entry(S) }, key: 'abc', url: 'https://x' })).toEqual({ ...GOOD, latest: { precip: S } });
    });
});

describe('isSupported', () => {
    it('supports apiVersion 1 only', () => {
        expect(isSupported({ ...GOOD, apiVersion: 1 })).toBe(true);
        expect(isSupported({ ...GOOD, apiVersion: 2 })).toBe(false);
        expect(isSupported({ ...GOOD, apiVersion: 0 })).toBe(false);
    });
});

describe('fetchStatus', () => {
    it('returns ok and calls the status endpoint with the bearer token', async () => {
        const fetch = vi.fn(async () => res(200, GOOD));
        const out = await fetchStatus(makeHost({ fetch }));
        expect(out).toEqual({ status: GOOD, reason: 'ok' });

        const call = fetch.mock.calls[0] as unknown as [string, RequestInit];
        expect(call[0]).toBe('https://cot.test/api/weather/status');
        expect(call[1].headers).toEqual({ Authorization: 'Bearer tok/en+1' });
        expect(call[1].signal).toBeInstanceOf(AbortSignal);
    });

    it('reports disabled with the parsed status', async () => {
        const body = { ...GOOD, enabled: false, layers: [] };
        const out = await fetchStatus(makeHost({ fetch: async () => res(200, body) }));
        expect(out).toEqual({ status: body, reason: 'disabled' });
    });

    it('reports unsupported before disabled', async () => {
        const body = { ...GOOD, apiVersion: 2, enabled: false };
        const out = await fetchStatus(makeHost({ fetch: async () => res(200, body) }));
        expect(out.reason).toBe('unsupported');
        expect(out.status?.apiVersion).toBe(2);
    });

    it('reports not-found for 404', async () => {
        const out = await fetchStatus(makeHost({ fetch: async () => res(404) }));
        expect(out).toEqual({ status: null, reason: 'not-found' });
    });

    it.each([401, 403])('reports unauthorized for %i', async (code) => {
        const out = await fetchStatus(makeHost({ fetch: async () => res(code) }));
        expect(out).toEqual({ status: null, reason: 'unauthorized' });
    });

    it('reports unauthorized without calling fetch when there is no token', async () => {
        const fetch = vi.fn(async () => res(200, GOOD));
        const out = await fetchStatus(makeHost({ token: async () => undefined, fetch }));
        expect(out).toEqual({ status: null, reason: 'unauthorized' });
        expect(fetch).not.toHaveBeenCalled();
    });

    it('reports unauthorized when reading the token throws', async () => {
        const out = await fetchStatus(makeHost({ token: async () => { throw new Error('boom'); } }));
        expect(out.reason).toBe('unauthorized');
    });

    it('reports network for 5xx and for exceptions', async () => {
        expect((await fetchStatus(makeHost({ fetch: async () => res(502) }))).reason).toBe('network');
        expect((await fetchStatus(makeHost({ fetch: async () => { throw new TypeError('offline'); } }))).reason).toBe('network');
    });

    it('reports invalid for unparsable JSON and for a wrong shape', async () => {
        expect((await fetchStatus(makeHost({ fetch: async () => res(200, null, true) }))).reason).toBe('invalid');
        expect((await fetchStatus(makeHost({ fetch: async () => res(200, { hello: 1 }) }))).reason).toBe('invalid');
    });

    it('aborts after 8 seconds and reports network', async () => {
        vi.useFakeTimers();
        const fetch = vi.fn((_input: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        }));

        const pending = fetchStatus(makeHost({ fetch }));
        await vi.advanceTimersByTimeAsync(7999);
        let settled = false;
        void pending.then(() => { settled = true; });
        await Promise.resolve();
        expect(settled).toBe(false);

        await vi.advanceTimersByTimeAsync(1);
        await expect(pending).resolves.toEqual({ status: null, reason: 'network' });
    });
});

describe('tileTemplate', () => {
    const host = makeHost();

    it('builds the exact string for precip with a literal {z}/{x}/{y} and the token last', async () => {
        const req = tileRequest('precip', { color: '3', forecast: 120, snapshot: 1768434600, coverage: true });
        await expect(tileTemplate(host, req)).resolves.toBe(
            'https://cot.test/api/weather/tile/{z}/{x}/{y}.png?layer=precip&color=3&forecast=120&snapshot=1768434600&coverage=1&token=tok%2Fen%2B1'
        );
    });

    it('builds the exact string for precip-global', async () => {
        const req = tileRequest('precip-global', { color: '9', forecast: 0, snapshot: 1768434600, coverage: false });
        await expect(tileTemplate(host, req)).resolves.toBe(
            'https://cot.test/api/weather/tile/{z}/{x}/{y}.png?layer=precip-global&color=9&forecast=0&snapshot=1768434600&token=tok%2Fen%2B1'
        );
    });

    it('builds the exact string for clouds', async () => {
        const req = tileRequest('clouds', { snapshot: 1768434600 });
        await expect(tileTemplate(host, req)).resolves.toBe(
            'https://cot.test/api/weather/tile/{z}/{x}/{y}.png?layer=clouds&snapshot=1768434600&token=tok%2Fen%2B1'
        );
    });

    it('builds the exact string for radars', async () => {
        const req = tileRequest('radars', { color: '0', snapshot: 1768434600, coverage: true, usePrecipType: true });
        await expect(tileTemplate(host, req)).resolves.toBe(
            'https://cot.test/api/weather/tile/{z}/{x}/{y}.png?layer=radars&color=0&snapshot=1768434600&coverage=1&use_precip_type=1&token=tok%2Fen%2B1'
        );
    });

    it('reads a fresh token on every call', async () => {
        let n = 0;
        const h = makeHost({ token: async () => `t${++n}` });
        const req = tileRequest('clouds', { snapshot: 1768434600 });
        expect(await tileTemplate(h, req)).toContain('token=t1');
        expect(await tileTemplate(h, req)).toContain('token=t2');
    });

    it('throws when there is no token', async () => {
        const req = tileRequest('clouds', { snapshot: 1768434600 });
        await expect(tileTemplate(makeHost({ token: async () => undefined }), req)).rejects.toThrow('Not signed in');
    });

    it('buildTileTemplate matches tileTemplate', async () => {
        const req = tileRequest('clouds', { snapshot: 1768434600 });
        expect(buildTileTemplate('https://cot.test', req, 'tok/en+1')).toBe(await tileTemplate(host, req));
    });
});
