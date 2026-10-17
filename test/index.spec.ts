import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises } from '@vue/test-utils';
import type { PluginInstance } from '@tak-ps/cloudtak';

const hostMock = vi.hoisted(() => ({
    host: {
        origin: () => 'https://cot.test',
        token: vi.fn(),
        fetch: vi.fn(),
    },
}));

vi.mock('../lib/host.ts', () => hostMock);

import WeatherPlugin from '../index.ts';
import { bindStorage, session, setFrame, toggleLayer, setPrecip } from '../lib/state.ts';
import { EventedFakeMap, deferred, jsonResponse, makeFakeApi, statusBody } from './helpers.ts';

const host = hostMock.host;
const STATUS_URL = 'https://cot.test/api/weather/status';

type Plugin = PluginInstance & { pending: Promise<void>; generation: number };

let tokenValue = 'tok-1';
let plugin: Plugin | undefined;

function reply(status: number, body?: unknown): void {
    host.fetch.mockImplementation(async () => jsonResponse(status, body));
}

async function install(map: EventedFakeMap | Error = new EventedFakeMap()) {
    const fake = makeFakeApi(map);
    const instance = await WeatherPlugin.install({} as never, fake.api) as Plugin;
    plugin = instance;
    return { ...fake, instance };
}

const tileUrls = (map: EventedFakeMap): string[] => [...map.sources.values()].flatMap((s) => s.tiles);

