import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WeatherControl, focusWeatherControl } from '../lib/control.ts';
import { ICON_PATH_DATA, ICON_VIEW_BOX } from '../lib/icon.ts';
import { CONTROL_CLASS, CONTROL_STYLE_ID } from '../lib/constants.ts';
import { EventedFakeMap } from './helpers.ts';

function btn(title: string): HTMLElement {
    const el = document.createElement('div');
    el.setAttribute('role', 'button');
    el.title = title;
    el.className = 'cloudtak-ctrl-btn';
    return el;
}

let map: EventedFakeMap;
let column: HTMLElement;
let onToggle: ReturnType<typeof vi.fn<() => void>>;
let control: WeatherControl;

const microtask = (): Promise<void> => Promise.resolve();
const titles = (): string[] => [...column.children].map((c) => c.getAttribute('title') ?? c.className);
const buttonOf = (): HTMLButtonElement => document.querySelector(`.${CONTROL_CLASS} button`) as HTMLButtonElement;
const elOf = (): HTMLElement => document.querySelector(`.${CONTROL_CLASS}`) as HTMLElement;

function makeColumn(...titlesIn: string[]): HTMLElement {
    const col = document.createElement('div');
    col.className = 'cloudtak-ctrl-group cloudtak-panel';
    for (const t of titlesIn) col.append(btn(t));
    return col;
}

function add(): void {
    map.addControl(control, 'top-left');
    control.place();
}

beforeEach(() => {
    map = new EventedFakeMap();
    column = makeColumn('Search Button', 'Zoom In Button', 'Zoom Out Button', 'Enable 3D Terrain');
    map.shell.append(column);
    onToggle = vi.fn();
    control = new WeatherControl({ onToggle });
});

afterEach(() => {
    control.destroy();
    map.dispose();
    document.getElementById(CONTROL_STYLE_ID)?.remove();
});

describe('markup', () => {
    it('is a MapLibre control group with an accessible button', () => {
        add();
        const el = elOf();
        expect(el.className).toBe(`maplibregl-ctrl maplibregl-ctrl-group ${CONTROL_CLASS}`);
        const b = buttonOf();
        expect(b.type).toBe('button');
        expect(b.className).toBe('maplibregl-ctrl-icon');
        expect(b.title).toBe('Weather Controls');
        expect(b.getAttribute('aria-label')).toBe('Weather Controls');
        expect(b.getAttribute('aria-pressed')).toBe('false');
    });

    it('draws the shared icon as a decorative 24 px svg', () => {
        add();
        const svg = buttonOf().querySelector('svg') as SVGElement;
        expect(svg.namespaceURI).toBe('http://www.w3.org/2000/svg');
        expect(svg.getAttribute('viewBox')).toBe(ICON_VIEW_BOX);
        expect(svg.getAttribute('width')).toBe('24');
        expect(svg.getAttribute('height')).toBe('24');
        expect(svg.getAttribute('fill')).toBe('currentColor');
        expect(svg.getAttribute('aria-hidden')).toBe('true');
        expect(svg.getAttribute('focusable')).toBe('false');
        expect(svg.querySelector('path')?.getAttribute('d')).toBe(ICON_PATH_DATA);
    });

    it('starts hidden in the top-left container until place() runs', () => {
        map.addControl(control, 'top-left');
        expect(elOf().style.display).toBe('none');
        expect(elOf().parentElement).toBe(map.topLeft);
        control.place();
        expect(elOf().style.display).toBe('');
        expect(elOf().parentElement).toBe(column);
    });

    it('injects one style element', () => {
        add();
        expect(document.querySelectorAll(`#${CONTROL_STYLE_ID}`)).toHaveLength(1);
        expect(document.getElementById(CONTROL_STYLE_ID)?.textContent).toContain('.cloudtak-ctrl-group > .taknz-wx-ctrl');
    });
});

describe('state', () => {
    it('click calls onToggle', () => {
        add();
        buttonOf().click();
        buttonOf().click();
        expect(onToggle).toHaveBeenCalledTimes(2);
    });

    it('setOpen drives aria-pressed', () => {
        add();
        control.setOpen(true);
        expect(buttonOf().getAttribute('aria-pressed')).toBe('true');
        control.setOpen(false);
        expect(buttonOf().getAttribute('aria-pressed')).toBe('false');
    });

    it('setActive shows the dot and puts the state in the accessible name and tooltip', () => {
        add();
        const dot = buttonOf().querySelector('.taknz-wx-dot') as HTMLElement;
        expect(dot.style.display).toBe('none');
        control.setActive(true);
        expect(dot.style.display).toBe('');
        expect(buttonOf().getAttribute('aria-label')).toBe('Weather Controls, layers on, controls hidden');
        expect(buttonOf().title).toBe('Weather Controls, layers on, controls hidden');
        control.setActive(false);
        expect(dot.style.display).toBe('none');
        expect(buttonOf().getAttribute('aria-label')).toBe('Weather Controls');
        expect(buttonOf().title).toBe('Weather Controls');
    });

    it('setTitle changes only the tooltip', () => {
        add();
        control.setTitle('Weather Controls: Weather unavailable');
        expect(buttonOf().title).toBe('Weather Controls: Weather unavailable');
        expect(buttonOf().getAttribute('aria-label')).toBe('Weather Controls');
        control.setActive(true);
        control.setTitle('Weather Controls, layers on, controls hidden: Weather unavailable');
        expect(buttonOf().getAttribute('aria-label')).toBe('Weather Controls, layers on, controls hidden');
    });

    it('focus() and focusWeatherControl() focus the button', () => {
        add();
        control.focus();
        expect(document.activeElement).toBe(buttonOf());
        buttonOf().blur();
        focusWeatherControl();
        expect(document.activeElement).toBe(buttonOf());
    });

    it('focusWeatherControl does nothing after destroy', () => {
        add();
        control.destroy();
        expect(() => focusWeatherControl()).not.toThrow();
    });
});

