import type { LayerSlot, TileRequest, WeatherSettings } from './types.ts';
import type { Session } from './state.ts';
import { rainOn } from './state.ts';
import { ATTRIBUTION, ID_PREFIX } from './constants.ts';
import { tileRequest } from './tile-url.ts';
import { clampFrame, clock, frameBounds, holdSnapshot, rainFrame } from './time.ts';
import { PreloadTracker } from './preload.ts';
import type { MapEventLike } from './preload.ts';

/** Bottom to top. */
export const SLOT_ORDER: LayerSlot[] = ['clouds', 'precip-global', 'precip', 'radars'];

/**
 * Every slot has up to two raster buffers: buffer 0 (`a`, the original ids) and buffer 1
 * (`b`). Exactly one is visible. The other one is only there while a frame is preloaded.
 */
export type Buf = 0 | 1;

/**
 * Opacity of the buffer that loads the next frame. It stays `visibility: visible`, so
 * MapLibre keeps requesting its tiles; it just draws nothing. The browser check
 * (/tmp/weather-ui-check, H6) confirms MapLibre loads tiles at this opacity.
 */
export const HIDDEN_OPACITY = 0;

/**
 * Renders to wait after a swap before the buffer that was just hidden may be removed.
 * Measured in a real MapLibre (browser check H6): removing a raster layer within about
 * 80 ms of an opacity swap blanks the shown layer for 5 to 6 renders. Retargeting it with
 * setTiles does not, so only a stop of the preload (which removes the buffer) has to wait.
 */
export const SETTLE_RENDERS = 12;

export const bufferLayerId = (s: LayerSlot, buf: Buf): string => `${ID_PREFIX}${s}${buf === 1 ? '-b' : ''}`;
export const bufferSourceId = (s: LayerSlot, buf: Buf): string => `${ID_PREFIX}${s}${buf === 1 ? '-b' : ''}-src`;

/**
 * Ids of the `a` buffer. One argument on purpose, so `slots.map(layerId)` cannot pass an
 * array index as the buffer.
 */
export const layerId = (s: LayerSlot): string => bufferLayerId(s, 0);
export const sourceId = (s: LayerSlot): string => bufferSourceId(s, 0);

const MAX_ZOOM: Record<LayerSlot, number> = { clouds: 7, 'precip-global': 9, precip: 9, radars: 7 };

export interface StyleLayerLike {
    id: string;
    type?: string;
    source?: string;
}

export interface StyleLike {
    layers: StyleLayerLike[];
}

export interface RasterSourceSpec {
    type: 'raster';
    tiles: string[];
    tileSize: number;
    minzoom: number;
    maxzoom: number;
    attribution: string;
}

export interface RasterLayerSpec {
    id: string;
    type: 'raster';
    source: string;
    paint: {
        'raster-opacity': number;
        /** A swap is a cut: without this MapLibre cross-fades the two buffers over 300 ms. */
        'raster-opacity-transition': { duration: number; delay: number };
        'raster-fade-duration': number;
        'raster-resampling': 'linear';
    };
}

/** The subset of the MapLibre map the stack writes to. */
export interface MapLike {
    getStyle(): StyleLike;
    getLayer(id: string): unknown;
    getSource(id: string): unknown;
    addSource(id: string, spec: RasterSourceSpec): unknown;
    addLayer(spec: RasterLayerSpec, beforeId?: string): unknown;
    removeLayer(id: string): unknown;
    removeSource(id: string): unknown;
    moveLayer(id: string, beforeId?: string): unknown;
    setPaintProperty(layerId: string, name: string, value: unknown): unknown;
    setLayoutProperty(layerId: string, name: string, value: unknown): unknown;
    isSourceLoaded?(id: string): boolean;
}

export interface DesiredLayer {
    slot: LayerSlot;
    on: boolean;
    tiles: string;
    opacity: number;
    tileSize: 256 | 512;
    maxzoom: number;
    /**
     * Selected, but it has no forecast and the shown frame is one: the layers stay in the
     * stack with layout `visibility: none` (so MapLibre requests no tiles) and the slot
     * comes back in place when a frame with data is shown.
     */
    hidden?: boolean;
    /** The frame to load into the hidden buffer. `key` identifies the frame. */
    preload?: { tiles: string; key: number };
    /** The preload frame has no request for this slot (a forecast frame); there is nothing to wait for. */
    preloadNone?: number;
}

