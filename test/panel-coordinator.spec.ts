// SPDX-License-Identifier: MIT-0
// Tests for lib/panel-coordinator.ts; copy them together with the helper.
import { expect, it } from 'vitest';
import { createPanelCoordinator, PANEL_CLOSE, PANEL_OPEN } from '../lib/panel-coordinator.ts';
import type { PanelCoordinator, PanelEventDetail } from '../lib/panel-coordinator.ts';

interface Fake {
    id: string;
    calls: string[];
    coordinator: PanelCoordinator;
    shown: boolean;
    state: boolean;
    dots: boolean[];
}

/** A plugin built on the helper. It is shown while `shown` is true; minimizing and closing hide it. */
function plugin(target: EventTarget, id: string, state = false): Fake {
    const fake: Fake = { id, calls: [], coordinator: null as unknown as PanelCoordinator, shown: true, state, dots: [] };
    fake.coordinator = createPanelCoordinator({
        id,
        target,
        isShown: () => fake.shown,
        hasState: () => fake.state,
        close: () => { fake.calls.push('close'); fake.shown = false; },
        minimize: () => { fake.calls.push('minimize'); fake.shown = false; },
        restore: () => { fake.calls.push('restore'); fake.shown = true; },
        onMinimizedChange: (v) => { fake.dots.push(v); },
    });
    return fake;
}

/** Records the panel events sent by plugin `from`, in order, as `open:id` or `close:id` or `close:id>by`. */
function record(target: EventTarget, from = 'a'): string[] {
    const log: string[] = [];
    const take = (kind: string) => (e: Event): void => {
        const d = (e as CustomEvent<PanelEventDetail>).detail;
        if (d.id !== from) return;
        log.push(`${kind}:${d.id}${d.by ? `>${d.by}` : ''}`);
    };
    target.addEventListener(PANEL_OPEN, take('open'));
    target.addEventListener(PANEL_CLOSE, take('close'));
    return log;
}

function fire(target: EventTarget, type: string, detail: unknown): void {
    target.dispatchEvent(new CustomEvent(type, { detail }));
}

it('a foreign open while shown with state minimizes once and raises the flag', () => {
    const t = new EventTarget();
    const a = plugin(t, 'a', true);
    const log = record(t);
    fire(t, PANEL_OPEN, { id: 'b', area: 'bottom' });
    expect(a.calls).toEqual(['minimize']);
    expect(a.coordinator.minimized).toBe(true);
    expect(a.dots).toEqual([true]);
    expect(log).toEqual([]);
});

it('a foreign open while shown without state closes once and announces panel-close with by', () => {
    const t = new EventTarget();
    const a = plugin(t, 'a', false);
    const log = record(t);
    fire(t, PANEL_OPEN, { id: 'b', area: 'bottom' });
    expect(a.calls).toEqual(['close']);
    expect(a.coordinator.minimized).toBe(false);
    expect(log).toEqual(['close:a>b']);
});

it('a foreign open while not shown does nothing', () => {
    const t = new EventTarget();
    const a = plugin(t, 'a', true);
    a.shown = false;
    fire(t, PANEL_OPEN, { id: 'b', area: 'bottom' });
    expect(a.calls).toEqual([]);
    expect(a.coordinator.minimized).toBe(false);
});

it('its own events are ignored', () => {
    const t = new EventTarget();
    const a = plugin(t, 'a', true);
    fire(t, PANEL_OPEN, { id: 'a', area: 'bottom' });
    expect(a.calls).toEqual([]);
    fire(t, PANEL_OPEN, { id: 'b', area: 'bottom' });
    fire(t, PANEL_CLOSE, { id: 'a', area: 'bottom' });
    expect(a.calls).toEqual(['minimize']);
    expect(a.coordinator.minimized).toBe(true);
});

