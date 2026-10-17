import type { App } from 'vue';
import { h, watch } from 'vue';
import type { PluginAPI, PluginInstance } from '@tak-ps/cloudtak';
import type { LayerSlot, RelayStatus } from './lib/types.ts';
import MenuTemplate from './lib/MenuTemplate.vue';
import WeatherBar from './lib/WeatherBar.vue';
import WeatherSettings from './lib/WeatherSettings.vue';
import { IconWeather } from './lib/icon.ts';
import { host } from './lib/host.ts';
import { BOTTOM_KEY, MENU_KEY, ROUTE_NAME, ROUTE_PATH } from './lib/constants.ts';
import { fetchStatus, tileTemplate } from './lib/relay-client.ts';
import type { StatusReason } from './lib/relay-client.ts';
import { LayerStack, SLOT_ORDER, computeDesired, requestsFor } from './lib/layers.ts';
import type { MapLike } from './lib/layers.ts';
import { HealthMonitor } from './lib/health.ts';
import type { MapErrorLike } from './lib/health.ts';
import { session, setFrame, settings } from './lib/state.ts';
import { applyServerTime, clock, rolloverJitterMs, snapshotAt } from './lib/time.ts';
import { exposeDebug } from './lib/debug.ts';

const TICK_MS = 30_000;
const STATUS_REFRESH_MS = 10 * 60_000;
const STATUS_MIN_GAP_MS = 30_000;
const IDLE_THROTTLE_MS = 2000;

type Listener = (e: unknown) => void;

interface EventedMap {
    on(type: string, fn: Listener): unknown;
    off(type: string, fn: Listener): unknown;
}

/** Everything one successful activation registered, so teardown can undo exactly that. */
interface Activation {
    gen: number;
    dead: boolean;
    /** Bumped by every sync and by teardown; a result with an older number is discarded. */
    seq: number;
    map?: MapLike;
    stack?: LayerStack;
    monitor: HealthMonitor;
    /** Tile URLs currently on the map, per slot. */
    applied: Partial<Record<LayerSlot, string>>;
    /** A tile-URL change was held back because the relay is unhealthy. */
    queued: boolean;
    tokenWarned: boolean;
    lastStatusAt: number;
    lastIdleAt: number;
    rollover?: ReturnType<typeof setTimeout>;
    intervals: ReturnType<typeof setInterval>[];
    stops: (() => void)[];
    registered: { route: boolean; menu: boolean; bar: boolean };
}

export default class WeatherPlugin implements PluginInstance {
    api: PluginAPI;
    generation = 0;
    /** The activation started by the latest enable(). Never rejects. */
    pending: Promise<void> = Promise.resolve();
    private active: Activation | null = null;

    constructor(api: PluginAPI) {
        this.api = api;
    }

    static async install(app: App, api: PluginAPI): Promise<PluginInstance> {
        void app;
        return new WeatherPlugin(api);
    }

    /**
     * CloudTAK awaits enable() of every plugin in turn, so this only starts the
     * activation and returns without waiting for the network.
     */
    async enable(): Promise<void> {
        this.generation++;
        this.teardown();
        this.pending = this.activate(this.generation);
    }

    async disable(): Promise<void> {
        this.generation++;
        this.teardown();
    }

    private async activate(gen: number): Promise<void> {
        try {
            const { status, reason } = await fetchStatus(host);
            if (gen !== this.generation) return;

            if (reason !== 'ok' || !status) {
                this.logInactive(reason);
                return;
            }

            this.build(gen, status);
        } catch (err) {
            console.error('[weather] Could not start the weather plugin', err);
            if (gen === this.generation) this.teardown();
        }
    }

    private logInactive(reason: StatusReason): void {
        if (reason === 'not-found') {
            console.info('[weather] This server has no weather relay; plugin not active');
        } else if (reason === 'disabled') {
            console.info('[weather] Weather is disabled on this server; plugin not active');
        } else {
            console.warn(`[weather] Weather status check failed (${reason}); plugin not active`);
        }
    }