beforeEach(() => {
    tokenValue = 'tok-1';
    host.token.mockReset();
    host.token.mockImplementation(async () => tokenValue);
    host.fetch.mockReset();
    reply(200, statusBody());
    bindStorage(null);
    setFrame(0);
    session.status = null;
    session.panelOpen = false;
    session.health = { kind: 'ok' };
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(async () => {
    await plugin?.disable();
    plugin = undefined;
    vi.restoreAllMocks();
});

describe('lifecycle', () => {
    it('disable before enable does nothing', async () => {
        const { instance, calls } = await install();
        await instance.disable();
        await instance.disable();
        expect(calls).toEqual([]);
        expect(host.fetch).not.toHaveBeenCalled();
    });

    it('install has no side effects', async () => {
        const { calls } = await install();
        expect(calls).toEqual([]);
        expect(host.fetch).not.toHaveBeenCalled();
    });

    it('registers route, menu item and bottom bar when the relay is ok', async () => {
        const { instance, calls } = await install();
        await instance.enable();
        await plugin?.pending;
        expect(calls).toEqual([
            'routes.add:home-menu-plugin-weather:home-menu',
            'menu.add:weather',
            'bottomBar.add:taknz-weather',
        ]);
        expect(host.fetch).toHaveBeenCalledTimes(1);
        expect(host.fetch.mock.calls[0][0]).toBe(STATUS_URL);
    });

    it.each([
        ['status 404', () => reply(404)],
        ['status 401', () => reply(401)],
        ['status 500', () => reply(500)],
        ['enabled:false', () => reply(200, statusBody({ enabled: false, layers: [] }))],
        ['an unsupported apiVersion', () => reply(200, statusBody({ apiVersion: 2 }))],
        ['an invalid body', () => reply(200, { nope: true })],
        ['a network error', () => host.fetch.mockImplementation(async () => {
            throw new TypeError('Failed to fetch');
        })],
    ])('registers nothing and requests no tiles on %s', async (_name, setup) => {
        setup();
        toggleLayer('clouds', true);
        setPrecip('precip');
        const map = new EventedFakeMap();
        const { instance, calls } = await install(map);

        await instance.enable();
        await plugin?.pending;
        await flushPromises();

        expect(calls).toEqual([]);
        expect(map.counters.addSource).toBe(0);
        expect(map.counters.addLayer).toBe(0);
        expect(map.listenerCount()).toBe(0);
        expect(host.fetch).toHaveBeenCalledTimes(1);
        expect(host.fetch.mock.calls.every((c) => c[0] === STATUS_URL)).toBe(true);
    });

    it('logs once, without values, when the relay is missing', async () => {
        reply(404);
        const { instance } = await install();
        await instance.enable();
        await plugin?.pending;
        expect(console.info).toHaveBeenCalledTimes(1);
        expect(String(vi.mocked(console.info).mock.calls[0][0])).not.toMatch(/token|tok-1|https?:/);
    });

    it('enable returns before the status request resolves', async () => {
        const d = deferred<Response>();
        host.fetch.mockImplementation(() => d.promise);
        const { instance, calls } = await install();

        await instance.enable();
        expect(calls).toEqual([]);

        d.resolve(jsonResponse(200, statusBody()));
        await plugin?.pending;
        expect(calls).toContain('menu.add:weather');
    });

    it('an enable aborted by disable during the status fetch registers nothing', async () => {
        const d = deferred<Response>();
        host.fetch.mockImplementation(() => d.promise);
        const map = new EventedFakeMap();
        toggleLayer('clouds', true);
        const { instance, calls } = await install(map);

        await instance.enable();
        await instance.disable();
        d.resolve(jsonResponse(200, statusBody()));
        await plugin?.pending;
        await flushPromises();

        expect(calls).toEqual([]);
        expect(map.counters.addSource).toBe(0);
    });

    it('a second enable supersedes the first and registers once', async () => {
        const first = deferred<Response>();
        const second = deferred<Response>();
        host.fetch.mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise);
        const { instance, calls } = await install();

        await instance.enable();
        const firstPending = plugin?.pending;
        await instance.enable();
        const secondPending = plugin?.pending;

        first.resolve(jsonResponse(200, statusBody()));
        await firstPending;
        expect(calls).toEqual([]);

        second.resolve(jsonResponse(200, statusBody()));
        await secondPending;
        expect(calls.filter((c) => c.startsWith('menu.add'))).toHaveLength(1);
        expect(calls.filter((c) => c.startsWith('routes.add'))).toHaveLength(1);
        expect(calls.filter((c) => c.startsWith('bottomBar.add'))).toHaveLength(1);
    });

    it('enable after enable tears down the previous registration first', async () => {
        const { instance, calls } = await install();
        await instance.enable();
        await plugin?.pending;
        await instance.enable();
        await plugin?.pending;
        expect(calls).toEqual([
            'routes.add:home-menu-plugin-weather:home-menu',
            'menu.add:weather',
            'bottomBar.add:taknz-weather',
            'bottomBar.remove:taknz-weather',
            'menu.remove:weather',
            'router.removeRoute:home-menu-plugin-weather',
            'routes.add:home-menu-plugin-weather:home-menu',
            'menu.add:weather',
            'bottomBar.add:taknz-weather',
        ]);
    });

    it('disable removes everything, is idempotent and removes the map listeners', async () => {
        const map = new EventedFakeMap();
        toggleLayer('clouds', true);
        const { instance, calls } = await install(map);
        await instance.enable();
        await plugin?.pending;
        await vi.waitFor(() => expect(map.layers.some((l) => l.id === 'taknz-wx-clouds')).toBe(true));
        expect(map.listenerCount()).toBeGreaterThan(0);

        calls.length = 0;
        await instance.disable();
        await instance.disable();

        expect(calls).toEqual([
            'bottomBar.remove:taknz-weather',
            'menu.remove:weather',
            'router.removeRoute:home-menu-plugin-weather',
        ]);
        expect(map.layers.some((l) => l.id.startsWith('taknz-wx-'))).toBe(false);
        expect([...map.sources.keys()].some((id) => id.startsWith('taknz-wx-'))).toBe(false);
        expect(map.listenerCount()).toBe(0);
    });

    it('disable still unregisters when api.map throws', async () => {
        const fake = await install(new EventedFakeMap());
        await fake.instance.enable();
        await plugin?.pending;
        fake.setMap(new Error('Map destroyed'));
        fake.calls.length = 0;

        await expect(fake.instance.disable()).resolves.toBeUndefined();
        expect(fake.calls).toEqual([
            'bottomBar.remove:taknz-weather',
            'menu.remove:weather',
            'router.removeRoute:home-menu-plugin-weather',
        ]);
    });

    it('rolls back when api.map throws during enable', async () => {
        const { instance, calls } = await install(new Error('Map not loaded'));
        await instance.enable();
        await plugin?.pending;
        expect(calls).toEqual([
            'routes.add:home-menu-plugin-weather:home-menu',
            'menu.add:weather',
            'bottomBar.add:taknz-weather',
            'bottomBar.remove:taknz-weather',
            'menu.remove:weather',
            'router.removeRoute:home-menu-plugin-weather',
        ]);
        expect(console.error).toHaveBeenCalled();
    });
});

describe('layers', () => {
    it('makes no tile source until a layer is turned on', async () => {
        const map = new EventedFakeMap();
        const { instance } = await install(map);
        await instance.enable();
        await plugin?.pending;
        await flushPromises();
        expect(map.counters.addSource).toBe(0);
        expect(map.counters.addLayer).toBe(0);

        toggleLayer('clouds', true);
        await vi.waitFor(() => expect(map.counters.addLayer).toBe(1));
        expect(tileUrls(map)[0]).toContain('layer=clouds');
        expect(tileUrls(map)[0]).toContain('token=tok-1');
    });

    it('restores the selection on a new map after disable and enable', async () => {
        toggleLayer('clouds', true);
        setPrecip('precip-global');
        const first = new EventedFakeMap();
        const fake = await install(first);
        await fake.instance.enable();
        await plugin?.pending;
        await vi.waitFor(() => expect(first.layers.filter((l) => l.id.startsWith('taknz-wx-'))).toHaveLength(2));

        await fake.instance.disable();
        expect(first.layers.some((l) => l.id.startsWith('taknz-wx-'))).toBe(false);

        const second = new EventedFakeMap();
        fake.setMap(second);
        fake.calls.length = 0;
        await fake.instance.enable();
        await plugin?.pending;

        expect(fake.calls).toEqual([
            'routes.add:home-menu-plugin-weather:home-menu',
            'menu.add:weather',
            'bottomBar.add:taknz-weather',
        ]);
        await vi.waitFor(() => expect(second.layers.filter((l) => l.id.startsWith('taknz-wx-')).map((l) => l.id))
            .toEqual(['taknz-wx-clouds', 'taknz-wx-precip']));
        expect(tileUrls(second).some((u) => u.includes('layer=precip-global'))).toBe(true);
    });

    it('re-reads the token on every setTiles', async () => {
        setPrecip('precip');
        const map = new EventedFakeMap();
        const { instance } = await install(map);
        await instance.enable();
        await plugin?.pending;
        await vi.waitFor(() => expect(map.counters.addLayer).toBe(1));
        const reads = host.token.mock.calls.length;
        expect(tileUrls(map)[0]).toContain('token=tok-1');

        tokenValue = 'tok-2';
        setFrame(3);
        await vi.waitFor(() => expect(map.counters.setTiles).toBe(1));

        expect(host.token.mock.calls.length).toBeGreaterThan(reads);
        expect(tileUrls(map)[0]).toContain('token=tok-2');
        expect(tileUrls(map)[0]).toContain('forecast=30');
    });

    it('a slider commit makes exactly one setTiles, on the rain source only', async () => {
        toggleLayer('clouds', true);
        toggleLayer('radars', true);
        setPrecip('precip');
        const map = new EventedFakeMap();
        const { instance } = await install(map);
        await instance.enable();
        await plugin?.pending;
        await vi.waitFor(() => expect(map.counters.addLayer).toBe(3));

        const before = new Map([...map.sources].map(([id, s]) => [id, s.tiles[0]]));
        map.resetCounters();

        setFrame(12);
        await vi.waitFor(() => expect(map.counters.setTiles).toBe(1));
        await flushPromises();

        expect(map.counters.setTiles).toBe(1);
        expect(map.counters.addLayer).toBe(0);
        expect(map.counters.removeLayer).toBe(0);
        expect(map.sources.get('taknz-wx-precip-src')?.tiles[0]).toContain('forecast=120');
        expect(map.sources.get('taknz-wx-clouds-src')?.tiles[0]).toBe(before.get('taknz-wx-clouds-src'));
        expect(map.sources.get('taknz-wx-radars-src')?.tiles[0]).toBe(before.get('taknz-wx-radars-src'));
    });

    it('holds back tile URL changes while the relay is unhealthy, but still removes layers', async () => {
        setPrecip('precip');
        toggleLayer('clouds', true);
        const map = new EventedFakeMap();
        const { instance } = await install(map);
        await instance.enable();
        await plugin?.pending;
        await vi.waitFor(() => expect(map.counters.addLayer).toBe(2));

        map.emit('error', { sourceId: 'taknz-wx-precip-src', error: { status: 502 } });
        expect(session.health.kind).toBe('degraded');
        map.resetCounters();

        // A user action earns one retry; a snapshot rollover afterwards is queued.
        setFrame(1);
        await vi.waitFor(() => expect(map.counters.setTiles).toBe(1));
        session.snapshot += 600;
        await flushPromises();
        expect(map.counters.setTiles).toBe(1);

        toggleLayer('clouds', false);
        await vi.waitFor(() => expect(map.layers.some((l) => l.id === 'taknz-wx-clouds')).toBe(false));
    });

    it('turns itself off when a 403 and a status refetch say the relay is disabled', async () => {
        setPrecip('precip');
        const map = new EventedFakeMap();
        const { instance, calls } = await install(map);
        await instance.enable();
        await plugin?.pending;
        await vi.waitFor(() => expect(map.counters.addLayer).toBe(1));

        reply(200, statusBody({ enabled: false, layers: [] }));
        map.emit('error', { sourceId: 'taknz-wx-precip-src', error: { status: 403 } });

        await vi.waitFor(() => expect(calls).toContain('menu.remove:weather'));
        expect(map.layers.some((l) => l.id.startsWith('taknz-wx-'))).toBe(false);
    });
});