const ours = (id: string): boolean => id.startsWith(ID_PREFIX);

/**
 * First layer of the Map Features (CoT) overlay, or the first symbol layer.
 * Weather goes directly below it so markers stay on top. undefined = top of the stack.
 */
export function markerAnchor(style: StyleLike): string | undefined {
    return style.layers.find((l) => !ours(l.id) && l.source === '-1')?.id
        ?? style.layers.find((l) => !ours(l.id) && l.type === 'symbol')?.id;
}

/**
 * The lowest layer of the nearest present higher slot, else the anchor. `idOf` gives the
 * id of a present slot's lowest layer (the `a` buffer, else the `b` buffer).
 */
export function planBeforeId(
    slot: LayerSlot,
    present: ReadonlySet<LayerSlot>,
    anchor: string | undefined,
    idOf: (s: LayerSlot) => string = layerId
): string | undefined {
    for (let r = SLOT_ORDER.indexOf(slot) + 1; r < SLOT_ORDER.length; r++) {
        if (present.has(SLOT_ORDER[r])) return idOf(SLOT_ORDER[r]);
    }
    return anchor;
}

/** Whether the user switched the slot on. Never throws. */
export function isSelected(slot: LayerSlot, settings: WeatherSettings): boolean {
    if (slot === 'clouds') return settings.clouds;
    if (slot === 'precip-global') return settings.precipGlobal;
    if (slot === 'precip') return settings.precipRegional;
    return settings.radars;
}

type TimelineSession = Pick<Session, 'frame' | 'snapshot'> & Partial<Pick<Session, 'latest'>>;

/** Clouds and Radar have no forecast: they are not drawn, and not requested, in forecast frames. */
export function noForecastAt(slot: LayerSlot, settings: WeatherSettings, frame: number): boolean {
    if (slot !== 'clouds' && slot !== 'radars') return false;
    return isSelected(slot, settings) && clampFrame(frame, frameBounds(rainOn(settings)).max) > 0;
}

/**
 * The relay request for one slot, or null when it is switched off, or when it has no
 * data at that frame (Clouds and Radar in the forecast, k > 0). `frame` defaults to the
 * committed frame and is clamped to what the settings allow (no Rain: no forecast).
 * Throws a RangeError when the settings do not make a valid request.
 */
export function requestFor(
    slot: LayerSlot,
    settings: WeatherSettings,
    session: TimelineSession,
    frame: number = session.frame
): TileRequest | null {
    const anchor = session.snapshot;
    const nowMs = clock.now();
    const k = clampFrame(frame, frameBounds(rainOn(settings)).max);

    if (slot === 'clouds') return settings.clouds && k <= 0 ? tileRequest('clouds', { snapshot: holdSnapshot(k, anchor, nowMs) }) : null;
    if (slot === 'precip' || slot === 'precip-global') {
        if (!isSelected(slot, settings)) return null;
        const rain = rainFrame(k, anchor, session.latest?.[slot], nowMs);
        return tileRequest(slot, {
            color: settings.palette.precip,
            forecast: rain.forecast,
            snapshot: rain.snapshot,
            coverage: settings.coverage,
        });
    }
    if (!settings.radars || k > 0) return null;
    return tileRequest('radars', {
        color: settings.palette.radars,
        snapshot: holdSnapshot(k, anchor, nowMs),
        coverage: settings.coverage,
        usePrecipType: settings.radarsPrecipType,
    });
}

/**
 * The relay request for each slot that is switched on (null = off).
 * Only Rain carries the forecast; clouds and radar have no request in forecast frames.
 */
export function requestsFor(settings: WeatherSettings, session: TimelineSession, frame: number = session.frame): Record<LayerSlot, TileRequest | null> {
    return {
        clouds: requestFor('clouds', settings, session, frame),
        'precip-global': requestFor('precip-global', settings, session, frame),
        precip: requestFor('precip', settings, session, frame),
        radars: requestFor('radars', settings, session, frame),
    };
}

/** The next frame to load: its key and the tile URL per slot. */
export interface PreloadUrls {
    key: number;
    tiles: Partial<Record<LayerSlot, string>>;
}

/**
 * One entry per slot. A slot is on when it is selected and has a tile URL. A selected slot
 * without a forecast at the shown frame is `hidden`; the caller passes its last URL, so the
 * layers stay in the stack (and in order), or none when it has never been shown.
 */
