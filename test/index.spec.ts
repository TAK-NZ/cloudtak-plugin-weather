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
import { bindStorage, session, setFrame, settings, toggleLayer } from '../lib/state.ts';
import { snapshotAt } from '../lib/time.ts';
import { CONTROL_CLASS, CONTROL_STYLE_ID } from '../lib/constants.ts';
import { EventedFakeMap, deferred, jsonResponse, latestBody, makeFakeApi, setRain, statusBody } from './helpers.ts';

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

const controlEl = (): HTMLElement | null => document.querySelector(`.${CONTROL_CLASS}`);
const controlButton = (): HTMLButtonElement | null => document.querySelector(`.${CONTROL_CLASS} button`);
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
    session.latest = {};
    session.panelOpen = false;
    session.health = { kind: 'ok' };
    vi.spyOn(console, 'info').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(async () => {
    await plugin?.disable();
    plugin = undefined;
    document.body.replaceChildren();
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

    it('registers route, menu item and the map control, but no bottom bar, when the relay is ok', async () => {
        const map = new EventedFakeMap();
        const { instance, calls } = await install(map);
        await instance.enable();
        await plugin?.pending;
        expect(calls).toEqual([
            'routes.add:home-menu-plugin-weather:home-menu',
            'menu.add:weather',
        ]);
        expect(map.controls.map((c) => c.position)).toEqual(['top-left']);
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
        setRain('precip');
        const map = new EventedFakeMap();
        const { instance, calls } = await install(map);

        await instance.enable();
        await plugin?.pending;
        await flushPromises();

        expect(calls).toEqual([]);
        expect(map.counters.addSource).toBe(0);
        expect(map.counters.addLayer).toBe(0);
        expect(map.listenerCount()).toBe(0);
        expect(map.controls).toEqual([]);
        expect(controlEl()).toBeNull();
        expect(document.getElementById(CONTROL_STYLE_ID)).toBeNull();
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
        expect(calls.filter((c) => c.startsWith('bottomBar.add'))).toHaveLength(0);
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
            'menu.remove:weather',
            'router.removeRoute:home-menu-plugin-weather',
            'routes.add:home-menu-plugin-weather:home-menu',
            'menu.add:weather',
        ]);
        expect(document.querySelectorAll(`.${CONTROL_CLASS}`)).toHaveLength(1);
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
            'menu.remove:weather',
            'router.removeRoute:home-menu-plugin-weather',
        ]);
        expect(map.controls).toEqual([]);
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
            'menu.remove:weather',
            'router.removeRoute:home-menu-plugin-weather',
        ]);
        expect(controlEl()).toBeNull();
        expect(document.getElementById(CONTROL_STYLE_ID)).toBeNull();
    });

    it('disable still removes the control and the open bar item when api.map throws', async () => {
        const fake = await install(new EventedFakeMap());
        await fake.instance.enable();
        await plugin?.pending;
        session.panelOpen = true;
        fake.setMap(new Error('Map destroyed'));
        fake.calls.length = 0;

        await fake.instance.disable();
        expect(fake.calls).toEqual([
            'bottomBar.remove:taknz-weather',
            'menu.remove:weather',
            'router.removeRoute:home-menu-plugin-weather',
        ]);
        expect(controlEl()).toBeNull();
    });

    it('rolls back when api.map throws during enable', async () => {
        const { instance, calls } = await install(new Error('Map not loaded'));
        await instance.enable();
        await plugin?.pending;
        expect(calls).toEqual([
            'routes.add:home-menu-plugin-weather:home-menu',
            'menu.add:weather',
            'menu.remove:weather',
            'router.removeRoute:home-menu-plugin-weather',
        ]);
        expect(controlEl()).toBeNull();
        expect(console.error).toHaveBeenCalled();
    });
});