it('malformed details are ignored', () => {
    const t = new EventTarget();
    const a = plugin(t, 'a', true);
    for (const detail of [undefined, null, 'b', 7, {}, { id: '' , area: 'bottom' }, { id: 7, area: 'bottom' }, { id: 'b' }, { id: 'b', area: 'top' }]) {
        fire(t, PANEL_OPEN, detail);
    }
    expect(a.calls).toEqual([]);
    t.dispatchEvent(new Event(PANEL_OPEN));
    expect(a.calls).toEqual([]);
    fire(t, PANEL_OPEN, { id: 'b', area: 'bottom' });
    for (const detail of [undefined, null, {}, { id: 'b' }, { id: 'b', area: 'top' }]) {
        fire(t, PANEL_CLOSE, detail);
    }
    expect(a.calls).toEqual(['minimize']);
    expect(a.coordinator.minimized).toBe(true);
});

it('a close from the opener restores without announcing panel-open', () => {
    const t = new EventTarget();
    const a = plugin(t, 'a', true);
    fire(t, PANEL_OPEN, { id: 'b', area: 'bottom' });
    const log = record(t);
    fire(t, PANEL_CLOSE, { id: 'b', area: 'bottom' });
    expect(a.calls).toEqual(['minimize', 'restore']);
    expect(a.coordinator.minimized).toBe(false);
    expect(a.dots).toEqual([true, false]);
    expect(log).toEqual([]);
});

it('a close from another id is ignored', () => {
    const t = new EventTarget();
    const a = plugin(t, 'a', true);
    fire(t, PANEL_OPEN, { id: 'b', area: 'bottom' });
    fire(t, PANEL_CLOSE, { id: 'c', area: 'bottom' });
    expect(a.calls).toEqual(['minimize']);
    expect(a.coordinator.minimized).toBe(true);
});

it('a close with by retargets without restoring, and a later close from by restores', () => {
    const t = new EventTarget();
    const a = plugin(t, 'a', true);
    fire(t, PANEL_OPEN, { id: 'b', area: 'bottom' });
    fire(t, PANEL_CLOSE, { id: 'b', area: 'bottom', by: 'c' });
    expect(a.calls).toEqual(['minimize']);
    expect(a.coordinator.minimized).toBe(true);
    fire(t, PANEL_CLOSE, { id: 'b', area: 'bottom' });
    expect(a.calls, 'b is no longer the one it waits for').toEqual(['minimize']);
    fire(t, PANEL_CLOSE, { id: 'c', area: 'bottom' });
    expect(a.calls).toEqual(['minimize', 'restore']);
    expect(a.coordinator.minimized).toBe(false);
});

it('a close whose by names the waiting plugin restores it', () => {
    const t = new EventTarget();
    const a = plugin(t, 'a', true);
    fire(t, PANEL_OPEN, { id: 'b', area: 'bottom' });
    fire(t, PANEL_CLOSE, { id: 'b', area: 'bottom', by: 'a' });
    expect(a.calls).toEqual(['minimize', 'restore']);
});

it('restoreFromSelector restores, announces panel-open once and stops waiting', () => {
    const t = new EventTarget();
    const a = plugin(t, 'a', true);
    fire(t, PANEL_OPEN, { id: 'b', area: 'bottom' });
    const log = record(t);
    a.coordinator.restoreFromSelector();
    expect(a.calls).toEqual(['minimize', 'restore']);
    expect(a.coordinator.minimized).toBe(false);
    expect(log).toEqual(['open:a']);
    fire(t, PANEL_CLOSE, { id: 'b', area: 'bottom' });
    expect(a.calls, 'it no longer waits for b').toEqual(['minimize', 'restore']);
});

it('restoreFromSelector does nothing when not minimized', () => {
    const t = new EventTarget();
    const a = plugin(t, 'a', true);
    const log = record(t);
    a.coordinator.restoreFromSelector();
    expect(a.calls).toEqual([]);
    expect(log).toEqual([]);
});

it('closed() announces panel-close without by when shown', () => {
    const t = new EventTarget();
    const a = plugin(t, 'a', true);
    const log = record(t);
    a.coordinator.closed();
    expect(log).toEqual(['close:a']);
});

