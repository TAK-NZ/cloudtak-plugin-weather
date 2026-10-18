import { CONTROL_CLASS, CONTROL_STYLE_ID } from './constants.ts';
import { ICON_PATH_DATA, ICON_VIEW_BOX } from './icon.ts';

/** The part of a MapLibre map the control needs (the plugin never imports maplibre-gl). */
export interface ControlMapLike {
    getContainer(): HTMLElement;
}

/** Structural twin of maplibre-gl's IControl. */
export interface IControlLike {
    onAdd(map: ControlMapLike): HTMLElement;
    onRemove(map?: ControlMapLike): void;
}

/** The control API of a MapLibre map. */
export interface ControlHost {
    addControl(control: IControlLike, position?: string): unknown;
    removeControl(control: IControlLike): unknown;
}

export interface WeatherControlOptions {
    onToggle: () => void;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
const COLUMN_SELECTOR = '.cloudtak-ctrl-group';
const TERRAIN_SELECTOR = ':scope > [title="Enable 3D Terrain"], :scope > [title="Disable 3D Terrain"]';
const SCOPE = `.cloudtak-ctrl-group > .${CONTROL_CLASS}`;

// Colours and sizes mimic .cloudtak-ctrl-btn in CloudTAK's Map.vue.
const CSS = `
${SCOPE} {
    float: none;
    clear: none;
    margin: 0;
    width: 100%;
    background: transparent;
    box-shadow: none;
    border-radius: 0;
    border-top: 1px solid var(--tblr-border-color);
    color: inherit;
}
${SCOPE} > button {
    position: relative;
    display: flex;
    align-items: center;
    justify-content: center;
    box-sizing: border-box;
    width: 100%;
    height: 38px;
    padding: 7px 0;
    border: 0;
    border-radius: 0;
    background: transparent;
    color: inherit;
    cursor: pointer;
    transition: background-color 0.15s ease;
}
${SCOPE} > button:focus-visible {
    outline: 2px solid #1E90FF;
    outline-offset: -2px;
}
${SCOPE} > button[aria-pressed='true'] {
    color: #1E90FF;
}
${SCOPE} > button svg {
    display: block;
    width: 24px;
    height: 24px;
}
${SCOPE} .taknz-wx-dot {
    position: absolute;
    top: 6px;
    right: 8px;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--tblr-primary, #1E90FF);
}
html[data-bs-theme='dark'] ${SCOPE} > button:hover,
html[data-bs-theme='dark'] ${SCOPE} > button:focus-visible {
    background-color: rgba(255, 255, 255, 0.12);
}
html[data-bs-theme='light'] ${SCOPE} > button:hover,
html[data-bs-theme='light'] ${SCOPE} > button:focus-visible {
    background-color: rgba(0, 0, 0, 0.06);
}
`;

let currentFocus: (() => void) | null = null;
/** The accessible name and base tooltip of the button; `active` is the state the dot shows. */
export function controlLabel(active: boolean): string {
    return active ? 'Weather Controls, layers on, controls hidden' : 'Weather Controls';
}

/** Move keyboard focus to the weather button, if a control is on the map. */
export function focusWeatherControl(): void {
    currentFocus?.();
}

/**
 * The weather toggle: a MapLibre control that lives in CloudTAK's left control column.
 *
 * Host facts (read from CloudTAK Map.vue / stores/map.ts / main.ts, and checked in a browser):
 * - The visible left column is NOT a MapLibre control. It is Vue-rendered DOM, a
 *   `.cloudtak-ctrl-group` inside the `.map-shell` that holds the map container, and it
 *   exists only in map mode 'Default'. Its children are `.cloudtak-ctrl-btn` divs; the 3D
 *   terrain button (title "Enable 3D Terrain" / "Disable 3D Terrain") is a `v-if` child
 *   that appears once the overlays have loaded. The app adds no control to MapLibre's
 *   own `top-left` container, which sits elsewhere on the map.
 * - Plugins are enabled when the map is fully loaded, so at that moment the column and
 *   the terrain button may or may not exist yet.
 * - MapLibre calls onAdd() and only then appends the returned element to its `top-left`
 *   container, so the element cannot be moved from inside onAdd(). place() must run
 *   after addControl() returns.
 *
 * So the control is added to `top-left` as the contract requires, then re-parented into
 * the column directly after the terrain button. Two MutationObservers (child lists only)
 * keep it there when Vue re-creates the column or flips the terrain/lock buttons. While
 * there is no column the element goes back to the `top-left` container, hidden.
 */
export class WeatherControl implements IControlLike {
    private readonly opts: WeatherControlOptions;
    private container: HTMLElement | undefined;
    private el: HTMLElement | undefined;
    private button: HTMLButtonElement | undefined;
    private dot: HTMLElement | undefined;
    private style: HTMLStyleElement | undefined;
    private shellObserver: MutationObserver | undefined;
    private columnObserver: MutationObserver | undefined;
    private observedColumn: Element | undefined;
    private focusRef: (() => void) | undefined;
    private destroyed = false;

