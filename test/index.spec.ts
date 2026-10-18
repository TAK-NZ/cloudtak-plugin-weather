import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises } from '@vue/test-utils';
import { nextTick } from 'vue';
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
import MenuTemplate from '../lib/MenuTemplate.vue';
import { bindStorage, flushSave, session, setFrame, setPlaying, settings, toggleLayer } from '../lib/state.ts';
import { togglePlay } from '../lib/player.ts';
import { pacing } from '../lib/pacing.ts';
import { HealthMonitor } from '../lib/health.ts';
import { PANEL_CLOSE, PANEL_OPEN } from '../lib/panel-coordinator.ts';
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
    setPlaying(false);
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

    it('names the menu entry and the settings window "Weather Settings"', async () => {
        const { instance, menuItems, routes } = await install(new EventedFakeMap());
        await instance.enable();
        await plugin?.pending;
        expect(menuItems).toHaveLength(1);
        expect(menuItems[0].label).toBe('Weather Settings');
        expect(menuItems[0].tooltip).toBe('Weather Settings');
        const vnode = routes[0].component?.render() as { type: unknown; props: { name: string } };
        expect(vnode.type).toBe(MenuTemplate);
        expect(vnode.props.name).toBe('Weather Settings');
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
        expect(controlButton()?.title).toBe('Weather Controls');
        session.health = { kind: 'degraded', since: 0, status: 502 };
        expect(controlButton()?.title).toBe('Weather Controls: Weather service unavailable');
        expect(controlButton()?.getAttribute('aria-label')).toBe('Weather Controls');
        session.health = { kind: 'ok' };
        expect(controlButton()?.title).toBe('Weather Controls');
    });

    it('names the dot state in the accessible name and the tooltip, with the health message appended', async () => {
        await running();
        const on = 'Weather Controls, layers on, controls hidden';
        toggleLayer('clouds', true);
        expect(controlButton()?.getAttribute('aria-label')).toBe(on);
        expect(controlButton()?.title).toBe(on);
        session.health = { kind: 'degraded', since: 0, status: 502 };
        expect(controlButton()?.title).toBe(`${on}: Weather service unavailable`);
        expect(controlButton()?.getAttribute('aria-label')).toBe(on);
        session.panelOpen = true;
        expect(controlButton()?.getAttribute('aria-label')).toBe('Weather Controls');
        expect(controlButton()?.title).toBe('Weather Controls: Weather service unavailable');
        session.health = { kind: 'ok' };
        session.panelOpen = false;
        expect(controlButton()?.title).toBe(on);
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

    it('anchors the timeline on the newest layer; a lagging clouds layer repeats its frame at Now and is hidden in the forecast', async () => {
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

        setFrame(0);
        await vi.advanceTimersByTimeAsync(0);
        expect(snapParam(src(map, 'clouds'))).toBe(String(A));
        map.resetCounters();
        setFrame(3);
        await vi.advanceTimersByTimeAsync(0);
        // Clouds and Radar keep their layers and their URL, but are not drawn: no tile requests
        expect(snapParam(src(map, 'clouds'))).toBe(String(A));
        expect(snapParam(src(map, 'radars'))).toBe(String(A));
        expect(map.isDrawn('taknz-wx-clouds')).toBe(false);
        expect(map.isDrawn('taknz-wx-radars')).toBe(false);
        expect(map.isDrawn('taknz-wx-precip')).toBe(true);
        expect(map.tilesLog.filter((t) => t.source.includes('clouds') || t.source.includes('radars'))).toEqual([]);
        expect(map.counters.addLayer + map.counters.removeLayer + map.counters.moveLayer).toBe(0);
        expect(snapParam(src(map, 'precip'))).toBe(String(A));
        expect(forecastParam(src(map, 'precip'))).toBe('30');
        // back in the past: the same layers return, nothing is added
        setFrame(-1);
        await vi.advanceTimersByTimeAsync(0);
        expect(snapParam(src(map, 'clouds'))).toBe(String(A - 600));
        expect(map.isDrawn('taknz-wx-clouds')).toBe(true);
        expect(map.isDrawn('taknz-wx-radars')).toBe(true);
        expect(map.counters.addLayer + map.counters.removeLayer + map.counters.moveLayer).toBe(0);
    });
    it('Clouds switched on in a forecast frame stays off until a past frame, then appears', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(T0);
        statusFollowingClock();
        setRain('precip');
        const map = await start();
        setFrame(6);
        await vi.advanceTimersByTimeAsync(0);
        toggleLayer('clouds', true);
        await vi.advanceTimersByTimeAsync(0);
        expect(map.getLayer('taknz-wx-clouds')).toBeUndefined();
        expect(map.sources.has('taknz-wx-clouds-src')).toBe(false);
        setFrame(0);
        await vi.advanceTimersByTimeAsync(0);
        expect(map.getLayer('taknz-wx-clouds')).toBeDefined();
        expect(map.isDrawn('taknz-wx-clouds')).toBe(true);
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

        it('leaves Escape to an open modal dialog', async () => {
            await open();
            const modal = document.createElement('div');
            modal.setAttribute('aria-modal', 'true');
            document.body.append(modal);
            escape();
            expect(session.panelOpen).toBe(true);
            modal.remove();
            escape();
            expect(session.panelOpen).toBe(false);
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

describe('panel contract', () => {
    let events: string[] = [];
    const record = (kind: string) => (e: Event): void => {
        const d = (e as CustomEvent<{ id: string; area: string; by?: string } | null>).detail;
        // Only what weather sends; the test's own foreign events are not recorded.
        if (d?.id !== 'taknz-weather') return;
        events.push(`${kind}:${d.id}:${d.area}${d.by ? `>${d.by}` : ''}`);
    };
    const onOpen = record('open');
    const onClose = record('close');
    const foreignOpen = (id = 'rubber-sheet', extra: object = {}): void => {
        window.dispatchEvent(new CustomEvent(PANEL_OPEN, { detail: { id, area: 'bottom', ...extra } }));
    };
    const dot = (): HTMLElement | null => document.querySelector('.taknz-wx-dot');

    beforeEach(() => {
        events = [];
        window.addEventListener(PANEL_OPEN, onOpen);
        window.addEventListener(PANEL_CLOSE, onClose);
    });
    afterEach(() => {
        window.removeEventListener(PANEL_OPEN, onOpen);
        window.removeEventListener(PANEL_CLOSE, onClose);
    });

    async function running() {
        const fake = await install();
        await fake.instance.enable();
        await plugin?.pending;
        fake.calls.length = 0;
        events = [];
        return fake;
    }

    it('opening the panel dispatches panel-open once', async () => {
        await running();
        session.panelOpen = true;
        session.panelOpen = true;
        expect(events).toEqual(['open:taknz-weather:bottom']);
    });

    it('closing with the button or Escape dispatches panel-close without by', async () => {
        await running();
        controlButton()?.click();
        controlButton()?.click();
        expect(events).toEqual(['open:taknz-weather:bottom', 'close:taknz-weather:bottom']);

        events = [];
        controlButton()?.click();
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
        expect(session.panelOpen).toBe(false);
        expect(events).toEqual(['open:taknz-weather:bottom', 'close:taknz-weather:bottom']);
    });

    it('a panel-open from another plugin closes the open panel and says who it gave way to', async () => {
        const { calls } = await running();
        toggleLayer('clouds', true);
        controlButton()?.click();
        expect(controlButton()?.getAttribute('aria-pressed')).toBe('true');
        expect(dot()?.style.display).toBe('none');
        events = [];
        calls.length = 0;

        foreignOpen();
        expect(session.panelOpen).toBe(false);
        expect(calls).toEqual(['bottomBar.remove:taknz-weather']);
        expect(events).toEqual(['close:taknz-weather:bottom>rubber-sheet']);
        expect(controlButton()?.getAttribute('aria-pressed')).toBe('false');
        expect(dot()?.style.display).toBe('');
        expect(controlButton()?.getAttribute('aria-label')).toBe('Weather Controls, layers on, controls hidden');
        // It does not come back by itself when the other plugin closes.
        window.dispatchEvent(new CustomEvent(PANEL_CLOSE, { detail: { id: 'rubber-sheet', area: 'bottom' } }));
        expect(session.panelOpen).toBe(false);
        expect(calls).toEqual(['bottomBar.remove:taknz-weather']);
    });

    it('a panel-open from another plugin while the panel is closed does nothing', async () => {
        const { calls } = await running();
        foreignOpen();
        expect(session.panelOpen).toBe(false);
        expect(calls).toEqual([]);
        expect(events).toEqual([]);
    });

    it('ignores its own events, other areas and malformed details', async () => {
        const { calls } = await running();
        session.panelOpen = true;
        events = [];
        calls.length = 0;
        foreignOpen('taknz-weather');
        foreignOpen('rubber-sheet', { area: 'top' });
        window.dispatchEvent(new CustomEvent(PANEL_OPEN, { detail: null }));
        window.dispatchEvent(new Event(PANEL_OPEN));
        expect(session.panelOpen).toBe(true);
        expect(calls).toEqual([]);
    });

    it('disable with the panel open dispatches panel-close', async () => {
        const { instance } = await running();
        session.panelOpen = true;
        events = [];
        await instance.disable();
        expect(events).toEqual(['close:taknz-weather:bottom']);
    });

    it('disable with the panel closed dispatches nothing', async () => {
        const { instance } = await running();
        await instance.disable();
        expect(events).toEqual([]);
    });

    it('ignores panel events after disable', async () => {
        const remove = vi.spyOn(window, 'removeEventListener');
        const { instance, calls } = await running();
        session.panelOpen = true;
        await instance.disable();
        const types = remove.mock.calls.map((c) => c[0]);
        expect(types).toContain(PANEL_OPEN);
        expect(types).toContain(PANEL_CLOSE);

        events = [];
        calls.length = 0;
        foreignOpen();
        expect(events).toEqual([]);
        expect(calls).toEqual([]);
    });
});

describe('play', () => {
    const T0 = Date.parse('2026-01-15T00:25:00Z');
    const A = snapshotAt(T0);
    const snapOf = (url: string | undefined): number => Number(new URL(url ?? 'https://x/?').searchParams.get('snapshot'));
    const frameOf = (url: string | undefined): number => (snapOf(url) - A) / 600;

    // The cadence tests below assume the unpaced 700 ms frames; the pacing test turns it on.
    beforeEach(() => {
        pacing.enabled = false;
    });

    afterEach(() => {
        vi.useRealTimers();
        pacing.enabled = true;
    });

    /** What a slot shows and what its hidden buffer loads, from the map. */
    function buffers(map: EventedFakeMap, slot = 'clouds'): { visible?: string; hidden?: string; layers: string[] } {
        const out: { visible?: string; hidden?: string; layers: string[] } = { layers: [] };
        for (const suffix of ['', '-b']) {
            const layer = map.getLayer(`taknz-wx-${slot}${suffix}`);
            if (!layer) continue;
            out.layers.push(layer.id);
            const tiles = map.sources.get(`taknz-wx-${slot}${suffix}-src`)?.tiles[0];
            if (layer.paint?.['raster-opacity'] === 0) out.hidden = tiles;
            else out.visible = tiles;
        }
        return out;
    }

    /** Every weather source is loaded and MapLibre reported progress. */
    function loaded(map: EventedFakeMap): void {
        map.controlLoading();
        for (const id of map.sources.keys()) if (id.startsWith('taknz-wx-')) map.loadedIds.add(id);
        map.emit('render');
        map.emit('render');
    }

    async function begin(prepare: () => void = () => toggleLayer('clouds', true)): Promise<EventedFakeMap> {
        vi.useFakeTimers();
        vi.setSystemTime(T0);
        host.fetch.mockImplementation(async () => jsonResponse(200, {
            ...statusBody({ serverTime: Math.floor(Date.now() / 1000), snapshot: snapshotAt(Date.now()) }),
            latest: latestBody(snapshotAt(Date.now())),
        }));
        prepare();
        // The settings save debounce is a timer of its own; the tests count the plugin's.
        flushSave();
        const map = new EventedFakeMap();
        const { instance } = await install(map);
        await instance.enable();
        await plugin?.pending;
        await vi.advanceTimersByTimeAsync(0);
        return map;
    }

    /** MapLibre renders on: a buffer that was just swapped out may go. */
    const settled = (map: EventedFakeMap): void => {
        for (let i = 0; i < 12; i++) map.emit('render');
    };

    async function step(map: EventedFakeMap, ms = 700): Promise<void> {
        loaded(map);
        await vi.advanceTimersByTimeAsync(ms);
    }

    it('Play shows -12 and loads -11 into the hidden buffer; each step swaps and loads exactly one frame ahead', async () => {
        const map = await begin();
        expect(session.playing).toBe(false);
        togglePlay();
        await vi.advanceTimersByTimeAsync(0);
        expect(session.playing).toBe(true);
        expect(session.frame).toBe(-12);
        expect(frameOf(buffers(map).visible)).toBe(-12);
        expect(frameOf(buffers(map).hidden)).toBe(-11);

        for (let k = -11; k <= 0; k++) {
            await step(map);
            expect(session.frame).toBe(k);
            const b = buffers(map);
            expect(frameOf(b.visible)).toBe(k);
            // the hidden buffer holds the next frame; on Now it holds the restart frame
            if (k < 0) expect(frameOf(b.hidden)).toBe(k + 1);
            else expect(frameOf(b.hidden)).toBe(-12);
        }
        expect(map.counters.moveLayer).toBe(0);
    });

    it('with pacing on, Play waits before it loads the next frame and the shown frame stays', async () => {
        pacing.enabled = true;
        const map = await begin(() => {
            toggleLayer('clouds', true);
            setRain('precip-global');
        });
        togglePlay();
        await vi.advanceTimersByTimeAsync(0);
        // 2 layers x 20 tiles: the first frame and the preload of -11 fit into the burst of 90
        expect(session.frame).toBe(-12);
        expect(frameOf(buffers(map).hidden)).toBe(-11);
        await step(map);
        expect(session.frame).toBe(-11);
        // -10 costs 40 and 10 are left: it waits about 10 s, with -11 on screen and nothing preloading
        expect(frameOf(buffers(map).hidden)).not.toBe(-10);
        await step(map, 6000);
        expect(session.frame).toBe(-11);
        expect(frameOf(buffers(map).hidden)).not.toBe(-10);
        await step(map, 4500);
        expect(frameOf(buffers(map).hidden)).toBe(-10);
        expect(session.frame).toBe(-11);
        await step(map, 100);
        expect(session.frame).toBe(-10);
        expect(map.counters.moveLayer).toBe(0);
    });

    it('holds on Now, then restarts at -12', async () => {
        const map = await begin();
        togglePlay();
        await vi.advanceTimersByTimeAsync(0);
        for (let i = 0; i < 12; i++) await step(map);
        expect(session.frame).toBe(0);
        await step(map, 1199);
        expect(session.frame).toBe(0);
        await step(map, 1);
        expect(session.frame).toBe(-12);
        expect(frameOf(buffers(map).visible)).toBe(-12);
    });

    it('with Include forecast when playing and Rain it runs to +24', async () => {
        const map = await begin(() => {
            setRain('precip');
            settings.playForecast = true;
        });
        togglePlay();
        await vi.advanceTimersByTimeAsync(0);
        for (let i = 0; i < 36; i++) await step(map);
        expect(session.frame).toBe(24);
        expect(new URL(map.sources.get('taknz-wx-precip-src')?.tiles[0] ?? 'https://x/?').searchParams.get('forecast')).toBe('240');
    });

    it('Clouds + Rain Global with the forecast: no Clouds tiles for k > 0, the preload at +24 asks for -12, Clouds return after the wrap', async () => {
        const map = await begin(() => {
            toggleLayer('clouds', true);
            setRain('precip-global');
            settings.playForecast = true;
        });
        togglePlay();
        await vi.advanceTimersByTimeAsync(0);
        for (let i = 0; i < 36; i++) {
            await step(map);
            const k = session.frame;
            const c = buffers(map, 'clouds');
            if (k > 0) {
                // the slot is still in the stack, on its last URL, but not drawn and not preloading
                expect(frameOf(c.visible)).toBeLessThanOrEqual(0);
                expect(map.isDrawn('taknz-wx-clouds')).toBe(false);
                // a leftover buffer from the last swap may wait to settle, but it is not drawn
                if (k < 24) expect(map.isDrawn('taknz-wx-clouds-b')).toBe(false);
                // Rain keeps playing
                expect(new URL(buffers(map, 'precip-global').visible ?? 'https://x/?').searchParams.get('forecast')).toBe(String(k * 10));
            } else {
                expect(map.isDrawn('taknz-wx-clouds')).toBe(true);
            }
        }
        expect(session.frame).toBe(24);
        // at +24 the hidden Clouds buffer loads the first frame after the wrap
        expect(frameOf(buffers(map, 'clouds').hidden)).toBe(-12);
        expect(map.isDrawn('taknz-wx-clouds-b') || map.isDrawn('taknz-wx-clouds')).toBe(true);
        expect(map.counters.moveLayer).toBe(0);
        const adds = map.counters.addLayer;
        await step(map, 1200);
        expect(session.frame).toBe(-12);
        expect(frameOf(buffers(map, 'clouds').visible)).toBe(-12);
        expect(map.counters.addLayer).toBe(adds);
        expect(map.isDrawn('taknz-wx-clouds') || map.isDrawn('taknz-wx-clouds-b')).toBe(true);
    });
    it('Play needs a layer', async () => {
        const map = await begin(() => undefined);
        togglePlay();
        await vi.advanceTimersByTimeAsync(0);
        expect(session.playing).toBe(false);
        expect(map.counters.addLayer).toBe(0);
    });

    it('switching the last layer off ends Play', async () => {
        const map = await begin();
        togglePlay();
        await vi.advanceTimersByTimeAsync(0);
        toggleLayer('clouds', false);
        await vi.advanceTimersByTimeAsync(0);
        expect(session.playing).toBe(false);
        expect(session.preload).toBeNull();
        expect(map.layers.some((l) => l.id.startsWith('taknz-wx-'))).toBe(false);
    });

    it('does not wait forever for tiles that never load', async () => {
        const map = await begin();
        togglePlay();
        await vi.advanceTimersByTimeAsync(0);
        await vi.advanceTimersByTimeAsync(2999);
        expect(session.frame).toBe(-12);
        await vi.advanceTimersByTimeAsync(1);
        expect(session.frame).toBe(-11);
        expect(map.counters.moveLayer).toBe(0);
    });

    describe('user actions', () => {
        it('frame changes made by Play do not count as user actions; a slider move or a toggle does', async () => {
            const noted = vi.spyOn(HealthMonitor.prototype, 'noteUserAction');
            const map = await begin();
            // a relay that is not healthy: this is when a user action earns a retry
            session.health = { kind: 'degraded', since: Date.now() };
            await vi.advanceTimersByTimeAsync(0);
            noted.mockClear();

            togglePlay();
            await nextTick();
            expect(session.playing).toBe(true);
            expect(noted).toHaveBeenCalledTimes(0);
            await vi.advanceTimersByTimeAsync(0);
            expect(noted).toHaveBeenCalledTimes(0);
            for (let i = 0; i < 3; i++) {
                await step(map);
                await nextTick();
            }
            expect(session.frame).toBeGreaterThan(-12);
            expect(noted).toHaveBeenCalledTimes(0);

            togglePlay();
            expect(session.playing).toBe(false);
            setFrame(-3);
            await nextTick();
            expect(noted).toHaveBeenCalledTimes(1);
            toggleLayer('radars', true);
            await nextTick();
            expect(noted).toHaveBeenCalledTimes(2);
        });
    });

    describe('pausing', () => {
        it.each(['dragstart', 'zoomstart', 'rotatestart'])('%s on the map pauses at the current frame', async (type) => {
            const map = await begin();
            togglePlay();
            await vi.advanceTimersByTimeAsync(0);
            await step(map);
            await step(map);
            expect(session.frame).toBe(-10);
            map.emit(type);
            expect(session.playing).toBe(false);
            expect(session.preload).toBeNull();
            await vi.advanceTimersByTimeAsync(0);
            settled(map);
            expect(buffers(map).layers).toHaveLength(1);
            expect(frameOf(buffers(map).visible)).toBe(-10);
            await step(map, 5000);
            expect(session.frame).toBe(-10);
        });

        it('our own setTiles and swaps do not pause it', async () => {
            const map = await begin();
            togglePlay();
            await vi.advanceTimersByTimeAsync(0);
            for (let i = 0; i < 5; i++) await step(map);
            expect(map.counters.setTiles + map.counters.setPaintProperty).toBeGreaterThan(0);
            expect(session.playing).toBe(true);
            expect(session.frame).toBe(-7);
        });

        it('closing the panel pauses', async () => {
            const map = await begin();
            controlButton()?.click();
            expect(session.panelOpen).toBe(true);
            togglePlay();
            await vi.advanceTimersByTimeAsync(0);
            await step(map);
            controlButton()?.click();
            expect(session.panelOpen).toBe(false);
            expect(session.playing).toBe(false);
            expect(session.frame).toBe(0);
        });

        it('a relay 429 suspends Play with the status, drops the preload and resumes by itself after 60 s', async () => {
            const map = await begin();
            togglePlay();
            await vi.advanceTimersByTimeAsync(0);
            await step(map);
            const suspendedAt = Date.now();
            map.emit('error', { sourceId: 'taknz-wx-clouds-b-src', error: { status: 429 } });
            expect(session.health.kind).toBe('limited');
            expect(session.playing).toBe(true);
            expect(session.resumeAt).toBe(suspendedAt + 60_000);
            await vi.advanceTimersByTimeAsync(0);
            settled(map);
            expect(buffers(map).hidden).toBeUndefined();
            const frame = session.frame;
            await vi.advanceTimersByTimeAsync(59_000);
            expect(session.frame).toBe(frame);
            expect(session.resumeAt).not.toBeNull();
            await vi.advanceTimersByTimeAsync(1000);
            expect(session.resumeAt).toBeNull();
            expect(session.playing).toBe(true);
            // resumed on the same frame, loading the next one even though the relay was limited
            expect(frameOf(buffers(map).hidden)).toBe(frame + 1);
            map.emit('sourcedata', { sourceId: 'taknz-wx-clouds-b-src', tile: {} });
            expect(session.health.kind).toBe('ok');
            await step(map);
            expect(session.frame).toBe(frame + 1);
        });

        it('pressing Play during the suspension resumes at once', async () => {
            const map = await begin();
            togglePlay();
            await vi.advanceTimersByTimeAsync(0);
            map.emit('error', { sourceId: 'taknz-wx-clouds-src', error: { status: 429 } });
            expect(session.resumeAt).not.toBeNull();
            togglePlay();
            await vi.advanceTimersByTimeAsync(0);
            expect(session.resumeAt).toBeNull();
            expect(session.playing).toBe(true);
            expect(buffers(map).hidden).toBeDefined();
        });

        it('a 429 right after a resume suspends again', async () => {
            const map = await begin();
            togglePlay();
            await vi.advanceTimersByTimeAsync(0);
            map.emit('error', { sourceId: 'taknz-wx-clouds-src', error: { status: 429 } });
            await vi.advanceTimersByTimeAsync(60_000);
            expect(session.resumeAt).toBeNull();
            map.emit('error', { sourceId: 'taknz-wx-clouds-b-src', error: { status: 429 } });
            expect(session.resumeAt).not.toBeNull();
            expect(session.playing).toBe(true);
        });

        it.each([[502], [401], [403]])('a relay %i ends Play', async (status) => {
            const map = await begin();
            togglePlay();
            await vi.advanceTimersByTimeAsync(0);
            map.emit('error', { sourceId: 'taknz-wx-clouds-src', error: { status } });
            expect(session.playing).toBe(false);
            expect(session.resumeAt).toBeNull();
            await vi.advanceTimersByTimeAsync(120_000);
            expect(session.playing).toBe(false);
        });

        it('errors of other map sources do not touch Play', async () => {
            const map = await begin();
            togglePlay();
            await vi.advanceTimersByTimeAsync(0);
            map.emit('error', { sourceId: 'basemap', error: { status: 429 } });
            expect(session.playing).toBe(true);
            expect(session.resumeAt).toBeNull();
        });
    });

    describe('cleanup', () => {
        it('disable() while playing leaves no timer, listener, source or layer', async () => {
            const map = await begin();
            const timersBefore = vi.getTimerCount();
            expect(timersBefore).toBeGreaterThan(0);
            togglePlay();
            await vi.advanceTimersByTimeAsync(0);
            await step(map);
            await plugin?.disable();
            expect(session.playing).toBe(false);
            expect(session.preload).toBeNull();
            expect(session.resumeAt).toBeNull();
            expect(vi.getTimerCount()).toBe(0);
            expect(map.listenerCount()).toBe(0);
            expect(map.layers.some((l) => l.id.startsWith('taknz-wx-'))).toBe(false);
            expect([...map.sources.keys()].some((id) => id.startsWith('taknz-wx-'))).toBe(false);
            // the button of a closed panel does nothing any more
            togglePlay();
            await vi.advanceTimersByTimeAsync(5000);
            expect(session.playing).toBe(false);
            expect(map.layers.some((l) => l.id.startsWith('taknz-wx-'))).toBe(false);
        });

        it('disable() during a suspension leaves no timer either', async () => {
            const map = await begin();
            togglePlay();
            await vi.advanceTimersByTimeAsync(0);
            map.emit('error', { sourceId: 'taknz-wx-clouds-src', error: { status: 429 } });
            await plugin?.disable();
            expect(vi.getTimerCount()).toBe(0);
            await vi.advanceTimersByTimeAsync(120_000);
            expect(session.playing).toBe(false);
        });

        it('enable and disable twice in a row are harmless while playing', async () => {
            const map = await begin();
            togglePlay();
            await vi.advanceTimersByTimeAsync(0);
            await plugin?.enable();
            await plugin?.pending;
            await vi.advanceTimersByTimeAsync(0);
            expect(session.playing).toBe(false);
            await plugin?.disable();
            await plugin?.disable();
            expect(vi.getTimerCount()).toBe(0);
            expect(map.listenerCount()).toBe(0);
            expect([...map.sources.keys()].some((id) => id.startsWith('taknz-wx-'))).toBe(false);
        });

        it('a map that throws after teardown does not escape', async () => {
            const map = await begin();
            togglePlay();
            await vi.advanceTimersByTimeAsync(0);
            const broken = new Error('map destroyed');
            for (const method of ['getLayer', 'getSource', 'getStyle', 'addLayer', 'removeLayer', 'removeSource', 'setPaintProperty'] as const) {
                (map as unknown as Record<string, unknown>)[method] = () => {
                    throw broken;
                };
            }
            await expect(plugin?.disable()).resolves.toBeUndefined();
            await vi.advanceTimersByTimeAsync(10_000);
            expect(vi.getTimerCount()).toBe(0);
        });
    });
});
