import type { App } from 'vue';
import { h, nextTick, watch } from 'vue';
import type { PluginAPI, PluginInstance } from '@tak-ps/cloudtak';
import type { LayerSlot, RelayStatus } from './lib/types.ts';
import MenuTemplate from './lib/MenuTemplate.vue';
import WeatherBar from './lib/WeatherBar.vue';
import WeatherSettings from './lib/WeatherSettings.vue';
import { IconWeather } from './lib/icon.ts';
import { WeatherControl, focusWeatherControl } from './lib/control.ts';
import type { ControlHost } from './lib/control.ts';
import { host } from './lib/host.ts';
import { BOTTOM_KEY, MENU_KEY, ROUTE_NAME, ROUTE_PATH } from './lib/constants.ts';
import { TokenUnavailableError, fetchStatus, tileTemplate } from './lib/relay-client.ts';
import type { StatusReason } from './lib/relay-client.ts';
import { LayerStack, SLOT_ORDER, computeDesired, isSelected, requestFor } from './lib/layers.ts';
import type { MapLike } from './lib/layers.ts';
import { HealthMonitor, healthMessage } from './lib/health.ts';
import type { MapErrorLike } from './lib/health.ts';
import { rainOn, session, setFrame, settings } from './lib/state.ts';
import { anchorFrom, applyServerTime, clock, rolloverJitterMs, snapshotAt, validLatest } from './lib/time.ts';
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
    map?: MapLike & Partial<ControlHost>;
    control?: WeatherControl;
    stack?: LayerStack;
    monitor: HealthMonitor;
    /** Tile URLs currently on the map, per slot. */
    applied: Partial<Record<LayerSlot, string>>;
    /** A tile-URL change was held back because the relay is unhealthy. */
    queued: boolean;
    /** Kinds of tile-URL failures already reported, so each is logged once per activation. */
    warned: Set<string>;
    lastStatusAt: number;
    lastIdleAt: number;
    /** The computed snapshot the timeline was last built for; a change starts a rollover. */
    boundary: number;
    /** Document-level Escape handler, present while the panel is open. */
    onEscape?: (e: KeyboardEvent) => void;
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
            warned: new Set(),
            lastStatusAt: Date.now(),
            lastIdleAt: 0,
            boundary: 0,
            intervals: [],
            stops: [],
            registered: { route: false, menu: false, bar: false },
        };
        this.active = act;

        try {
            this.applyStatus(act, status);
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

            const map = this.api.map as unknown as MapLike & Partial<EventedMap> & ControlHost;
            act.map = map;

            // The toggle is a map control. MapLibre appends its element only after onAdd()
            // returns, so place() has to run after addControl() (see WeatherControl).
            const control = new WeatherControl({
                onToggle: () => {
                    session.panelOpen = !session.panelOpen;
                },
            });
            act.control = control;
            map.addControl(control, 'top-left');
            control.place();

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
        act.stops.push(watch(() => session.panelOpen, (open) => this.setBar(act, open), { flush: 'sync' }));
        act.stops.push(watch(
            [() => settings.clouds, () => settings.radars, () => settings.precipRegional, () => settings.precipGlobal, () => session.panelOpen, () => session.health],
            () => this.refreshControl(act),
            { flush: 'sync' }
        ));
        this.refreshControl(act);

        act.stops.push(watch(
            [settings, () => session.frame],
            () => {
                act.monitor.noteUserAction();
                void this.sync(act);
            },
            { deep: true }
        ));
        act.stops.push(watch([() => session.snapshot, () => session.latest], () => {
            void this.sync(act);
        }));
        // Without Rain there is no forecast: leave the forecast frames.
        act.stops.push(watch(() => rainOn(settings), (on) => {
            if (!on && session.frame > 0) setFrame(0);
        }, { flush: 'sync' }));

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

    /**
     * The bottom bar item exists only while the panel is open. The panel always opens
     * and closes on Now, and Escape closes it only while it is open.
     */
    private setBar(act: Activation, open: boolean): void {
        if (act.dead || open === act.registered.bar) return;
        try {
            if (open) this.api.bottomBar.add({ key: BOTTOM_KEY, component: WeatherBar });
            else this.api.bottomBar.remove(BOTTOM_KEY);
            act.registered.bar = open;
        } catch (err) {
            console.warn('[weather] Could not update the weather bar', err);
        }
        if (act.registered.bar !== open) return;

        setFrame(0);
        if (open) this.addEscape(act);
        else this.removeEscape(act);
    }

    private addEscape(act: Activation): void {
        if (act.onEscape || typeof document === 'undefined') return;
        const onEscape = (e: KeyboardEvent): void => {
            if (e.key !== 'Escape' || e.defaultPrevented || act.dead) return;
            session.panelOpen = false;
            void nextTick().then(() => focusWeatherControl());
        };
        act.onEscape = onEscape;
        document.addEventListener('keydown', onEscape);
    }

    private removeEscape(act: Activation): void {
        if (!act.onEscape) return;
        if (typeof document !== 'undefined') document.removeEventListener('keydown', act.onEscape);
        act.onEscape = undefined;
    }

    /** Keep the control's pressed state, dot and tooltip in line with the session. */
    private refreshControl(act: Activation): void {
        const control = act.control;
        if (act.dead || !control) return;
        const open = session.panelOpen;
        const anyLayer = settings.clouds || settings.radars || rainOn(settings);
        const message = healthMessage(session.health);
        control.setOpen(open);
        control.setActive(!open && anyLayer);
        control.setTitle(message ? `Weather: ${message}` : 'Weather');
    }

    /** Take over a status: server clock, per-layer latest and the anchor of the timeline. */
    private applyStatus(act: Activation, status: RelayStatus): void {
        applyServerTime(status.serverTime);
        const nowMs = clock.now();
        const latest = validLatest(status.latest, nowMs);
        session.status = status;
        // Keep the object when nothing changed, so watchers do not fire for nothing.
        if (JSON.stringify(latest) !== JSON.stringify(session.latest)) session.latest = latest;
        session.snapshot = anchorFrom(latest, status.snapshot, nowMs);
        act.boundary = snapshotAt(nowMs);
    }

    /** Pick up a new 10-minute snapshot (after a random delay) and retry held changes. */
    private tick(act: Activation): void {
        if (act.dead) return;

        if (snapshotAt(clock.now()) !== act.boundary && act.rollover === undefined) {
            act.rollover = setTimeout(() => {
                act.rollover = undefined;
                if (act.dead) return;
                void this.rolloverRefresh(act);
            }, rolloverJitterMs());
        }

        if (act.queued) void this.sync(act);
    }

    /**
     * A new 10-minute boundary: ask for the per-layer latest again. When the relay cannot
     * answer, fall back to the computed snapshot and no per-layer latest.
     */
    private async rolloverRefresh(act: Activation): Promise<void> {
        const ok = await this.refreshStatus(act, true);
        if (ok || act.dead || this.active !== act) return;
        const nowMs = clock.now();
        act.boundary = snapshotAt(nowMs);
        if (Object.keys(session.latest).length > 0) session.latest = {};
        session.snapshot = snapshotAt(nowMs);
    }

    /** True when a fresh, usable status was applied. */
    private async refreshStatus(act: Activation, force: boolean): Promise<boolean> {
        if (act.dead) return false;
        if (!force && Date.now() - act.lastStatusAt < STATUS_MIN_GAP_MS) return false;
        act.lastStatusAt = Date.now();

        const { status, reason } = await fetchStatus(host);
        if (act.dead || this.active !== act) return false;

        if (reason === 'ok' && status) {
            this.applyStatus(act, status);
            this.tick(act);
            return true;
        }
        if (reason === 'disabled' || reason === 'not-found' || reason === 'unsupported') {
            this.logInactive(reason);
            this.teardown();
        }
        return false;
    }

    /**
     * Bring the map in line with the settings. Tile URLs are rebuilt (with a fresh
     * token) on every call; a result that is not the latest is discarded.
     */
    private async sync(act: Activation, force = false): Promise<void> {
        if (act.dead || !act.stack) return;
        const seq = ++act.seq;

        let tiles: Partial<Record<LayerSlot, string>> = {};
        // A slot whose URL cannot be built keeps what is on the map; every other slot is
        // still applied, so a layer the user switched off is removed regardless.
        const failed: Partial<Record<LayerSlot, unknown>> = {};
        for (const slot of SLOT_ORDER) {
            try {
                const req = requestFor(slot, settings, session);
                if (req) tiles[slot] = await tileTemplate(host, req);
            } catch (err) {
                failed[slot] = err;
            }
        }

        if (act.dead || seq !== act.seq || !act.stack) return;

        for (const slot of SLOT_ORDER) {
            if (!(slot in failed)) continue;
            this.warnOnce(act, failed[slot]);
            const old = act.applied[slot];
            if (old !== undefined && isSelected(slot, settings)) tiles[slot] = old;
        }

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

    /** Say once per activation why the tile URLs could not be built. Never prints a token. */
    private warnOnce(act: Activation, err: unknown): void {
        const name = err instanceof Error ? err.name : typeof err;
        if (act.warned.has(name)) return;
        act.warned.add(name);

        if (err instanceof TokenUnavailableError) {
            console.warn(`[weather] Could not read the session token (${name}); weather layers not updated`);
        } else if (err instanceof RangeError) {
            console.warn(`[weather] Invalid weather request (${name}: ${err.message}); the affected layers are not updated`);
        } else {
            console.warn(`[weather] Could not build the weather tile URLs (${name}); the affected layers are not updated`);
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
        this.removeEscape(act);
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
        try {
            if (act.control) act.map?.removeControl?.(act.control);
        } catch {
            // The map is gone, and with it MapLibre's reference to the control.
        }
        act.control?.destroy();
        act.control = undefined;
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
        setFrame(0);
        session.health = { kind: 'ok' };
    }
}
