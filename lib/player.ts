/**
 * Play: steps the timeline through the last two hours (and, when asked, the Rain forecast).
 *
 * Throttled loading. Every frame is a set of map tiles that come through the relay, so
 * Play is built to load as few as possible, as late as possible:
 *   1. one frame ahead, never two;
 *   2. the hidden buffer loads frame k+1 while frame k is shown;
 *   3. it advances only when the hidden buffer reports loaded, or 3000 ms after k was
 *      shown, so a slow or failing tile never stalls the loop for longer;
 *   4. the swap is a change of opacity, so there is no moveLayer and no source re-creation;
 *   5. the buffer that was just replaced takes frame k+2;
 *   6. tiles of an exact frame are immutable and carry `max-age=3600`, so the second pass
 *      over the same frames is served by the browser cache;
 *   7. a relay 429 suspends playback instead of retrying it.
 *
 * Timing: 700 ms per frame, 1200 ms hold on the last frame, then back to -12.
 * All timers are injected, so the state machine runs under fake timers in the tests.
 */
import { FRAME_MAX, FRAME_MIN } from './time.ts';

export const FRAME_MS = 700;
export const HOLD_MS = 1200;
/** Longest wait for the tiles of the next frame, counted from when the current frame was shown. */
export const MAX_WAIT_MS = 3000;
export const POLL_MS = 100;
/** MapLibre errors carry no Retry-After, so a suspension never lasts longer than this. */
export const MAX_SUSPEND_MS = 60_000;

export type StopReason = 'user' | 'panel' | 'disable' | 'health' | 'layers';

/** The frames Play runs through: the last two hours, plus the forecast when asked and Rain is on. */
export function playRange(rainOn: boolean, playForecast: boolean): { first: number; last: number } {
    return { first: FRAME_MIN, last: rainOn && playForecast ? FRAME_MAX : 0 };
}

export interface PlayerDeps {
    range(): { first: number; last: number };
    /** At least one layer is on. */
    hasLayers(): boolean;
    /** The committed frame. */
    frame(): number;
    /** Commit `frame` and load `preload` into the hidden buffers (null = load nothing). */
    show(frame: number, preload: number | null): void;
    preloadReady(key: number): boolean;
    now(): number;
    setTimer(fn: () => void, ms: number): unknown;
    clearTimer(handle: unknown): void;
    /** Reports the state: `playing` (also while suspended) and when a suspension ends. */
    onState(playing: boolean, resumeAt: number | null): void;
}

export class Player {
    private deps: PlayerDeps;
    private timer: unknown;
    private playing = false;
    private suspendedUntil: number | null = null;
    private disposed = false;
    private shownAt = 0;
    private current = 0;
    /** The frame loaded into the hidden buffer (null = none). */
    private preloading: number | null = null;

    constructor(deps: PlayerDeps) {
        this.deps = deps;
    }

    get isPlaying(): boolean {
        return this.playing;
    }

    get isSuspended(): boolean {
        return this.suspendedUntil !== null;
    }

    private clear(): void {
        if (this.timer !== undefined) this.deps.clearTimer(this.timer);
        this.timer = undefined;
    }

    private schedule(ms: number): void {
        this.clear();
        this.timer = this.deps.setTimer(() => {
            this.timer = undefined;
            this.tick();
        }, ms);
    }

    /** The frame after `k`, wrapping to the first one after the last. */
    private successor(k: number): number {
        const { first, last } = this.deps.range();
        return k < last ? k + 1 : first;
    }

    private dwell(k: number): number {
        return k >= this.deps.range().last ? HOLD_MS : FRAME_MS;
    }

    private showFrame(k: number): void {
        this.current = k;
        this.shownAt = this.deps.now();
        this.preloading = this.successor(k);
        this.deps.show(k, this.preloading);
        this.schedule(this.dwell(k));
    }

    /**
     * Play, or resume at once when a suspension is running. Starts at the committed frame
     * when that is inside the range, before the last frame and not Now (the resting
     * position, which replays the last two hours), else at the first frame.
     * Does nothing without a layer on.
     */
    start(): void {
        if (this.disposed || !this.deps.hasLayers()) return;

        if (this.playing && this.suspendedUntil === null) return;
        const resuming = this.playing;
        this.playing = true;
        this.suspendedUntil = null;
        this.deps.onState(true, null);

        const { first, last } = this.deps.range();
        const frame = this.deps.frame();
        const from = resuming ? this.current : (frame >= first && frame < last && frame !== 0 ? frame : first);
        this.showFrame(from > last ? first : from);
    }

    /** Stop and keep the shown frame. Safe to call at any time. */
    stop(reason: StopReason = 'user'): void {
        void reason;
        const was = this.playing;
        this.clear();
        this.playing = false;
        this.suspendedUntil = null;
        if (was) this.deps.onState(false, null);
    }

    /** Pause until `untilMs` (epoch ms, at most MAX_SUSPEND_MS away), then continue by itself. */
    suspend(untilMs: number): void {
        if (this.disposed || !this.playing || this.suspendedUntil !== null) return;
        const now = this.deps.now();
        const until = Math.min(Math.max(untilMs, now), now + MAX_SUSPEND_MS);

        this.suspendedUntil = until;
        // Drop the preload: its tiles may have failed, and it stops further requests.
        this.preloading = null;
        this.deps.show(this.current, null);
        this.deps.onState(true, until);
        this.schedule(until - now);
    }

    /** Stop for good: no timers, no restart. */
    dispose(): void {
        this.stop('disable');
        this.disposed = true;
    }

    private tick(): void {
        if (this.disposed || !this.playing) return;

        if (this.suspendedUntil !== null) {
            this.start();
            return;
        }

        if (!this.deps.hasLayers()) {
            this.stop('layers');
            return;
        }

        const { first, last } = this.deps.range();
        if (this.current > last || this.current < first) {
            this.showFrame(first);
            return;
        }

        const next = this.successor(this.current);
        const waited = this.deps.now() - this.shownAt;
        const dwell = this.dwell(this.current);
        if (waited < dwell) {
            this.schedule(dwell - waited);
            return;
        }

        // The range changed under us (Rain or the forecast option switched): load the right frame.
        if (this.preloading !== next) {
            this.preloading = next;
            this.deps.show(this.current, next);
        }

        if (this.deps.preloadReady(next) || waited >= MAX_WAIT_MS) {
            this.showFrame(next);
            return;
        }
        this.schedule(Math.min(POLL_MS, MAX_WAIT_MS - waited));
    }
}

let bound: Player | null = null;

/** The components talk to the active player through these; they do nothing while none is bound. */
export function bindPlayer(player: Player | null): void {
    bound = player;
}

export function togglePlay(): void {
    if (!bound) return;
    if (bound.isPlaying && !bound.isSuspended) bound.stop('user');
    else bound.start();
}

export function stopPlay(): void {
    bound?.stop('user');
}