describe('placement', () => {
    it('places the element directly after the terrain button', () => {
        add();
        expect(titles()).toEqual(['Search Button', 'Zoom In Button', 'Zoom Out Button', 'Enable 3D Terrain', elOf().className]);
    });

    it('also matches the "Disable 3D Terrain" title', () => {
        column.querySelector('[title="Enable 3D Terrain"]')?.setAttribute('title', 'Disable 3D Terrain');
        column.append(btn('Map is locked to marker - Click to Unlock'));
        add();
        const terrain = column.querySelector('[title="Disable 3D Terrain"]') as HTMLElement;
        expect(terrain.nextElementSibling).toBe(elOf());
    });

    it('goes to the end of the column without a terrain button', () => {
        column.querySelector('[title="Enable 3D Terrain"]')?.remove();
        add();
        expect(column.lastElementChild).toBe(elOf());
    });

    it('moves under a terrain button that appears later', async () => {
        column.querySelector('[title="Enable 3D Terrain"]')?.remove();
        add();
        expect(column.lastElementChild).toBe(elOf());

        const terrain = btn('Enable 3D Terrain');
        column.append(terrain);
        await microtask();
        expect(terrain.nextElementSibling).toBe(elOf());
    });

    it('keeps a lock button that appears later below the control', async () => {
        add();
        column.append(btn('Map is locked to marker - Click to Unlock'));
        await microtask();
        const terrain = column.querySelector('[title="Enable 3D Terrain"]') as HTMLElement;
        const lock = column.querySelector('[title^="Map is locked"]') as HTMLElement;
        expect(terrain.nextElementSibling).toBe(elOf());
        expect(elOf().nextElementSibling).toBe(lock);
    });

    it('falls to the end of the column when the terrain button is removed', async () => {
        column.append(btn('Map is locked to marker - Click to Unlock'));
        add();
        column.querySelector('[title="Enable 3D Terrain"]')?.remove();
        await microtask();
        expect(column.lastElementChild).toBe(elOf());
    });

    it('does not touch the column when already in place', async () => {
        add();
        const log: MutationRecord[] = [];
        const spy = new MutationObserver((r) => log.push(...r));
        spy.observe(column, { childList: true });
        control.place();
        control.place();
        await microtask();
        expect(spy.takeRecords()).toEqual([]);
        expect(log).toEqual([]);
        spy.disconnect();
    });

    it('returns to the top-left container, hidden, when the column goes away, and comes back', async () => {
        add();
        column.remove();
        await microtask();
        expect(elOf().parentElement).toBe(map.topLeft);
        expect(elOf().style.display).toBe('none');

        const next = makeColumn('Search Button', 'Enable 3D Terrain');
        map.shell.append(next);
        await microtask();
        expect(elOf().parentElement).toBe(next);
        expect(elOf().style.display).toBe('');
        expect(next.querySelector('[title="Enable 3D Terrain"]')?.nextElementSibling).toBe(elOf());
    });

    it('follows terrain changes of a re-created column', async () => {
        add();
        column.remove();
        await microtask();
        const next = makeColumn('Search Button');
        map.shell.append(next);
        await microtask();
        expect(next.lastElementChild).toBe(elOf());

        const terrain = btn('Enable 3D Terrain');
        next.insertBefore(terrain, next.firstElementChild);
        await microtask();
        expect(terrain.nextElementSibling).toBe(elOf());
    });

    it('is removed when there is no column and no top-left container', () => {
        map.addControl(control, 'top-left');
        column.remove();
        map.topLeft.remove();
        control.place();
        expect(document.querySelector(`.${CONTROL_CLASS}`)).toBeNull();
    });

    it('stays hidden when the column is missing from the start', () => {
        column.remove();
        add();
        expect(elOf().parentElement).toBe(map.topLeft);
        expect(elOf().style.display).toBe('none');
    });
});

describe('destroy', () => {
    it('removes the element and the style and stops moving it', async () => {
        add();
        control.destroy();
        expect(document.querySelector(`.${CONTROL_CLASS}`)).toBeNull();
        expect(document.getElementById(CONTROL_STYLE_ID)).toBeNull();

        column.append(btn('x'));
        column.remove();
        map.shell.append(makeColumn('Enable 3D Terrain'));
        await microtask();
        expect(document.querySelector(`.${CONTROL_CLASS}`)).toBeNull();
        control.place();
        expect(document.querySelector(`.${CONTROL_CLASS}`)).toBeNull();
    });

    it('is idempotent', () => {
        add();
        control.destroy();
        expect(() => control.destroy()).not.toThrow();
        expect(() => control.onRemove()).not.toThrow();
    });

    it('removeControl leaves nothing in the document', () => {
        add();
        map.removeControl(control);
        expect(document.querySelector(`.${CONTROL_CLASS}`)).toBeNull();
        expect(document.getElementById(CONTROL_STYLE_ID)).toBeNull();
        expect(map.controls).toEqual([]);
    });

    it('does not remove a style it did not create', () => {
        const foreign = document.createElement('style');
        foreign.id = CONTROL_STYLE_ID;
        document.head.append(foreign);
        add();
        control.destroy();
        expect(document.getElementById(CONTROL_STYLE_ID)).toBe(foreign);
    });
});