it('closed() while minimized announces panel-close with by = the plugin it waits for, and clears the flag', () => {
    const t = new EventTarget();
    const a = plugin(t, 'a', true);
    fire(t, PANEL_OPEN, { id: 'b', area: 'bottom' });
    const log = record(t);
    a.coordinator.closed();
    expect(log).toEqual(['close:a>b']);
    expect(a.coordinator.minimized).toBe(false);
    expect(a.dots).toEqual([true, false]);
    fire(t, PANEL_CLOSE, { id: 'b', area: 'bottom' });
    expect(a.calls, 'a plugin that closed never reopens by itself').toEqual(['minimize']);
});

it('opened() announces panel-open and clears a pending wait', () => {
    const t = new EventTarget();
    const a = plugin(t, 'a', true);
    fire(t, PANEL_OPEN, { id: 'b', area: 'bottom' });
    const log = record(t);
    a.coordinator.opened();
    expect(log).toEqual(['open:a']);
    expect(a.coordinator.minimized).toBe(false);
    fire(t, PANEL_CLOSE, { id: 'b', area: 'bottom' });
    expect(a.calls).toEqual(['minimize']);
});

it('a second foreign open while minimized does not minimize twice', () => {
    const t = new EventTarget();
    const a = plugin(t, 'a', true);
    fire(t, PANEL_OPEN, { id: 'b', area: 'bottom' });
    fire(t, PANEL_OPEN, { id: 'c', area: 'bottom' });
    expect(a.calls).toEqual(['minimize']);
    // Even a plugin that wrongly reports itself shown while minimized does not yield twice.
    a.shown = true;
    fire(t, PANEL_OPEN, { id: 'd', area: 'bottom' });
    expect(a.calls).toEqual(['minimize']);
    fire(t, PANEL_CLOSE, { id: 'b', area: 'bottom' });
    expect(a.calls, 'it still waits for the first opener').toEqual(['minimize', 'restore']);
});

it('dispose removes both listeners and clears the flag', () => {
    const t = new EventTarget();
    const a = plugin(t, 'a', true);
    fire(t, PANEL_OPEN, { id: 'b', area: 'bottom' });
    a.coordinator.dispose();
    expect(a.coordinator.minimized).toBe(false);
    expect(a.dots).toEqual([true, false]);
    a.shown = true;
    fire(t, PANEL_OPEN, { id: 'c', area: 'bottom' });
    fire(t, PANEL_CLOSE, { id: 'b', area: 'bottom' });
    expect(a.calls).toEqual(['minimize']);
});

it('three plugins: each restores in reverse order', () => {
    const t = new EventTarget();
    const a = plugin(t, 'a', true);
    const b = plugin(t, 'b', true);
    const c = plugin(t, 'c', true);
    a.shown = true;
    b.shown = false;
    c.shown = false;
    // b opens: a yields.
    b.shown = true;
    b.coordinator.opened();
    expect(a.calls).toEqual(['minimize']);
    // c opens: b yields, a stays hidden (not shown).
    c.shown = true;
    c.coordinator.opened();
    expect(b.calls).toEqual(['minimize']);
    expect(a.calls).toEqual(['minimize']);
    // c closes: b restores, a stays hidden.
    c.shown = false;
    c.coordinator.closed();
    expect(b.calls).toEqual(['minimize', 'restore']);
    expect(a.calls).toEqual(['minimize']);
    // b closes: a restores.
    b.shown = false;
    b.coordinator.closed();
    expect(a.calls).toEqual(['minimize', 'restore']);
    expect(a.coordinator.minimized).toBe(false);
    expect(b.coordinator.minimized).toBe(false);
});

it('middle plugin closes (no state): the first plugin restores only after the last one closes', () => {
    const t = new EventTarget();
    const a = plugin(t, 'a', true);
    const b = plugin(t, 'b', false);
    const c = plugin(t, 'c', false);
    b.shown = false;
    c.shown = false;
    // b opens: a minimizes for b.
    b.shown = true;
    b.coordinator.opened();
    expect(a.coordinator.minimized).toBe(true);
    // c opens: b has no state and closes, announcing panel-close with by = c.
    c.shown = true;
    c.coordinator.opened();
    expect(b.calls).toEqual(['close']);
    expect(b.shown).toBe(false);
    expect(a.calls, 'a keeps waiting: it now waits for c').toEqual(['minimize']);
    expect(a.coordinator.minimized).toBe(true);
    // c closes: a restores.
    c.shown = false;
    c.coordinator.closed();
    expect(a.calls).toEqual(['minimize', 'restore']);
    expect(a.coordinator.minimized).toBe(false);
    expect(b.shown, 'b never reopens by itself').toBe(false);
});

