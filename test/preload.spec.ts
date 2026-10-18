import { describe, it, expect } from 'vitest';
import { PreloadTracker, RENDERS_BEFORE_READY } from '../lib/preload.ts';

const SRC = 'taknz-wx-precip-b-src';
const yes = (): boolean => true;
const no = (): boolean => false;

describe('PreloadTracker', () => {
    it('is not ready before it was armed', () => {
        const t = new PreloadTracker();
        expect(t.ready(SRC, 1, yes)).toBe(false);
    });

    it('is not ready before MapLibre reports progress, even if isSourceLoaded is already true', () => {
        const t = new PreloadTracker();
        t.arm(SRC, 1);
        expect(t.ready(SRC, 1, yes)).toBe(false);
        t.note('sourcedata', { sourceId: SRC, tile: {} });
        expect(t.ready(SRC, 1, yes)).toBe(false);
        t.note('sourcedata', { sourceId: 'other-src' });
        expect(t.ready(SRC, 1, yes)).toBe(false);
    });

    it('is ready after a source-level sourcedata event, a matching key and a loaded source', () => {
        const t = new PreloadTracker();
        t.arm(SRC, 1);
        t.note('sourcedata', { sourceId: SRC });
        expect(t.ready(SRC, 1, yes)).toBe(true);
        expect(t.ready(SRC, 1, no)).toBe(false);
    });

    it('does not accept another key', () => {
        const t = new PreloadTracker();
        t.arm(SRC, 1);
        t.note('sourcedata', { sourceId: SRC });
        expect(t.ready(SRC, 2, yes)).toBe(false);
    });

    it('arming again (a new setTiles) resets the readiness', () => {
        const t = new PreloadTracker();
        t.arm(SRC, 1);
        t.note('sourcedata', { sourceId: SRC });
        t.arm(SRC, 2);
        expect(t.ready(SRC, 2, yes)).toBe(false);
        t.note('sourcedata', { sourceId: SRC });
        expect(t.ready(SRC, 2, yes)).toBe(true);
    });

    it('falls back to render events when no source event comes', () => {
        const t = new PreloadTracker();
        t.arm(SRC, 1);
        for (let i = 0; i < RENDERS_BEFORE_READY - 1; i++) t.note('render');
        expect(t.ready(SRC, 1, yes)).toBe(false);
        t.note('render');
        expect(t.ready(SRC, 1, yes)).toBe(true);
    });

    it('render events before arming do not count', () => {
        const t = new PreloadTracker();
        t.note('render');
        t.note('render');
        t.arm(SRC, 1);
        expect(t.ready(SRC, 1, yes)).toBe(false);
    });

    it('retarget keeps the progress and changes the key', () => {
        const t = new PreloadTracker();
        t.arm(SRC, 1);
        t.note('sourcedata', { sourceId: SRC });
        t.retarget(SRC, 2);
        expect(t.ready(SRC, 1, yes)).toBe(false);
        expect(t.ready(SRC, 2, yes)).toBe(true);
        t.retarget('unknown', 3);
        expect(t.has('unknown')).toBe(false);
    });

    it('drop and clear forget a source', () => {
        const t = new PreloadTracker();
        t.arm(SRC, 1);
        t.arm('b', 1);
        t.drop(SRC);
        expect(t.has(SRC)).toBe(false);
        t.clear();
        expect(t.has('b')).toBe(false);
    });

    it('ignores unknown event types and malformed events', () => {
        const t = new PreloadTracker();
        t.arm(SRC, 1);
        t.note('idle');
        t.note('sourcedata');
        t.note('sourcedata', { sourceId: 7 });
        expect(t.ready(SRC, 1, yes)).toBe(false);
    });
});
