/**
 * Pacing for Play. The first pass over the frames loads every visible tile of every layer
 * that is on, which can be far more than the relay allows in a minute (it caps cache
 * misses per user and upstream fetches per task). The Player asks a FramePacer before it
 * starts loading the next frame and waits until a token bucket can pay for it.
 *
 * Cost of a frame = (tile requests of that frame not fetched in the last 50 minutes) x
 * (visible tiles per request). Hidden layers have no request, and a frame that was
 * loaded before comes from the browser cache, so both cost nothing.
 *
 * Pure: no timers, no DOM. The clock is injected.
 */

/**
 * Mutable so the tests and the browser harness can change it.
 * Rate 180 tiles a minute with a burst of 90 keeps any 60 s window at 270 tiles or less.
 */
export const pacing = { enabled: true, ratePerMin: 180, burst: 90 };

/** How long a fetched tile request counts as cached (the relay serves tiles for an hour). */
export const SEEN_MS = 50 * 60_000;

/** Tiles a frame costs when the map size is unknown (1900 x 1400 at 512). */
export const FALLBACK_TILES = 20;

export interface BucketParams {
    ratePerMin: number;
    burst: number;
}

/**
 * Tokens refill continuously up to the capacity. Taking more than is available is allowed
 * and leaves a debt that later refills pay off first.
 */
export class TokenBucket {
    private tokens: number;
    private at: number;
    private now: () => number;
    private params: () => BucketParams;

    constructor(now: () => number, params: () => BucketParams) {
        this.now = now;
        this.params = params;
        this.tokens = params().burst;
        this.at = now();
    }

    /** The capacity is the burst, or the cost when one request is larger than the burst. */
    private refill(cost: number): void {
        const { ratePerMin, burst } = this.params();
        const t = this.now();
        const capacity = Math.max(burst, cost);
        if (t > this.at) this.tokens = Math.min(capacity, this.tokens + (t - this.at) * ratePerMin / 60_000);
        else this.tokens = Math.min(capacity, this.tokens);
        this.at = Math.max(this.at, t);
    }

    /** Milliseconds until `cost` tokens are available (0 = now). */
    delayMs(cost: number): number {
        if (cost <= 0) return 0;
        this.refill(cost);
        if (this.tokens >= cost) return 0;
        const rate = this.params().ratePerMin / 60_000;
        return rate > 0 ? Math.ceil((cost - this.tokens) / rate) : Number.POSITIVE_INFINITY;
    }

    /** Take `cost` tokens now, even when that leaves a debt. */
    take(cost: number): void {
        if (cost <= 0) return;
        this.refill(cost);
        this.tokens -= cost;
    }
}

/** Tiles on screen for a map of this size: the grid plus one for the partly covered edges. */
export function estimateTiles(widthPx: number, heightPx: number, tileSize: number): number {
    if (!(widthPx > 0) || !(heightPx > 0) || !(tileSize > 0)) return FALLBACK_TILES;
    return (Math.ceil(widthPx / tileSize) + 1) * (Math.ceil(heightPx / tileSize) + 1);
}

export interface FramePacerDeps {
    /** The tile request identities of a frame (no token), one per layer that has data there. */
    keysOf(frame: number): string[];
    tilesPerSlot(): number;
    now(): number;
}

export class FramePacer {
    private deps: FramePacerDeps;
    private bucket: TokenBucket;
    private seen = new Map<string, number>();

    constructor(deps: FramePacerDeps) {
        this.deps = deps;
        this.bucket = new TokenBucket(deps.now, () => pacing);
    }

    private unseen(frame: number): string[] {
        const t = this.deps.now();
        for (const [key, at] of this.seen) if (t - at >= SEEN_MS) this.seen.delete(key);
        return this.deps.keysOf(frame).filter((k) => !this.seen.has(k));
    }

    /** Milliseconds to wait before the frame may start loading (0 = go). */
    delayMs(frame: number): number {
        const keys = this.unseen(frame);
        if (keys.length === 0) return 0;
        return this.bucket.delayMs(keys.length * this.deps.tilesPerSlot());
    }

    /** The frame starts loading: pay for it and remember its requests. */
    charge(frame: number): void {
        const keys = this.unseen(frame);
        if (keys.length === 0) return;
        this.bucket.take(keys.length * this.deps.tilesPerSlot());
        const t = this.deps.now();
        for (const k of keys) this.seen.set(k, t);
    }
}
