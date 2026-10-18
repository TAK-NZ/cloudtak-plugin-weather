// SPDX-License-Identifier: MIT-0
// Copy into your plugin. Do not import it from another plugin.
//
// Plugin panel contract for the bottom of the map (area 'bottom'). Two events on the target (default: window):
//   cloudtak-plugin:panel-open   { id, area, restored? }  a plugin has shown its panel; `restored` is true only
//                                                   when the user brought a minimized panel back from its selector
//   cloudtak-plugin:panel-close  { id, area, by? }  a plugin has closed its panel; `by` is the id of the plugin
//                                                   it closed for (set only when it yielded, or when a minimized
//                                                   plugin goes away while waiting for someone)
// A plugin that shows a panel while another plugin's panel is shown makes that plugin yield: it closes (no state
// to lose) or minimizes (hides the controls, keeps the state) and restores when the opener closes.
// A plugin that is already minimized ignores a plain panel-open from another plugin (it keeps waiting for the one it
// yielded to, so a chain A, B, C restores in reverse order). It retargets its wait to the opener only when the
// panel-open has `restored === true` (the opener was brought back from its selector, so it now sits on top).
export type PanelArea = 'bottom';
export interface PanelEventDetail { id: string; area: PanelArea; by?: string; restored?: boolean }
export const PANEL_OPEN = 'cloudtak-plugin:panel-open';
export const PANEL_CLOSE = 'cloudtak-plugin:panel-close';

export interface PanelCoordinatorOptions {
    id: string;
    area?: PanelArea;
    target?: EventTarget;
    /** Controls visible right now. Must be false while minimized. */
    isShown(): boolean;
    /** Asked at yield time: would closing lose work that is not persisted? */
    hasState(): boolean;
    /** Hide the controls and drop UI state. Must NOT call opened() or closed(). */
    close(): void;
    /** Hide the controls, keep the state. Must NOT call opened() or closed(). */
    minimize(): void;
    /** Show the controls again. Must NOT call opened() or closed(). */
    restore(): void;
    /** Drives the dot on the selector. */
    onMinimizedChange?(minimized: boolean): void;
}

export interface PanelCoordinator {
    readonly minimized: boolean;
    /** The user showed the panel. */
    opened(): void;
    /** The user closed the panel, or the plugin is shutting down while it is shown or minimized. */
    closed(): void;
    /** The user tapped the selector of a minimized plugin. Counts as opening. */
    restoreFromSelector(): void;
    dispose(): void;
}

function read(e: Event, area: PanelArea): PanelEventDetail | null {
    const d = (e as CustomEvent).detail as Partial<PanelEventDetail> | null | undefined;
    if (!d || typeof d.id !== 'string' || d.id === '' || d.area !== area) return null;
    return {
        id: d.id,
        area,
        by: typeof d.by === 'string' && d.by !== '' ? d.by : undefined,
        // Strictly the boolean true; anything else is a plain open.
        restored: d.restored === true,
    };
}

export function createPanelCoordinator(o: PanelCoordinatorOptions): PanelCoordinator {
    const area = o.area ?? 'bottom';
    const target = o.target ?? window;
    let yieldedFor: string | null = null;
    let minimized = false;
    const setMin = (v: boolean): void => {
        if (minimized !== v) {
            minimized = v;
            o.onMinimizedChange?.(v);
        }
    };
    const emit = (type: string, extra: { by?: string; restored?: true } = {}): void => {
        target.dispatchEvent(new CustomEvent<PanelEventDetail>(type, {
            detail: { id: o.id, area, ...(extra.by ? { by: extra.by } : {}), ...(extra.restored ? { restored: true } : {}) },
        }));
    };
    const onOpen = (e: Event): void => {
        const d = read(e, area);
        if (!d || d.id === o.id) return;
        if (minimized) {
            // A plain open keeps the current wait. A restored open means that plugin is now on top: wait for it.
            if (d.restored) yieldedFor = d.id;
            return;
        }
        if (!o.isShown()) return;
        if (o.hasState()) {
            o.minimize();
            yieldedFor = d.id;
            setMin(true);
        } else {
            o.close();
            emit(PANEL_CLOSE, { by: d.id });
        }
    };
    const onClose = (e: Event): void => {
        const d = read(e, area);
        if (!d || d.id === o.id || yieldedFor === null || d.id !== yieldedFor) return;
        if (d.by && d.by !== o.id) {
            yieldedFor = d.by;
            return;
        }
        yieldedFor = null;
        setMin(false);
        o.restore();
    };
    target.addEventListener(PANEL_OPEN, onOpen);
    target.addEventListener(PANEL_CLOSE, onClose);
    return {
        get minimized() { return minimized; },
        opened() {
            yieldedFor = null;
            setMin(false);
            emit(PANEL_OPEN);
        },
        closed() {
            const by = yieldedFor ?? undefined;
            yieldedFor = null;
            setMin(false);
            emit(PANEL_CLOSE, { by });
        },
        restoreFromSelector() {
            if (!minimized) return;
            yieldedFor = null;
            setMin(false);
            o.restore();
            emit(PANEL_OPEN, { restored: true });
        },
        dispose() {
            target.removeEventListener(PANEL_OPEN, onOpen);
            target.removeEventListener(PANEL_CLOSE, onClose);
            yieldedFor = null;
            setMin(false);
        },
    };
}