export function computeDesired(
    settings: WeatherSettings,
    session: TimelineSession,
    tileUrls: Partial<Record<LayerSlot, string>>,
    preload?: PreloadUrls
): DesiredLayer[] {
    return SLOT_ORDER.map((slot) => {
        const tiles = tileUrls[slot];
        const next = preload?.tiles[slot];
        const d: DesiredLayer = {
            slot,
            on: isSelected(slot, settings) && typeof tiles === 'string' && tiles !== '',
            tiles: tiles ?? '',
            opacity: settings.opacity[slot],
            tileSize: settings.tileSize,
            maxzoom: MAX_ZOOM[slot],
        };
        if (noForecastAt(slot, settings, session.frame)) d.hidden = true;
        if (preload && typeof next === 'string' && next !== '') d.preload = { tiles: next, key: preload.key };
        else if (preload && noForecastAt(slot, settings, preload.key)) d.preloadNone = preload.key;
        return d;
    });
}

interface BufferState {
    tiles: string;
    /** Layout visibility on the map (false = `none`). */
    shown: boolean;
}

interface Applied {
    /** Which buffer is shown. */
    visible: Buf;
    /** Per buffer; null = not on the map. */
    bufs: [BufferState | null, BufferState | null];
    opacity: number;
    tileSize: number;
    maxzoom: number;
    /** The frame the preload serves, and where it loads: the hidden buffer, or the visible one when the URLs are equal. */
    pre: { key: number; via: 'visible' | 'hidden' | 'none' } | null;
    /** The slot has no forecast at the shown frame; its layers are layout-hidden. */
    hidden: boolean;
    /** The render count at the last swap (null = never swapped). */
    swappedAt: number | null;
    /** The hidden buffer is no longer needed and goes once the swap has settled. */
    dropHidden: boolean;
}

const BUFFERS: readonly Buf[] = [0, 1];

/**
 * Single writer of the weather layers on the map. sync() is declarative and idempotent.
 *
 * Double buffering: a slot can own a second raster source+layer pair (the hidden buffer)
 * that loads the next frame at HIDDEN_OPACITY while the visible one is shown. The next
 * sync swaps them with two setPaintProperty calls. Layers are never moved for that, and
 * the pair always sits directly together in the order a (below) then b.
 */
export class LayerStack {
    private map: MapLike;
    private applied = new Map<LayerSlot, Applied>();
    private tracker = new PreloadTracker();
    private warned = false;
    private renders = 0;

    constructor(map: MapLike) {
        this.map = map;
    }

    /** The lowest layer of the slot on the map: its `a` buffer, else its `b` buffer. */
    lowestLayerId(slot: LayerSlot): string | undefined {
        for (const buf of BUFFERS) {
            if (this.map.getLayer(bufferLayerId(slot, buf))) return bufferLayerId(slot, buf);
        }
        return undefined;
    }

    private presentSlots(except?: LayerSlot): Set<LayerSlot> {
        const present = new Set<LayerSlot>();
        for (const s of SLOT_ORDER) {
            if (s !== except && this.lowestLayerId(s) !== undefined) present.add(s);
        }
        return present;
    }

    private removeBuffer(slot: LayerSlot, buf: Buf): void {
        this.tracker.drop(bufferSourceId(slot, buf));
        const a = this.applied.get(slot);
        if (a) a.bufs[buf] = null;
        if (this.map.getLayer(bufferLayerId(slot, buf))) this.map.removeLayer(bufferLayerId(slot, buf));
        if (this.map.getSource(bufferSourceId(slot, buf))) this.map.removeSource(bufferSourceId(slot, buf));
    }

    /** Remove both buffers of a slot. */
    private remove(slot: LayerSlot): void {
        try {
            this.removeBuffer(slot, 1);
        } finally {
            this.removeBuffer(slot, 0);
            this.applied.delete(slot);
        }
    }