it('a minimized plugin that goes away while waiting hands the wait to the one waiting for it', () => {
    const t = new EventTarget();
    const a = plugin(t, 'a', true);
    const b = plugin(t, 'b', true);
    a.shown = true;
    b.shown = false;
    b.shown = true;
    b.coordinator.opened();
    const c = plugin(t, 'c', true);
    c.coordinator.opened();
    expect(b.coordinator.minimized).toBe(true);
    expect(a.coordinator.minimized).toBe(true);
    // b is removed while minimized for c: a retargets to c.
    b.coordinator.closed();
    expect(a.calls).toEqual(['minimize']);
    c.shown = false;
    c.coordinator.closed();
    expect(a.calls).toEqual(['minimize', 'restore']);
});

/** Panel events as they travel, in order: `open:id`, `open:id!` (restored) and `close:id>by`. */
function wire(target: EventTarget): string[] {
    const log: string[] = [];
    const take = (kind: string) => (e: Event): void => {
        const d = (e as CustomEvent<PanelEventDetail>).detail;
        log.push(`${kind}:${d.id}${kind === 'open' && d.restored ? '!' : ''}${d.by ? `>${d.by}` : ''}`);
    };
    target.addEventListener(PANEL_OPEN, take('open'));
    target.addEventListener(PANEL_CLOSE, take('close'));
    return log;
}

it('only a selector restore carries restored: true; opened() does not', () => {
    const t = new EventTarget();
    const a = plugin(t, 'a', true);
    fire(t, PANEL_OPEN, { id: 'b', area: 'bottom' });
    const log = wire(t);
    a.coordinator.restoreFromSelector();
    a.coordinator.opened();
    expect(log).toEqual(['open:a!', 'open:a']);
});

it('a plain foreign open does not retarget a minimized plugin', () => {
    const t = new EventTarget();
    const a = plugin(t, 'a', true);
    fire(t, PANEL_OPEN, { id: 'b', area: 'bottom' });
    for (const restored of [undefined, false]) {
        fire(t, PANEL_OPEN, { id: 'c', area: 'bottom', restored });
    }
    fire(t, PANEL_CLOSE, { id: 'c', area: 'bottom' });
    expect(a.calls, 'c is not the one it waits for').toEqual(['minimize']);
    fire(t, PANEL_CLOSE, { id: 'b', area: 'bottom' });
    expect(a.calls).toEqual(['minimize', 'restore']);
});

it('a malformed restored field is ignored: only the boolean true retargets', () => {
    for (const restored of ['true', 1, {}, [], null, 'yes']) {
        const t = new EventTarget();
        const a = plugin(t, 'a', true);
        fire(t, PANEL_OPEN, { id: 'b', area: 'bottom' });
        fire(t, PANEL_OPEN, { id: 'c', area: 'bottom', restored });
        fire(t, PANEL_CLOSE, { id: 'c', area: 'bottom' });
        expect(a.calls, `restored=${JSON.stringify(restored)} must not retarget`).toEqual(['minimize']);
        fire(t, PANEL_CLOSE, { id: 'b', area: 'bottom' });
        expect(a.calls).toEqual(['minimize', 'restore']);
    }
});

it('a restored open from a foreign plugin retargets a minimized plugin to that opener', () => {
    const t = new EventTarget();
    const a = plugin(t, 'a', true);
    fire(t, PANEL_OPEN, { id: 'b', area: 'bottom' });
    fire(t, PANEL_OPEN, { id: 'c', area: 'bottom', restored: true });
    fire(t, PANEL_CLOSE, { id: 'b', area: 'bottom' });
    expect(a.calls, 'b is no longer the one it waits for').toEqual(['minimize']);
    fire(t, PANEL_CLOSE, { id: 'c', area: 'bottom' });
    expect(a.calls).toEqual(['minimize', 'restore']);
});