describe('weather control and bottom bar', () => {
    async function running(map = new EventedFakeMap()) {
        const fake = await install(map);
        await fake.instance.enable();
        await plugin?.pending;
        fake.calls.length = 0;
        return { map, ...fake };
    }

    it('adds exactly one control to top-left per enable, placed in the column', async () => {
        const map = new EventedFakeMap();
        const column = document.createElement('div');
        column.className = 'cloudtak-ctrl-group';
        map.shell.append(column);
        const { instance } = await running(map);

        expect(map.controls).toHaveLength(1);
        expect(map.controls[0].position).toBe('top-left');
        expect(controlEl()?.parentElement).toBe(column);

        await instance.enable();
        await plugin?.pending;
        expect(map.controls).toHaveLength(1);
        expect(document.querySelectorAll(`.${CONTROL_CLASS}`)).toHaveLength(1);
    });

    it('opening registers the bar once, closing removes it, repeats are idempotent', async () => {
        const { calls } = await running();

        session.panelOpen = true;
        session.panelOpen = true;
        expect(calls).toEqual(['bottomBar.add:taknz-weather']);

        session.panelOpen = false;
        session.panelOpen = false;
        expect(calls).toEqual(['bottomBar.add:taknz-weather', 'bottomBar.remove:taknz-weather']);

        session.panelOpen = true;
        session.panelOpen = false;
        expect(calls.filter((c) => c.startsWith('bottomBar.add'))).toHaveLength(2);
        expect(calls.filter((c) => c.startsWith('bottomBar.remove'))).toHaveLength(2);
    });

    it('a click on the control flips the panel and the pressed state', async () => {
        const { calls } = await running();
        controlButton()?.click();
        expect(session.panelOpen).toBe(true);
        expect(controlButton()?.getAttribute('aria-pressed')).toBe('true');
        expect(calls).toEqual(['bottomBar.add:taknz-weather']);

        controlButton()?.click();
        expect(session.panelOpen).toBe(false);
        expect(controlButton()?.getAttribute('aria-pressed')).toBe('false');
        expect(calls).toEqual(['bottomBar.add:taknz-weather', 'bottomBar.remove:taknz-weather']);
    });

    it('closing the panel keeps the weather layers on the map', async () => {
        toggleLayer('clouds', true);
        const map = new EventedFakeMap();
        await running(map);
        await vi.waitFor(() => expect(map.layers.some((l) => l.id === 'taknz-wx-clouds')).toBe(true));

        session.panelOpen = true;
        session.panelOpen = false;
        await flushPromises();
        expect(map.layers.some((l) => l.id === 'taknz-wx-clouds')).toBe(true);
    });

    it('disable removes the control, its style and the open bar item', async () => {
        const map = new EventedFakeMap();
        const { instance, calls } = await running(map);
        session.panelOpen = true;
        calls.length = 0;

        await instance.disable();
        expect(calls).toContain('bottomBar.remove:taknz-weather');
        expect(map.controls).toEqual([]);
        expect(controlEl()).toBeNull();
        expect(document.getElementById(CONTROL_STYLE_ID)).toBeNull();
        expect(session.panelOpen).toBe(false);
    });

    it('re-enable adds a fresh control that starts closed', async () => {
        const map = new EventedFakeMap();
        const { instance, calls } = await running(map);
        session.panelOpen = true;
        await instance.disable();

        calls.length = 0;
        await instance.enable();
        await plugin?.pending;
        expect(map.controls).toHaveLength(1);
        expect(document.querySelectorAll(`.${CONTROL_CLASS}`)).toHaveLength(1);
        expect(controlButton()?.getAttribute('aria-pressed')).toBe('false');
        expect(calls.some((c) => c.startsWith('bottomBar'))).toBe(false);

        calls.length = 0;
        session.panelOpen = true;
        expect(calls).toEqual(['bottomBar.add:taknz-weather']);
    });

    it('refreshStatus finding the relay disabled removes the control', async () => {
        const map = new EventedFakeMap();
        setRain('precip');
        await running(map);
        await vi.waitFor(() => expect(map.counters.addLayer).toBe(1));

        reply(200, statusBody({ enabled: false, layers: [] }));
        map.emit('error', { sourceId: 'taknz-wx-precip-src', error: { status: 403 } });

        await vi.waitFor(() => expect(controlEl()).toBeNull());
        expect(map.controls).toEqual([]);
    });

    it('shows the dot only while closed with a layer on', async () => {
        await running();
        const dot = (): HTMLElement | null => document.querySelector('.taknz-wx-dot');
        expect(dot()?.style.display).toBe('none');

        toggleLayer('clouds', true);
        expect(dot()?.style.display).toBe('');

        session.panelOpen = true;
        expect(dot()?.style.display).toBe('none');

        session.panelOpen = false;
        expect(dot()?.style.display).toBe('');

        toggleLayer('clouds', false);
        expect(dot()?.style.display).toBe('none');

        setRain('precip');
        expect(dot()?.style.display).toBe('');
    });

    it('puts the relay health in the tooltip, not in the accessible name', async () => {
        await running();
        expect(controlButton()?.title).toBe('Weather');
        session.health = { kind: 'degraded', since: 0, status: 502 };
        expect(controlButton()?.title).toBe('Weather: Weather service unavailable');
        expect(controlButton()?.getAttribute('aria-label')).toBe('Weather');
        session.health = { kind: 'ok' };
        expect(controlButton()?.title).toBe('Weather');
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
        setRain('precip-global');
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
        ]);
        await vi.waitFor(() => expect(second.layers.filter((l) => l.id.startsWith('taknz-wx-')).map((l) => l.id))
            .toEqual(['taknz-wx-clouds', 'taknz-wx-precip-global']));
        expect(tileUrls(second).some((u) => u.includes('layer=precip-global'))).toBe(true);
    });

    it('re-reads the token on every setTiles', async () => {
        setRain('precip');
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
        setRain('precip');
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
        setRain('precip');
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
        setRain('precip');
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

describe('tile URL failures', () => {
    const wxLayers = (map: EventedFakeMap): string[] => map.layers.filter((l) => l.id.startsWith('taknz-wx-')).map((l) => l.id);
    const warnings = (): string[] => vi.mocked(console.warn).mock.calls.map((c) => c.map(String).join(' '));

    async function running(map: EventedFakeMap) {
        toggleLayer('clouds', true);
        toggleLayer('radars', true);
        const { instance } = await install(map);
        await instance.enable();
        await plugin?.pending;
        await vi.waitFor(() => expect(wxLayers(map)).toEqual(['taknz-wx-clouds', 'taknz-wx-radars']));
        vi.mocked(console.warn).mockClear();
    }

    it('healthy path: no warning, a layer that is switched off is removed', async () => {
        const map = new EventedFakeMap();
        await running(map);
        toggleLayer('clouds', false);
        await vi.waitFor(() => expect(wxLayers(map)).toEqual(['taknz-wx-radars']));
        expect(warnings()).toEqual([]);
    });

    it('a token read failure still removes a layer the user switched off, and keeps the others', async () => {
        const map = new EventedFakeMap();
        await running(map);
        const before = map.sources.get('taknz-wx-radars-src')?.tiles[0];
        host.token.mockImplementation(async () => {
            throw new Error('secret-session-value');
        });

        toggleLayer('clouds', false);
        await vi.waitFor(() => expect(wxLayers(map)).toEqual(['taknz-wx-radars']));
        expect(map.sources.get('taknz-wx-radars-src')?.tiles[0]).toBe(before);

        const messages = warnings();
        expect(messages).toHaveLength(1);
        expect(messages[0]).toMatch(/Could not read the session token \(TokenUnavailableError\)/);
        expect(messages[0]).not.toMatch(/secret-session-value|tok-1|Invalid weather request/);

        // The same failure is reported once per activation
        toggleLayer('radars', false);
        await vi.waitFor(() => expect(wxLayers(map)).toEqual([]));
        expect(warnings()).toHaveLength(1);
    });

    it('a missing token is reported as a token problem', async () => {
        const map = new EventedFakeMap();
        await running(map);
        host.token.mockImplementation(async () => undefined);
        toggleLayer('clouds', false);
        await vi.waitFor(() => expect(wxLayers(map)).toEqual(['taknz-wx-radars']));
        expect(warnings()).toHaveLength(1);
        expect(warnings()[0]).toMatch(/session token/);
    });

    it('an invalid request is reported as such, not as a token problem', async () => {
        const map = new EventedFakeMap();
        await running(map);
        const before = map.sources.get('taknz-wx-radars-src')?.tiles[0];

        // A snapshot that is not a number makes tileRequest throw a RangeError
        session.snapshot = Number.NaN;
        await vi.waitFor(() => expect(warnings()).toHaveLength(1));
        expect(warnings()[0]).toMatch(/Invalid weather request \(RangeError: Invalid snapshot: NaN\)/);
        expect(warnings()[0]).not.toMatch(/session token|tok-1/);
        expect(wxLayers(map)).toEqual(['taknz-wx-clouds', 'taknz-wx-radars']);

        toggleLayer('clouds', false);
        await vi.waitFor(() => expect(wxLayers(map)).toEqual(['taknz-wx-radars']));
        expect(map.sources.get('taknz-wx-radars-src')?.tiles[0]).toBe(before);
        expect(warnings()).toHaveLength(1);
    });

    it('recovers when the token comes back', async () => {
        const map = new EventedFakeMap();
        await running(map);
        host.token.mockImplementation(async () => undefined);
        toggleLayer('clouds', false);
        await vi.waitFor(() => expect(wxLayers(map)).toEqual(['taknz-wx-radars']));

        host.token.mockImplementation(async () => 'tok-9');
        toggleLayer('clouds', true);
        await vi.waitFor(() => expect(wxLayers(map)).toEqual(['taknz-wx-clouds', 'taknz-wx-radars']));
        expect(map.sources.get('taknz-wx-clouds-src')?.tiles[0]).toContain('token=tok-9');
    });
});

describe('timeline', () => {
    const T0 = Date.parse('2026-01-15T00:25:00Z');
    const snapParam = (url: string | undefined): string | null => new URL(url ?? 'https://x/?').searchParams.get('snapshot');
    const forecastParam = (url: string | undefined): string | null => new URL(url ?? 'https://x/?').searchParams.get('forecast');
    const src = (map: EventedFakeMap, slot: string): string | undefined => map.sources.get(`taknz-wx-${slot}-src`)?.tiles[0];

    afterEach(() => {
        vi.useRealTimers();
    });

    /** A status that follows the (fake) clock; `latestOf` shapes the per-layer latest, undefined = old relay. */
    function statusFollowingClock(latestOf?: (computed: number) => Record<string, unknown>): void {
        host.fetch.mockImplementation(async () => {
            const body = statusBody({ serverTime: Math.floor(Date.now() / 1000), snapshot: snapshotAt(Date.now()) });
            if (latestOf) body.latest = latestOf(snapshotAt(Date.now()));
            return jsonResponse(200, body);
        });
    }

    async function start(map = new EventedFakeMap()): Promise<EventedFakeMap> {
        const { instance } = await install(map);
        await instance.enable();
        await plugin?.pending;
        await vi.advanceTimersByTimeAsync(0);
        return map;
    }

    it('anchors the timeline on the newest layer and holds a lagging clouds layer', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(T0);
        const A = snapshotAt(T0);
        statusFollowingClock((c) => latestBody(c, { clouds: c - 600 }));
        toggleLayer('clouds', true);
        toggleLayer('radars', true);
        setRain('precip');
        const map = await start();

        expect(session.snapshot).toBe(A);
        expect(session.latest).toEqual({ precip: A, 'precip-global': A, clouds: A - 600, radars: A });
        expect(snapParam(src(map, 'clouds'))).toBe(String(A));
        expect(snapParam(src(map, 'radars'))).toBe(String(A));
        expect(snapParam(src(map, 'precip'))).toBe(String(A));

        setFrame(-1);
        await vi.advanceTimersByTimeAsync(0);
        expect(snapParam(src(map, 'clouds'))).toBe(String(A - 600));
        expect(snapParam(src(map, 'precip'))).toBe(String(A - 600));
        expect(forecastParam(src(map, 'precip'))).toBe('0');

        setFrame(3);
        await vi.advanceTimersByTimeAsync(0);
        expect(snapParam(src(map, 'clouds'))).toBe(String(A));
        expect(snapParam(src(map, 'precip'))).toBe(String(A));
        expect(forecastParam(src(map, 'precip'))).toBe('30');
    });

    it('the anchor is the newest latest, not the status snapshot', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(T0);
        const A = snapshotAt(T0);
        statusFollowingClock((c) => latestBody(c - 600));
        toggleLayer('radars', true);
        const map = await start();
        expect(session.snapshot).toBe(A - 600);
        expect(snapParam(src(map, 'radars'))).toBe(String(A - 600));
    });

    it('an old relay without latest keeps working with the status snapshot', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(T0);
        statusFollowingClock();
        toggleLayer('clouds', true);
        setRain('precip');
        const map = await start();
        expect(session.latest).toEqual({});
        expect(session.snapshot).toBe(snapshotAt(T0));
        expect(snapParam(src(map, 'clouds'))).toBe(String(snapshotAt(T0)));
        setFrame(6);
        await vi.advanceTimersByTimeAsync(0);
        expect(snapParam(src(map, 'precip'))).toBe(String(snapshotAt(T0)));
        expect(forecastParam(src(map, 'precip'))).toBe('60');
    });

    it('a new 10-minute boundary fetches the status again and moves the anchor', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(T0);
        vi.spyOn(Math, 'random').mockReturnValue(0);
        statusFollowingClock((c) => latestBody(c));
        toggleLayer('clouds', true);
        const map = await start();
        const first = snapshotAt(T0);
        expect(snapParam(src(map, 'clouds'))).toBe(String(first));
        const calls = host.fetch.mock.calls.length;

        vi.setSystemTime(T0 + 6 * 60_000);
        await vi.advanceTimersByTimeAsync(30_000);
        await vi.advanceTimersByTimeAsync(100);

        expect(host.fetch.mock.calls.length).toBeGreaterThan(calls);
        expect(session.snapshot).toBe(first + 600);
        expect(session.latest.clouds).toBe(first + 600);
        expect(snapParam(src(map, 'clouds'))).toBe(String(first + 600));
    });

    it('falls back to the computed snapshot when the status cannot be fetched at the boundary', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(T0);
        vi.spyOn(Math, 'random').mockReturnValue(0);
        statusFollowingClock((c) => latestBody(c, { clouds: c - 600 }));
        toggleLayer('clouds', true);
        const map = await start();
        const first = snapshotAt(T0);
        expect(session.latest.clouds).toBe(first - 600);

        host.fetch.mockImplementation(async () => jsonResponse(500));
        vi.setSystemTime(T0 + 6 * 60_000);
        await vi.advanceTimersByTimeAsync(30_000);
        await vi.advanceTimersByTimeAsync(100);

        expect(session.latest).toEqual({});
        expect(session.snapshot).toBe(first + 600);
        expect(snapParam(src(map, 'clouds'))).toBe(String(first + 600));
    });

    it('the panel always opens and closes on Now', async () => {
        setRain('precip');
        await (async () => {
            const { instance } = await install();
            await instance.enable();
            await plugin?.pending;
        })();
        setFrame(-3);
        session.panelOpen = true;
        expect(session.frame).toBe(0);
        setFrame(6);
        session.panelOpen = false;
        expect(session.frame).toBe(0);
        setFrame(-12);
        session.panelOpen = true;
        expect(session.frame).toBe(0);
    });

    it('switching Rain off while on a forecast frame returns to Now, a past frame stays', async () => {
        setRain('precip');
        toggleLayer('clouds', true);
        const { instance } = await install();
        await instance.enable();
        await plugin?.pending;
        setFrame(6);
        settings.precipRegional = false;
        expect(session.frame).toBe(0);
        settings.precipRegional = true;
        setFrame(-4);
        settings.precipRegional = false;
        expect(session.frame).toBe(-4);
    });
    it('the forecast frame survives while either Rain layer is on and ends with the last one', async () => {
        setRain('both');
        const { instance } = await install();
        await instance.enable();
        await plugin?.pending;
        setFrame(6);
        settings.precipRegional = false;
        expect(session.frame).toBe(6);
        settings.precipRegional = true;
        settings.precipGlobal = false;
        expect(session.frame).toBe(6);
        settings.precipRegional = false;
        expect(session.frame).toBe(0);
    });
    it('both Rain layers on are two sources with their own layer parameter', async () => {
        setRain('both');
        const map = new EventedFakeMap();
        const { instance } = await install(map);
        await instance.enable();
        await plugin?.pending;
        await vi.waitFor(() => expect(map.layers.filter((l) => l.id.startsWith('taknz-wx-'))).toHaveLength(2));
        expect(map.layers.filter((l) => l.id.startsWith('taknz-wx-')).map((l) => l.id)).toEqual(['taknz-wx-precip-global', 'taknz-wx-precip']);
        expect(new URL(map.sources.get('taknz-wx-precip-src')?.tiles[0] ?? 'x:').searchParams.get('layer')).toBe('precip');
        expect(new URL(map.sources.get('taknz-wx-precip-global-src')?.tiles[0] ?? 'x:').searchParams.get('layer')).toBe('precip-global');
    });

    describe('Escape', () => {
        const escape = (init: KeyboardEventInit = {}): void => {
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true, ...init }));
        };
        async function open() {
            const fake = await install();
            await fake.instance.enable();
            await plugin?.pending;
            controlButton()?.click();
            expect(session.panelOpen).toBe(true);
            return fake;
        }

        it('closes the panel at document level and returns focus to the weather button', async () => {
            await open();
            const outside = document.createElement('input');
            document.body.append(outside);
            outside.focus();
            escape();
            expect(session.panelOpen).toBe(false);
            await vi.waitFor(() => expect(document.activeElement).toBe(controlButton()));
        });

        it('ignores other keys and events that were already handled', async () => {
            await open();
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
            expect(session.panelOpen).toBe(true);
            const handled = (e: Event): void => e.preventDefault();
            window.addEventListener('keydown', handled, true);
            escape();
            window.removeEventListener('keydown', handled, true);
            expect(session.panelOpen).toBe(true);
        });

        it('is only listening while the panel is open', async () => {
            const add = vi.spyOn(document, 'addEventListener');
            const remove = vi.spyOn(document, 'removeEventListener');
            const keydowns = (spy: typeof add): number => spy.mock.calls.filter((c) => c[0] === 'keydown').length;
            const fake = await install();
            await fake.instance.enable();
            await plugin?.pending;
            expect(keydowns(add)).toBe(0);

            session.panelOpen = true;
            expect(keydowns(add)).toBe(1);
            session.panelOpen = false;
            expect(keydowns(remove)).toBe(1);
            session.panelOpen = true;
            expect(keydowns(add)).toBe(2);
            session.panelOpen = true;
            expect(keydowns(add)).toBe(2);
        });

        it('is gone after disable()', async () => {
            const remove = vi.spyOn(document, 'removeEventListener');
            const { instance } = await open();
            await instance.disable();
            expect(remove.mock.calls.filter((c) => c[0] === 'keydown')).toHaveLength(1);
            session.panelOpen = true;
            escape();
            expect(session.panelOpen).toBe(true);
            session.panelOpen = false;
        });
    });
});