    private create(d: DesiredLayer, buf: Buf, tiles: string, opacity: number, before: string | undefined): void {
        if (this.map.getSource(bufferSourceId(d.slot, buf))) this.map.removeSource(bufferSourceId(d.slot, buf));

        this.map.addSource(bufferSourceId(d.slot, buf), {
            type: 'raster',
            tiles: [tiles],
            tileSize: d.tileSize,
            minzoom: 0,
            maxzoom: d.maxzoom,
            attribution: ATTRIBUTION,
        });

        this.map.addLayer({
            id: bufferLayerId(d.slot, buf),
            type: 'raster',
            source: bufferSourceId(d.slot, buf),
            paint: {
                'raster-opacity': opacity,
                // No default 300 ms cross-fade on a swap: it showed both frames at once, and the
                // buffer that was fading out already loaded the next frame (a ghost of n+1).
                'raster-opacity-transition': { duration: 0, delay: 0 },
                'raster-fade-duration': 0,
                'raster-resampling': 'linear',
            },
        }, before);
    }

    /** Add the slot with its `a` buffer visible. */
    private add(d: DesiredLayer): void {
        const before = planBeforeId(d.slot, this.presentSlots(d.slot), markerAnchor(this.map.getStyle()), (s) => this.lowestLayerId(s) as string);

        // A leftover `b` buffer would break the a-below-b order.
        if (this.map.getLayer(bufferLayerId(d.slot, 1))) this.map.removeLayer(bufferLayerId(d.slot, 1));
        if (this.map.getSource(bufferSourceId(d.slot, 1))) this.map.removeSource(bufferSourceId(d.slot, 1));

        this.create(d, 0, d.tiles, d.opacity, before);
        this.applied.set(d.slot, {
            visible: 0,
            bufs: [{ tiles: d.tiles, shown: true }, null],
            opacity: d.opacity,
            tileSize: d.tileSize,
            maxzoom: d.maxzoom,
            pre: null,
            hidden: false,
            swappedAt: null,
            dropHidden: false,
        });
    }

    /** Show the hidden buffer and hide the shown one. No layer moves. */
    private swap(slot: LayerSlot, a: Applied, opacity: number): void {
        const next = (1 - a.visible) as Buf;
        this.map.setPaintProperty(bufferLayerId(slot, next), 'raster-opacity', opacity);
        this.map.setPaintProperty(bufferLayerId(slot, a.visible), 'raster-opacity', HIDDEN_OPACITY);
        a.visible = next;
        a.opacity = opacity;
        a.swappedAt = this.renders;
        a.dropHidden = false;
    }

    private settled(a: Applied): boolean {
        return a.swappedAt === null || this.renders - a.swappedAt >= SETTLE_RENDERS;
    }

    /** Remove the hidden buffer now, or as soon as the last swap has settled. */
    private dropHidden(slot: LayerSlot, a: Applied): void {
        const hidden = (1 - a.visible) as Buf;
        if (!a.bufs[hidden]) {
            a.dropHidden = false;
            return;
        }
        if (!this.settled(a)) {
            a.dropHidden = true;
            return;
        }
        a.dropHidden = false;
        this.removeBuffer(slot, hidden);
    }

    /** Create the hidden buffer next to the visible one: `b` above `a`. */
    private createHidden(d: DesiredLayer, a: Applied, tiles: string): void {
        const hidden = (1 - a.visible) as Buf;
        const before = hidden === 1
            ? planBeforeId(d.slot, this.presentSlots(d.slot), markerAnchor(this.map.getStyle()), (s) => this.lowestLayerId(s) as string)
            : bufferLayerId(d.slot, 1);
        this.create(d, hidden, tiles, HIDDEN_OPACITY, before);
        a.bufs[hidden] = { tiles, shown: true };
    }

    /** Load (or stop loading) the next frame into the hidden buffer. */
    private syncPreload(d: DesiredLayer): void {
        const a = this.applied.get(d.slot);
        if (!a) return;
        const hidden = (1 - a.visible) as Buf;
        const pre = d.preload;

        try {
            if (!pre) {
                this.dropHidden(d.slot, a);
                a.pre = d.preloadNone === undefined ? null : { key: d.preloadNone, via: 'none' };
                return;
            }

            // A hidden slot's shown buffer is not loading, so the frame has to load in the other one.
            if (pre.tiles === a.bufs[a.visible]?.tiles && !d.hidden) {
                // Nothing new to load, the shown frame already is that frame.
                this.dropHidden(d.slot, a);
                a.pre = { key: pre.key, via: 'visible' };
                return;
            }

            a.dropHidden = false;

            const have = a.bufs[hidden];
            if (!have) {
                this.createHidden(d, a, pre.tiles);
                this.tracker.arm(bufferSourceId(d.slot, hidden), pre.key);
            } else if (have.tiles !== pre.tiles) {
                const src = this.map.getSource(bufferSourceId(d.slot, hidden)) as { setTiles?: (tiles: string[]) => unknown } | undefined;
                if (!src || typeof src.setTiles !== 'function') throw new Error('hidden buffer cannot change tiles');
                src.setTiles([pre.tiles]);
                have.tiles = pre.tiles;
                this.tracker.arm(bufferSourceId(d.slot, hidden), pre.key);
            } else {
                this.tracker.retarget(bufferSourceId(d.slot, hidden), pre.key);
            }
            a.pre = { key: pre.key, via: 'hidden' };
        } catch (err) {
            // Preloading is an optimisation: give the buffer up, the visible frame is untouched.
            if (!this.warned) {
                this.warned = true;
                console.warn('[weather] Could not preload the next frame', err);
            }
            try {
                this.removeBuffer(d.slot, hidden);
            } catch {
                // Already gone.
            }
            a.pre = null;
        }
    }

