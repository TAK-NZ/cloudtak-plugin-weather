import type { MapLike, RasterLayerSpec, RasterSourceSpec, StyleLayerLike } from '../lib/layers.ts';

export interface FakeLayer extends StyleLayerLike {
    paint?: Record<string, unknown>;
}

interface FakeSource {
    id: string;
    spec: RasterSourceSpec | Record<string, unknown>;
    tiles: string[];
    setTiles(tiles: string[]): void;
}

export interface Counters {
    addSource: number;
    addLayer: number;
    removeLayer: number;
    removeSource: number;
    moveLayer: number;
    setTiles: number;
    setPaintProperty: number;
}

/**
 * Reproduces the MapLibre rules that matter for stacking: addLayer/moveLayer insert
 * directly below `before` (append when undefined) and throw for unknown ids.
 */
export class FakeMap implements MapLike {
    layers: FakeLayer[] = [];
    sources = new Map<string, FakeSource>();
    counters: Counters = this.zero();

    constructor(initial?: FakeLayer[]) {
        this.layers = (initial ?? FakeMap.initialLayers()).map((l) => ({ ...l }));
        for (const l of this.layers) {
            if (l.source && !this.sources.has(l.source)) this.makeSource(l.source, {});
        }
    }

    static initialLayers(): FakeLayer[] {
        return [
            { id: 'background', type: 'background' },
            { id: 'basemap', type: 'raster', source: 'basemap' },
            { id: 'overlay-7', type: 'raster', source: '7' },
            { id: 'mf-polygons', type: 'fill', source: '-1' },
            { id: 'mf-lines', type: 'line', source: '-1' },
            { id: 'labels', type: 'symbol', source: 'labels-src' },
        ];
    }

    private zero(): Counters {
        return { addSource: 0, addLayer: 0, removeLayer: 0, removeSource: 0, moveLayer: 0, setTiles: 0, setPaintProperty: 0 };
    }

    private makeSource(id: string, spec: FakeSource['spec']): void {
        const src: FakeSource = {
            id,
            spec,
            tiles: Array.isArray((spec as RasterSourceSpec).tiles) ? [...(spec as RasterSourceSpec).tiles] : [],
            setTiles: (tiles: string[]) => {
                this.counters.setTiles++;
                src.tiles = [...tiles];
            },
        };
        this.sources.set(id, src);
    }

    resetCounters(): void {
        this.counters = this.zero();
    }

    getStyle(): { layers: StyleLayerLike[] } {
        return { layers: this.layers.map((l) => ({ id: l.id, type: l.type, source: l.source })) };
    }

    getLayer(id: string): FakeLayer | undefined {
        return this.layers.find((l) => l.id === id);
    }

    getSource(id: string): FakeSource | undefined {
        return this.sources.get(id);
    }

    addSource(id: string, spec: RasterSourceSpec): void {
        if (this.sources.has(id)) throw new Error(`Source ${id} already exists`);
        this.counters.addSource++;
        this.makeSource(id, spec);
    }

    private insert(layer: FakeLayer, before?: string): void {
        if (before === undefined) {
            this.layers.push(layer);
            return;
        }
        const idx = this.layers.findIndex((l) => l.id === before);
        if (idx < 0) throw new Error(`Layer ${before} does not exist`);
        this.layers.splice(idx, 0, layer);
    }

    addLayer(spec: RasterLayerSpec, before?: string): void {
        if (this.getLayer(spec.id)) throw new Error(`Layer ${spec.id} already exists`);
        if (!this.sources.has(spec.source)) throw new Error(`Source ${spec.source} not found`);
        this.counters.addLayer++;
        this.insert({ id: spec.id, type: spec.type, source: spec.source, paint: { ...spec.paint } }, before);
    }

    /** Foreign layers (not counted). */
    addForeign(layer: FakeLayer, before?: string): void {
        if (layer.source && !this.sources.has(layer.source)) this.makeSource(layer.source, {});
        this.insert({ ...layer }, before);
    }

    removeForeign(id: string): void {
        this.layers = this.layers.filter((l) => l.id !== id);
    }

    removeLayer(id: string): void {
        const idx = this.layers.findIndex((l) => l.id === id);
        if (idx < 0) throw new Error(`Layer ${id} does not exist`);
        this.counters.removeLayer++;
        this.layers.splice(idx, 1);
    }

    removeSource(id: string): void {
        if (!this.sources.has(id)) throw new Error(`Source ${id} does not exist`);
        if (this.layers.some((l) => l.source === id)) throw new Error(`Source ${id} is in use`);
        this.counters.removeSource++;
        this.sources.delete(id);
    }

    moveLayer(id: string, before?: string): void {
        const idx = this.layers.findIndex((l) => l.id === id);
        if (idx < 0) throw new Error(`Layer ${id} does not exist`);
        if (before !== undefined && !this.getLayer(before)) throw new Error(`Layer ${before} does not exist`);
        this.counters.moveLayer++;
        const [layer] = this.layers.splice(idx, 1);
        this.insert(layer, before);
    }

    /** Foreign move (not counted). */
    moveForeign(id: string, before?: string): void {
        const idx = this.layers.findIndex((l) => l.id === id);
        const [layer] = this.layers.splice(idx, 1);
        this.insert(layer, before);
    }

    setPaintProperty(layerId: string, name: string, value: unknown): void {
        const layer = this.getLayer(layerId);
        if (!layer) throw new Error(`Layer ${layerId} does not exist`);
        this.counters.setPaintProperty++;
        layer.paint = { ...layer.paint, [name]: value };
    }

    /** Drop every weather layer and source behind the stack's back (map re-init). */
    dropPrefixed(prefix: string): void {
        this.layers = this.layers.filter((l) => !l.id.startsWith(prefix));
        for (const id of [...this.sources.keys()]) {
            if (id.startsWith(prefix)) this.sources.delete(id);
        }
    }
}