it('a restored open from itself is ignored', () => {
    const t = new EventTarget();
    const a = plugin(t, 'a', true);
    fire(t, PANEL_OPEN, { id: 'b', area: 'bottom' });
    fire(t, PANEL_OPEN, { id: 'a', area: 'bottom', restored: true });
    expect(a.coordinator.minimized).toBe(true);
    fire(t, PANEL_CLOSE, { id: 'b', area: 'bottom' });
    expect(a.calls).toEqual(['minimize', 'restore']);
});

it('restoring A from its selector makes a minimized B wait for A (no overlap when the top plugin C closes)', () => {
    // Both registration orders: the outcome must not depend on which listener runs first.
    for (const order of [['a', 'b', 'c'], ['c', 'b', 'a'], ['b', 'c', 'a']]) {
        const t = new EventTarget();
        const made: Record<string, Fake> = {};
        for (const id of order) made[id] = plugin(t, id, id !== 'c');
        const { a, b, c } = made;
        const shownCount = (): number => [a, b, c].filter((p) => p.shown).length;
        a.shown = true;
        b.shown = false;
        c.shown = false;
        b.shown = true;
        b.coordinator.opened();
        c.shown = true;
        c.coordinator.opened();
        expect(a.coordinator.minimized && b.coordinator.minimized, `${order}: A and B wait`).toBe(true);
        expect(shownCount()).toBe(1);
        // A is restored from its selector: C (no state) closes, B now waits for A.
        a.coordinator.restoreFromSelector();
        expect(c.calls, `${order}`).toEqual(['close']);
        expect(a.shown && !b.shown && !c.shown, `${order}: only A is shown`).toBe(true);
        expect(b.coordinator.minimized, `${order}: B stays minimized`).toBe(true);
        // A closes: B restores.
        a.shown = false;
        a.coordinator.closed();
        expect(b.calls, `${order}`).toEqual(['minimize', 'restore']);
        expect(shownCount()).toBe(1);
        expect(b.shown).toBe(true);
    }
});

it('chain A, B, C (all with state): every close order restores in turn and never shows two at once', () => {
    // `away` lists the order in which the plugins go away (the user closes them, or Remove Sheet).
    // Minimized plugins can go away too; they hand their wait on through `by`.
    const cases: { away: string[]; restores: string[] }[] = [
        { away: ['c', 'b', 'a'], restores: ['b', 'a'] },
        { away: ['c', 'a', 'b'], restores: ['b'] },
        { away: ['b', 'c', 'a'], restores: ['a'] },
        { away: ['b', 'a', 'c'], restores: [] },
        { away: ['a', 'b', 'c'], restores: [] },
        { away: ['a', 'c', 'b'], restores: ['b'] },
    ];
    for (const { away, restores } of cases) {
        const t = new EventTarget();
        const a = plugin(t, 'a', true);
        const b = plugin(t, 'b', true);
        const c = plugin(t, 'c', true);
        const all: Record<string, Fake> = { a, b, c };
        const shownCount = (): number => Object.values(all).filter((p) => p.shown).length;
        b.shown = false;
        c.shown = false;
        b.shown = true;
        b.coordinator.opened();
        c.shown = true;
        c.coordinator.opened();
        expect(shownCount(), `${away}: only c shown`).toBe(1);
        expect(c.shown).toBe(true);
        const restored: string[] = [];
        for (const id of away) {
            const p = all[id];
            const was = Object.fromEntries(Object.entries(all).map(([k, v]) => [k, v.calls.filter((x) => x === 'restore').length]));
            p.shown = false;
            p.coordinator.closed();
            for (const [k, v] of Object.entries(all)) {
                if (v.calls.filter((x) => x === 'restore').length > was[k]) restored.push(k);
            }
            expect(shownCount() <= 1, `${away}: after ${id} went away at most one plugin is shown`).toBeTruthy();
        }
        expect(restored, `${away}`).toEqual(restores);
    }
});