    /** Forget a hidden buffer that is partly or fully gone from the map. */
    private repairHidden(slot: LayerSlot, a: Applied): void {
        const hidden = (1 - a.visible) as Buf;
        if (!a.bufs[hidden]) return;
        if (this.map.getLayer(bufferLayerId(slot, hidden)) && this.map.getSource(bufferSourceId(slot, hidden))) return;
        try {
            this.removeBuffer(slot, hidden);
        } catch {
            a.bufs[hidden] = null;
        }
        a.pre = null;
    }

    /** Set the layout visibility of one buffer, only when it differs from what is on the map. */
    private setShown(slot: LayerSlot, buf: Buf, a: Applied, shown: boolean): void {
        const b = a.bufs[buf];
        if (!b || b.shown === shown) return;
        if (!this.map.getLayer(bufferLayerId(slot, buf))) return;
        this.map.setLayoutProperty(bufferLayerId(slot, buf), 'visibility', shown ? 'visible' : 'none');
        b.shown = shown;
    }

    /**
     * Layout visibility. A hidden slot (no forecast at the shown frame) keeps its layers,
     * so the order stays, but with `visibility: none` MapLibre requests no tiles for them.
     * The other buffer is visible (at opacity 0) only while it loads a frame.
     */
    private applyLayout(d: DesiredLayer): void {
        const a = this.applied.get(d.slot);
        if (!a) return;
        const hidden = (1 - a.visible) as Buf;
        this.setShown(d.slot, a.visible, a, !d.hidden);
        if (a.pre?.via === 'hidden') this.setShown(d.slot, hidden, a, true);
        else if (d.hidden) this.setShown(d.slot, hidden, a, false);
        a.hidden = Boolean(d.hidden);
    }

    private syncSlot(slot: LayerSlot, d: DesiredLayer): void {
        const prev = this.applied.get(slot);
        const exists = Boolean(prev && this.map.getLayer(bufferLayerId(slot, prev.visible)));

        if (!exists || !prev) {
            if (this.lowestLayerId(slot) !== undefined) this.remove(slot);
            this.add(d);
            this.syncPreload(d);
            return;
        }

        if (prev.tileSize !== d.tileSize || prev.maxzoom !== d.maxzoom) {
            this.remove(slot);
            this.add(d);
            this.syncPreload(d);
            return;
        }

        this.repairHidden(slot, prev);

        const shown = prev.bufs[prev.visible];
        if (shown) {
            const hidden = prev.bufs[(1 - prev.visible) as Buf];
            // The slot returns from a forecast frame: the buffer that preloaded its frame takes over.
            const returning = prev.hidden && !d.hidden;
            if (hidden && hidden.tiles === d.tiles && (shown.tiles !== d.tiles || returning)) {
                try {
                    this.swap(slot, prev, d.opacity);
                } catch (err) {
                    console.warn('[weather] Could not swap the preloaded frame, reloading it', err);
                    this.remove(slot);
                    this.add(d);
                    this.syncPreload(d);
                    return;
                }
            } else if (shown.tiles !== d.tiles) {
                const src = this.map.getSource(bufferSourceId(slot, prev.visible)) as { setTiles?: (tiles: string[]) => unknown } | undefined;
                if (src && typeof src.setTiles === 'function') {
                    src.setTiles([d.tiles]);
                    shown.tiles = d.tiles;
                } else {
                    this.remove(slot);
                    this.add(d);
                    this.syncPreload(d);
                    return;
                }
            }
        }

        if (prev.opacity !== d.opacity) {
            this.map.setPaintProperty(bufferLayerId(slot, prev.visible), 'raster-opacity', d.opacity);
            prev.opacity = d.opacity;
        }

        this.syncPreload(d);
    }

