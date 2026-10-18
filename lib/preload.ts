/**
 * Decides when a hidden raster buffer has finished loading the tiles of one frame.
 *
 * A bare `isSourceLoaded()` is not enough: MapLibre fires the source-level `sourcedata`
 * event of a `setTiles()` a frame later, and until then `isSourceLoaded()` can still
 * answer true for the OLD tiles. Acting on that would swap in a stale frame. So a buffer
 * counts as ready only when all of these hold:
 *   1. it was armed for this frame key (`arm()` runs after every `setTiles()` / creation),
 *   2. MapLibre reported progress after arming: a source-level `sourcedata` event for
 *      that source (no `tile`), or at least two `render` events,
 *   3. `isSourceLoaded()` says the source is loaded.
 */

/** Render events after arming that count as progress when no `sourcedata` was seen. */
export const RENDERS_BEFORE_READY = 2;

interface Entry {
    key: number;
    /** A source-level `sourcedata` event arrived after arming. */
    sawSource: boolean;
    renders: number;
}

export interface MapEventLike {
    sourceId?: unknown;
    tile?: unknown;
}

export class PreloadTracker {
    private entries = new Map<string, Entry>();

    /** The buffer `sourceId` was (re)pointed at the tiles of frame `key`. */
    arm(sourceId: string, key: number): void {
        this.entries.set(sourceId, { key, sawSource: false, renders: 0 });
    }

    /** The buffer keeps its tiles but now serves frame `key` (identical URL). */
    retarget(sourceId: string, key: number): void {
        const entry = this.entries.get(sourceId);
        if (entry) entry.key = key;
    }

    drop(sourceId: string): void {
        this.entries.delete(sourceId);
    }

    clear(): void {
        this.entries.clear();
    }

    has(sourceId: string): boolean {
        return this.entries.has(sourceId);
    }

    /** Feed the MapLibre `sourcedata` and `render` events. Other types are ignored. */
    note(type: string, event?: MapEventLike): void {
        if (type === 'render') {
            for (const entry of this.entries.values()) entry.renders++;
            return;
        }
        if (type !== 'sourcedata' || !event || event.tile || typeof event.sourceId !== 'string') return;
        const entry = this.entries.get(event.sourceId);
        if (entry) entry.sawSource = true;
    }

    ready(sourceId: string, key: number, isLoaded: () => boolean): boolean {
        const entry = this.entries.get(sourceId);
        if (!entry || entry.key !== key) return false;
        if (!entry.sawSource && entry.renders < RENDERS_BEFORE_READY) return false;
        return isLoaded();
    }
}