    /** Register everything. Runs synchronously so a disable() cannot interleave. */
    private build(gen: number, status: RelayStatus): void {
        const act: Activation = {
            gen,
            dead: false,
            seq: 0,
            monitor: new HealthMonitor({
                onChange: (state) => {
                    session.health = state;
                },
            }),
            applied: {},
            queued: false,
            tokenWarned: false,
            lastStatusAt: Date.now(),
            lastIdleAt: 0,
            intervals: [],
            stops: [],
            registered: { route: false, menu: false, bar: false },
        };
        this.active = act;

        try {
            applyServerTime(status.serverTime);
            session.status = status;
            session.snapshot = snapshotAt(clock.now());
            session.health = { kind: 'ok' };
            session.panelOpen = false;
            setFrame(0);

            this.api.routes.add({
                path: ROUTE_PATH,
                name: ROUTE_NAME,
                component: {
                    render: () => h(MenuTemplate, { name: 'Weather' }, {
                        default: () => h(WeatherSettings),
                    }),
                },
            }, 'home-menu');
            act.registered.route = true;

            this.api.menu.add({
                key: MENU_KEY,
                label: 'Weather',
                route: ROUTE_NAME,
                tooltip: 'Weather',
                description: 'Rain, radar and cloud layers with forecast',
                icon: IconWeather,
            });
            act.registered.menu = true;

            this.api.bottomBar.add({ key: BOTTOM_KEY, component: WeatherBar });
            act.registered.bar = true;

            const map = this.api.map as unknown as MapLike & Partial<EventedMap>;
            act.map = map;
            act.stack = new LayerStack(map);

            this.listen(act, map);
            this.start(act);

            act.stops.push(exposeDebug({
                map,
                stack: act.stack,
                onClockChange: () => this.tick(act),
            }));

            void this.sync(act);
        } catch (err) {
            console.error('[weather] Could not start the weather plugin', err);
            this.teardown();
        }
    }

    private listen(act: Activation, map: Partial<EventedMap>): void {
        if (typeof map.on !== 'function' || typeof map.off !== 'function') return;
        const evented = map as EventedMap;

        const onError: Listener = (e) => {
            const action = act.monitor.onMapError(e as MapErrorLike);
            if (action === 'refresh-token') void this.sync(act, true);
            else if (action === 'refetch-status') void this.refreshStatus(act, true);
        };
        const onSourceData: Listener = (e) => {
            const ev = e as { sourceId?: unknown; tile?: unknown };
            if (ev.tile && typeof ev.sourceId === 'string') act.monitor.onTileLoaded(ev.sourceId);
        };
        const onIdle: Listener = () => {
            const now = Date.now();
            if (act.dead || now - act.lastIdleAt < IDLE_THROTTLE_MS) return;
            act.lastIdleAt = now;
            try {
                act.stack?.ensureOrder();
            } catch (err) {
                console.warn('[weather] Could not restore the layer order', err);
            }
        };

        for (const [type, fn] of [['error', onError], ['sourcedata', onSourceData], ['idle', onIdle]] as const) {
            evented.on(type, fn);
            act.stops.push(() => {
                try {
                    evented.off(type, fn);
                } catch {
                    // The map is already gone.
                }
            });
        }
    }

    private start(act: Activation): void {
        act.stops.push(watch(
            [settings, () => session.frame],
            () => {
                act.monitor.noteUserAction();
                void this.sync(act);
            },
            { deep: true }
        ));
        act.stops.push(watch(() => session.snapshot, () => {
            void this.sync(act);
        }));

        act.intervals.push(setInterval(() => this.tick(act), TICK_MS));
        act.intervals.push(setInterval(() => void this.refreshStatus(act, false), STATUS_REFRESH_MS));

        if (typeof document !== 'undefined') {
            const onVisible = (): void => {
                if (document.visibilityState !== 'visible') return;
                void this.refreshStatus(act, false);
                this.tick(act);
            };
            document.addEventListener('visibilitychange', onVisible);
            act.stops.push(() => document.removeEventListener('visibilitychange', onVisible));
        }
    }