    sync(desired: DesiredLayer[]): void {
        const bySlot = new Map(desired.map((d) => [d.slot, d]));

        for (const slot of SLOT_ORDER) {
            const d = bySlot.get(slot);
            if (!d || !d.on) this.remove(slot);
        }

        for (const slot of SLOT_ORDER) {
            const d = bySlot.get(slot);
            if (!d || !d.on) continue;
            this.syncSlot(slot, d);
            this.applyLayout(d);
        }

        this.ensureOrder();
    }

    /** Remove everything, tolerating a map that already lost its layers. */
    removeAll(): void {
        for (const slot of [...SLOT_ORDER].reverse()) {
            for (const buf of [1, 0] as const) {
                try {
                    this.removeBuffer(slot, buf);
                } catch {
                    // The map lost it already.
                }
            }
            this.applied.delete(slot);
        }
        this.tracker.clear();
    }

    /**
     * Restore clouds < rain < radar and "below the marker anchor", with the buffers of a
     * slot in the order a, b. A correct stack makes no moveLayer call. Returns true when
     * layers were moved.
     */
    ensureOrder(): boolean {
        const style = this.map.getStyle();
        const ids = style.layers.map((l) => l.id);
        const present: string[] = [];
        for (const slot of SLOT_ORDER) {
            for (const buf of BUFFERS) {
                if (ids.includes(bufferLayerId(slot, buf))) present.push(bufferLayerId(slot, buf));
            }
        }
        if (present.length === 0) return false;

        const anchor = markerAnchor(style);
        const positions = present.map((id) => ids.indexOf(id));
        const ordered = positions.every((p, i) => i === 0 || positions[i - 1] < p);
        const anchorIdx = anchor === undefined ? -1 : ids.indexOf(anchor);
        const below = anchorIdx < 0 || positions[positions.length - 1] < anchorIdx;

        if (ordered && below) return false;

        let before = anchor;
        for (const id of [...present].reverse()) {
            this.map.moveLayer(id, before);
            before = id;
        }
        return true;
    }

    /** True when every weather source on the map (both buffers) reports its tiles as loaded. */
    sourcesLoaded(): boolean {
        const isLoaded = this.map.isSourceLoaded;
        if (typeof isLoaded !== 'function') return true;

        return SLOT_ORDER
            .flatMap((s) => BUFFERS.map((b) => bufferSourceId(s, b)))
            .filter((id) => this.map.getSource(id))
            .every((id) => isLoaded.call(this.map, id));
    }

    /** Feed the MapLibre `sourcedata` and `render` events to the preload tracker. */
    noteMapEvent(type: string, event?: MapEventLike): void {
        this.tracker.note(type, event);
        if (type !== 'render') return;
        this.renders++;
        for (const [slot, a] of this.applied) {
            if (!a.dropHidden || !this.settled(a)) continue;
            try {
                this.dropHidden(slot, a);
            } catch {
                a.dropHidden = false;
            }
        }
    }

    private loaded(id: string): boolean {
        const isLoaded = this.map.isSourceLoaded;
        if (typeof isLoaded !== 'function') return true;
        try {
            return isLoaded.call(this.map, id);
        } catch {
            return false;
        }
    }

    /**
     * True when the frame `key` is loaded into the hidden buffer of every slot that is on
     * (a slot whose next frame is the shown frame needs nothing). False with no slot on.
     */
    preloadReady(key: number): boolean {
        let any = false;
        for (const slot of SLOT_ORDER) {
            const a = this.applied.get(slot);
            if (!a) continue;
            if (!a.pre || a.pre.key !== key) return false;
            if (a.pre.via === 'hidden') {
                const id = bufferSourceId(slot, (1 - a.visible) as Buf);
                if (!this.tracker.ready(id, key, () => this.loaded(id))) return false;
            }
            any = true;
        }
        return any;
    }

    /** Layer ids currently on the map, bottom to top. */
    stackIds(): string[] {
        return this.map.getStyle().layers.map((l) => l.id).filter(ours);
    }
}