    constructor(opts: WeatherControlOptions) {
        this.opts = opts;
    }

    onAdd(map: ControlMapLike): HTMLElement {
        this.container = map.getContainer();
        this.destroyed = false;

        const el = document.createElement('div');
        el.className = `maplibregl-ctrl maplibregl-ctrl-group ${CONTROL_CLASS}`;
        el.style.display = 'none';

        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'maplibregl-ctrl-icon';
        button.title = 'Weather Controls';
        button.setAttribute('aria-label', 'Weather Controls');
        button.setAttribute('aria-pressed', 'false');
        button.addEventListener('click', () => this.opts.onToggle());

        const svg = document.createElementNS(SVG_NS, 'svg');
        svg.setAttribute('width', '24');
        svg.setAttribute('height', '24');
        svg.setAttribute('viewBox', ICON_VIEW_BOX);
        svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
        svg.setAttribute('fill', 'currentColor');
        svg.setAttribute('aria-hidden', 'true');
        svg.setAttribute('focusable', 'false');
        const path = document.createElementNS(SVG_NS, 'path');
        path.setAttribute('d', ICON_PATH_DATA);
        svg.append(path);

        const dot = document.createElement('span');
        dot.className = 'taknz-wx-dot';
        dot.setAttribute('aria-hidden', 'true');
        dot.style.display = 'none';

        button.append(svg, dot);
        el.append(button);

        this.el = el;
        this.button = button;
        this.dot = dot;

        if (!document.getElementById(CONTROL_STYLE_ID)) {
            const style = document.createElement('style');
            style.id = CONTROL_STYLE_ID;
            style.textContent = CSS;
            document.head.append(style);
            this.style = style;
        }

        this.focusRef = () => this.focus();
        currentFocus = this.focusRef;
        return el;
    }

    onRemove(): void {
        this.destroy();
    }

    /** Put the element under the 3D terrain button, or hide it while there is no column. */
    place(): void {
        const el = this.el;
        if (!el || this.destroyed) return;

        const shell = this.container?.parentElement ?? null;
        const column = shell?.querySelector(COLUMN_SELECTOR) ?? null;

        if (shell && !this.shellObserver) {
            this.shellObserver = new MutationObserver(() => this.place());
            this.shellObserver.observe(shell, { childList: true });
        }

        if (!column) {
            this.columnObserver?.disconnect();
            this.observedColumn = undefined;
            const home = this.container?.querySelector('.maplibregl-ctrl-top-left') ?? null;
            if (home) {
                if (el.parentElement !== home) home.append(el);
            } else {
                el.remove();
            }
            el.style.display = 'none';
            return;
        }

        if (this.observedColumn !== column) {
            this.columnObserver?.disconnect();
            this.columnObserver = this.columnObserver ?? new MutationObserver(() => this.place());
            this.columnObserver.observe(column, { childList: true });
            this.observedColumn = column;
        }

        const terrain = column.querySelector(TERRAIN_SELECTOR);
        const inPlace = terrain
            ? el.parentElement === column && terrain.nextElementSibling === el
            : el.parentElement === column && column.lastElementChild === el;
        if (!inPlace) {
            if (terrain) terrain.after(el);
            else column.append(el);
        }
        el.style.display = '';
    }

    /** Mirror the open state of the panel (aria-pressed). */
    setOpen(open: boolean): void {
        this.button?.setAttribute('aria-pressed', open ? 'true' : 'false');
    }

    /**
     * Show or hide the small dot that says a weather layer is on and the controls are hidden.
     * The dot is not the only signal: the accessible name and the tooltip say it too.
     */
    setActive(active: boolean): void {
        if (this.dot) this.dot.style.display = active ? '' : 'none';
        const label = controlLabel(active);
        if (this.button) {
            this.button.setAttribute('aria-label', label);
            this.button.title = label;
        }
    }

    /** The tooltip. Call it after setActive(), which resets it; the accessible name is left alone. */
    setTitle(title: string): void {
        if (this.button) this.button.title = title;
    }

    focus(): void {
        this.button?.focus();
    }

    /** Remove the element, the style and the observers. Safe to call repeatedly. */
    destroy(): void {
        this.destroyed = true;
        this.shellObserver?.disconnect();
        this.columnObserver?.disconnect();
        this.shellObserver = undefined;
        this.columnObserver = undefined;
        this.observedColumn = undefined;
        this.el?.remove();
        this.el = undefined;
        this.button = undefined;
        this.dot = undefined;
        this.style?.remove();
        this.style = undefined;
        this.container = undefined;
        if (this.focusRef && currentFocus === this.focusRef) currentFocus = null;
        this.focusRef = undefined;
    }
}