    /** Pick up a new 10-minute snapshot (after a random delay) and retry held changes. */
    private tick(act: Activation): void {
        if (act.dead) return;

        if (snapshotAt(clock.now()) !== session.snapshot && act.rollover === undefined) {
            act.rollover = setTimeout(() => {
                act.rollover = undefined;
                if (act.dead) return;
                session.snapshot = snapshotAt(clock.now());
            }, rolloverJitterMs());
        }

        if (act.queued) void this.sync(act);
    }

    private async refreshStatus(act: Activation, force: boolean): Promise<void> {
        if (act.dead) return;
        if (!force && Date.now() - act.lastStatusAt < STATUS_MIN_GAP_MS) return;
        act.lastStatusAt = Date.now();

        const { status, reason } = await fetchStatus(host);
        if (act.dead || this.active !== act) return;

        if (reason === 'ok' && status) {
            applyServerTime(status.serverTime);
            session.status = status;
            this.tick(act);
        } else if (reason === 'disabled' || reason === 'not-found' || reason === 'unsupported') {
            this.logInactive(reason);
            this.teardown();
        }
    }

    /**
     * Bring the map in line with the settings. Tile URLs are rebuilt (with a fresh
     * token) on every call; a result that is not the latest is discarded.
     */
    private async sync(act: Activation, force = false): Promise<void> {
        if (act.dead || !act.stack) return;
        const seq = ++act.seq;

        let tiles: Partial<Record<LayerSlot, string>> = {};
        try {
            const wanted = requestsFor(settings, session);
            for (const slot of SLOT_ORDER) {
                const req = wanted[slot];
                if (req) tiles[slot] = await tileTemplate(host, req);
            }
        } catch {
            if (!act.tokenWarned) {
                act.tokenWarned = true;
                console.warn('[weather] Could not read the session token; weather layers not updated');
            }
            return;
        }

        if (act.dead || seq !== act.seq || !act.stack) return;

        const changed = SLOT_ORDER.some((s) => tiles[s] !== undefined && tiles[s] !== act.applied[s]);
        if (changed && !force && !act.monitor.gate()) {
            // Unhealthy relay: keep the URLs on the map, still apply removals and opacity.
            const held: Partial<Record<LayerSlot, string>> = {};
            for (const s of SLOT_ORDER) {
                const old = act.applied[s];
                if (tiles[s] !== undefined && old !== undefined) held[s] = old;
            }
            tiles = held;
            act.queued = true;
        } else {
            act.queued = false;
        }

        try {
            act.stack.sync(computeDesired(settings, session, tiles));
            act.applied = { ...tiles };
        } catch (err) {
            console.error('[weather] Could not update the weather layers', err);
        }
    }

    /**
     * Undo the active registration. Idempotent; every access to the app (map, menu,
     * router) is separate so one failure, e.g. a destroyed map, cannot skip the rest.
     */
    private teardown(): void {
        const act = this.active;
        this.active = null;
        if (!act) return;

        act.dead = true;
        act.seq++;
        for (const timer of act.intervals) clearInterval(timer);
        act.intervals = [];
        if (act.rollover !== undefined) clearTimeout(act.rollover);
        act.rollover = undefined;
        for (const stop of act.stops) {
            try {
                stop();
            } catch {
                // Nothing left to undo.
            }
        }
        act.stops = [];

        try {
            act.stack?.removeAll();
        } catch {
            // The map is gone, so are the layers.
        }
        if (act.registered.bar) {
            try {
                this.api.bottomBar.remove(BOTTOM_KEY);
            } catch {
                // Already removed.
            }
        }
        if (act.registered.menu) {
            try {
                this.api.menu.remove(MENU_KEY);
            } catch {
                // Already removed.
            }
        }
        if (act.registered.route) {
            try {
                this.api.router.removeRoute(ROUTE_NAME);
            } catch {
                // Already removed.
            }
        }

        session.panelOpen = false;
        session.draftFrame = null;
        session.health = { kind: 'ok' };
    }
}
