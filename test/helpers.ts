import { vi } from 'vitest';
import type { PluginAPI } from '@tak-ps/cloudtak';
import type { Host } from '../lib/types.ts';
import type { ControlMapLike, IControlLike } from '../lib/control.ts';
import { FakeMap } from './fake-map.ts';
import { toggleLayer } from '../lib/state.ts';

export { FakeMap };

type Listener = (e: unknown) => void;

/** FakeMap plus the MapLibre event API (on/off/emit). */
export class EventedFakeMap extends FakeMap {
    handlers = new Map<string, Set<Listener>>();
    controls: { control: IControlLike; position: string }[] = [];
    /** `.map-shell > div(map container) > .maplibregl-ctrl-top-left`, as in CloudTAK. */
    shell = document.createElement('div');
    container = document.createElement('div');
    topLeft = document.createElement('div');

    constructor(...args: ConstructorParameters<typeof FakeMap>) {
        super(...args);
        this.shell.className = 'map-shell';
        this.topLeft.className = 'maplibregl-ctrl-top-left';
        this.container.append(this.topLeft);
        this.shell.append(this.container);
        document.body.append(this.shell);
    }

    getContainer(): HTMLElement {
        return this.container;
    }

    /** Like MapLibre: onAdd() first, then the returned element is appended. */
    addControl(control: IControlLike, position = 'top-right'): this {
        const el = control.onAdd(this as unknown as ControlMapLike);
        this.topLeft.append(el);
        this.controls.push({ control, position });
        return this;
    }

    removeControl(control: IControlLike): this {
        control.onRemove(this as unknown as ControlMapLike);
        this.controls = this.controls.filter((c) => c.control !== control);
        return this;
    }

    /** Drop the fixture from the document. */
    dispose(): void {
        this.shell.remove();
    }

    on(type: string, fn: Listener): this {
        if (!this.handlers.has(type)) this.handlers.set(type, new Set());
        this.handlers.get(type)?.add(fn);
        return this;
    }

    off(type: string, fn: Listener): this {
        this.handlers.get(type)?.delete(fn);
        return this;
    }

    emit(type: string, event: unknown = {}): void {
        for (const fn of [...(this.handlers.get(type) ?? [])]) fn(event);
    }

    listenerCount(): number {
        return [...this.handlers.values()].reduce((n, set) => n + set.size, 0);
    }
}

/** A status as an older relay sends it (no `latest`); pass `latest` in `over` for a newer one. */
export function statusBody(over: Record<string, unknown> = {}): Record<string, unknown> {
    const now = Math.floor(Date.now() / 1000);
    return {
        apiVersion: 1,
        enabled: true,
        serverTime: now,
        snapshot: Math.floor(now / 600) * 600 - 600,
        layers: ['precip', 'precip-global', 'clouds', 'radars'],
        ...over,
    };
}

/** The relay's per-layer `latest` object (newest snapshot per layer), as sent by /status. */
export function latestBody(
    snapshot: number,
    over: Partial<Record<'precip' | 'precip-global' | 'clouds' | 'radars', number>> = {}
): Record<string, { snapshot: number; source: 'rainbow' }> {
    const out: Record<string, { snapshot: number; source: 'rainbow' }> = {};
    for (const layer of ['precip', 'precip-global', 'clouds', 'radars'] as const) {
        out[layer] = { snapshot: over[layer] ?? snapshot, source: 'rainbow' };
    }
    return out;
}
export function jsonResponse(status: number, body?: unknown): Response {
    return {
        status,
        ok: status >= 200 && status < 300,
        json: () => Promise.resolve(body),
    } as unknown as Response;
}

export interface FakeHost extends Host {
    token: ReturnType<typeof vi.fn<() => Promise<string | undefined>>>;
    fetch: ReturnType<typeof vi.fn<(input: string, init?: RequestInit) => Promise<Response>>>;
}

/** A Host whose status endpoint answers `reply` (a Response, or a function giving a promise). */
export function makeFakeHost(reply: () => Promise<Response> = () => Promise.resolve(jsonResponse(200, statusBody()))): FakeHost {
    return {
        origin: () => 'https://cot.test',
        token: vi.fn(async () => 'tok-1'),
        fetch: vi.fn(async () => reply()),
    };
}

export function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
    let resolve!: (v: T) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

export interface FakeApi {
    api: PluginAPI;
    calls: string[];
    /** The items passed to menu.add. */
    menuItems: { key: string; label?: string; tooltip?: string }[];
    /** The route objects passed to routes.add. */
    routes: { name?: unknown; component?: { render: () => unknown } }[];
    /** Swap the map `api.map` returns, or an Error to make `api.map` throw. */
    setMap(map: EventedFakeMap | Error): void;
}

/** Records every menu / route / bottom-bar / router call as a string. */
export function makeFakeApi(initial: EventedFakeMap | Error = new EventedFakeMap()): FakeApi {
    const calls: string[] = [];
    const menuItems: FakeApi['menuItems'] = [];
    const routes: FakeApi['routes'] = [];
    let current: EventedFakeMap | Error = initial;

    const api = {
        routes: {
            add: (route: FakeApi['routes'][number], parent?: string) => {
                routes.push(route);
                calls.push(`routes.add:${String(route.name)}:${parent}`);
            },
        },
        menu: {
            add: (item: FakeApi['menuItems'][number]) => {
                menuItems.push(item);
                calls.push(`menu.add:${item.key}`);
            },
            remove: (key: string) => {
                calls.push(`menu.remove:${key}`);
            },
        },
        bottomBar: {
            add: (item: { key: string }) => {
                calls.push(`bottomBar.add:${item.key}`);
            },
            remove: (key: string) => {
                calls.push(`bottomBar.remove:${key}`);
            },
        },
        router: {
            removeRoute: (name: string) => {
                calls.push(`router.removeRoute:${name}`);
            },
        },
        get map(): EventedFakeMap {
            if (current instanceof Error) throw current;
            return current;
        },
    };

    return {
        api: api as unknown as PluginAPI,
        calls,
        menuItems,
        routes,
        setMap: (map) => {
            current = map;
        },
    };
}

/** Switch the two Rain layers: Regional only, Global only, both or neither. */
export function setRain(mode: 'none' | 'precip' | 'precip-global' | 'both'): void {
    toggleLayer('precipRegional', mode === 'precip' || mode === 'both');
    toggleLayer('precipGlobal', mode === 'precip-global' || mode === 'both');
}
