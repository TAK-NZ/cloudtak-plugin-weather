import type { LayerSlot, TileRequest, WeatherSettings } from './types.ts';
import type { Session } from './state.ts';
import { ATTRIBUTION, ID_PREFIX } from './constants.ts';
import { tileRequest } from './tile-url.ts';
import { frameToMinutes } from './time.ts';

/** Bottom to top. */
export const SLOT_ORDER: LayerSlot[] = ['clouds', 'precip', 'radars'];

export const layerId = (s: LayerSlot): string => `${ID_PREFIX}${s}`;
export const sourceId = (s: LayerSlot): string => `${ID_PREFIX}${s}-src`;

const MAX_ZOOM: Record<LayerSlot, number> = { clouds: 7, precip: 9, radars: 7 };

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
    isSourceLoaded?(id: string): boolean;
}

export interface DesiredLayer {
    slot: LayerSlot;
    on: boolean;
    tiles: string;
    opacity: number;
    tileSize: 256 | 512;
    maxzoom: number;
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

/** The nearest present layer of a higher slot, else the anchor. */
export function planBeforeId(slot: LayerSlot, present: ReadonlySet<LayerSlot>, anchor: string | undefined): string | undefined {
    for (let r = SLOT_ORDER.indexOf(slot) + 1; r < SLOT_ORDER.length; r++) {
        if (present.has(SLOT_ORDER[r])) return layerId(SLOT_ORDER[r]);
    }
    return anchor;
}

/** Whether the user switched the slot on. Never throws. */
export function isSelected(slot: LayerSlot, settings: WeatherSettings): boolean {
    if (slot === 'clouds') return settings.clouds;
    if (slot === 'precip') return settings.precip !== 'none';
    return settings.radars;
}

/**
 * The relay request for one slot, or null when it is switched off.
 * Throws a RangeError when the settings do not make a valid request.
 */
export function requestFor(slot: LayerSlot, settings: WeatherSettings, session: Pick<Session, 'frame' | 'snapshot'>): TileRequest | null {
    const snapshot = session.snapshot;

    if (slot === 'clouds') return settings.clouds ? tileRequest('clouds', { snapshot }) : null;
    if (slot === 'precip') {
        return settings.precip === 'none' ? null : tileRequest(settings.precip, {
            color: settings.palette.precip,
            forecast: frameToMinutes(session.frame),
            snapshot,
            coverage: settings.coverage,
        });
    }
    if (!settings.radars) return null;
    return tileRequest('radars', {
        color: settings.palette.radars,
        snapshot,
        coverage: settings.coverage,
        usePrecipType: settings.radarsPrecipType,
    });
}

/**
 * The relay request for each slot that is switched on (null = off).
 * Only the rain request carries the forecast frame; clouds and radar show current data.
 */
export function requestsFor(settings: WeatherSettings, session: Pick<Session, 'frame' | 'snapshot'>): Record<LayerSlot, TileRequest | null> {
    return {
        clouds: requestFor('clouds', settings, session),
        precip: requestFor('precip', settings, session),
        radars: requestFor('radars', settings, session),
    };
}

/**
 * One entry per slot. A slot is on when it is selected and has a tile URL;
 * regional and global rain share the single precip slot.
 */
export function computeDesired(
    settings: WeatherSettings,
    session: Pick<Session, 'frame' | 'snapshot'>,
    tileUrls: Partial<Record<LayerSlot, string>>
): DesiredLayer[] {
    return SLOT_ORDER.map((slot) => {
        const tiles = tileUrls[slot];
        return {
            slot,
            on: isSelected(slot, settings) && typeof tiles === 'string' && tiles !== '',
            tiles: tiles ?? '',
            opacity: settings.opacity[slot],
            tileSize: settings.tileSize,
            maxzoom: MAX_ZOOM[slot],
        };
    });
}

interface Applied {
    tiles: string;
    opacity: number;
    tileSize: number;
    maxzoom: number;
}

/**
 * Single writer of the weather layers on the map. sync() is declarative and idempotent.
 */
export class LayerStack {
    private map: MapLike;
    private applied = new Map<LayerSlot, Applied>();

    constructor(map: MapLike) {
        this.map = map;
    }

