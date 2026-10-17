import type { LayerStack, MapLike } from './layers.ts';
import { markerAnchor } from './layers.ts';
import { ID_PREFIX } from './constants.ts';
import { session, settings } from './state.ts';
import { clock } from './time.ts';

export interface DebugContext {
    map: MapLike;
    stack: LayerStack;
    /** Called after the clock was moved so the caller can recompute the snapshot. */
    onClockChange: () => void;
}

interface DebugWindow {
    __taknzWeather?: unknown;
}

/**
 * Development helper: window.__taknzWeather. Does nothing in production builds.
 * Returns a function that removes it again.
 */
export function exposeDebug(ctx: DebugContext): () => void {
    if (!import.meta.env.DEV || typeof window === 'undefined') return () => undefined;

    const target = window as unknown as DebugWindow;
    const handle = {
        map: ctx.map,
        stackIds: (): string[] => ctx.stack.stackIds(),
        ours: (): string[] => ctx.map.getStyle().layers.map((l) => l.id).filter((id) => id.startsWith(ID_PREFIX)),
        anchor: (): string | undefined => markerAnchor(ctx.map.getStyle()),
        settings,
        session,
        setNow: (ms: number): void => {
            clock.offsetMs = ms - Date.now();
            ctx.onClockChange();
        },
    };
    target.__taknzWeather = handle;

    return () => {
        if (target.__taknzWeather === handle) delete target.__taknzWeather;
    };
}