    private presentSlots(except?: LayerSlot): Set<LayerSlot> {
        const present = new Set<LayerSlot>();
        for (const s of SLOT_ORDER) {
            if (s !== except && this.map.getLayer(layerId(s))) present.add(s);
        }
        return present;
    }

    private remove(slot: LayerSlot): void {
        if (this.map.getLayer(layerId(slot))) this.map.removeLayer(layerId(slot));
        if (this.map.getSource(sourceId(slot))) this.map.removeSource(sourceId(slot));
        this.applied.delete(slot);
    }

    private add(d: DesiredLayer): void {
        const present = this.presentSlots(d.slot);
        const before = planBeforeId(d.slot, present, markerAnchor(this.map.getStyle()));

        if (this.map.getSource(sourceId(d.slot))) this.map.removeSource(sourceId(d.slot));

        this.map.addSource(sourceId(d.slot), {
            type: 'raster',
            tiles: [d.tiles],
            tileSize: d.tileSize,
            minzoom: 0,
            maxzoom: d.maxzoom,
            attribution: ATTRIBUTION,
        });

        this.map.addLayer({
            id: layerId(d.slot),
            type: 'raster',
            source: sourceId(d.slot),
            paint: {
                'raster-opacity': d.opacity,
                'raster-fade-duration': 0,
                'raster-resampling': 'linear',
            },
        }, before);

        this.applied.set(d.slot, { tiles: d.tiles, opacity: d.opacity, tileSize: d.tileSize, maxzoom: d.maxzoom });
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

            const prev = this.applied.get(slot);
            const exists = Boolean(this.map.getLayer(layerId(slot)));

            if (!exists || !prev) {
                if (exists) this.remove(slot);
                this.add(d);
                continue;
            }

            if (prev.tileSize !== d.tileSize || prev.maxzoom !== d.maxzoom) {
                this.remove(slot);
                this.add(d);
                continue;
            }

            if (prev.tiles !== d.tiles) {
                const src = this.map.getSource(sourceId(slot)) as { setTiles?: (tiles: string[]) => unknown } | undefined;
                if (src && typeof src.setTiles === 'function') {
                    src.setTiles([d.tiles]);
                    prev.tiles = d.tiles;
                } else {
                    this.remove(slot);
                    this.add(d);
                    continue;
                }
            }

            if (prev.opacity !== d.opacity) {
                this.map.setPaintProperty(layerId(slot), 'raster-opacity', d.opacity);
                prev.opacity = d.opacity;
            }
        }

        this.ensureOrder();
    }

    /** Remove everything, tolerating a map that already lost its layers. */
    removeAll(): void {
        for (const slot of [...SLOT_ORDER].reverse()) {
            try {
                this.remove(slot);
            } catch {
                this.applied.delete(slot);
            }
        }
    }

    /**
     * Restore clouds < rain < radar and "below the marker anchor".
     * A correct stack makes no moveLayer call. Returns true when layers were moved.
     */
    ensureOrder(): boolean {
        const style = this.map.getStyle();
        const ids = style.layers.map((l) => l.id);
        const present = SLOT_ORDER.filter((s) => ids.includes(layerId(s)));
        if (present.length === 0) return false;

        const anchor = markerAnchor(style);
        const positions = present.map((s) => ids.indexOf(layerId(s)));
        const ordered = positions.every((p, i) => i === 0 || positions[i - 1] < p);
        const anchorIdx = anchor === undefined ? -1 : ids.indexOf(anchor);
        const below = anchorIdx < 0 || positions[positions.length - 1] < anchorIdx;

        if (ordered && below) return false;

        let before = anchor;
        for (const slot of [...present].reverse()) {
            this.map.moveLayer(layerId(slot), before);
            before = layerId(slot);
        }
        return true;
    }

    /** True when every weather source on the map reports its tiles as loaded. */
    sourcesLoaded(): boolean {
        const isLoaded = this.map.isSourceLoaded;
        if (typeof isLoaded !== 'function') return true;

        return SLOT_ORDER
            .filter((s) => this.map.getSource(sourceId(s)))
            .every((s) => isLoaded.call(this.map, sourceId(s)));
    }

    /** Layer ids currently on the map, bottom to top. */
    stackIds(): string[] {
        return this.map.getStyle().layers.map((l) => l.id).filter(ours);
    }
}
