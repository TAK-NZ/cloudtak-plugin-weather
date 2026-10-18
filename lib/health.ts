import type { HealthState } from './types.ts';
import { ID_PREFIX } from './constants.ts';

export const PAUSE_MS = 60_000;
export const BURST_WINDOW_MS = 10_000;
export const BURST_COUNT = 5;

/** The text shown to the user for a health state ('' when ok). */
export function healthMessage(s: HealthState): string {
    switch (s.kind) {
        case 'ok': return '';
        case 'limited': return 'Rate limited, retrying';
        case 'denied': return s.status === 401 ? 'Session expired: reload CloudTAK' : 'Weather is disabled by an administrator';
        case 'degraded': return s.status === 400 || s.status === 404 ? 'Weather unavailable' : 'Weather service unavailable';
    }
}

/** Short text for the status icon of the panel ('' when ok). */
export function healthShort(s: HealthState): string {
    switch (s.kind) {
        case 'ok': return '';
        case 'limited': return 'Rate limited, retrying';
        case 'denied': return s.status === 401 ? 'Session expired' : 'Disabled by admin';
        case 'degraded': return 'Weather unavailable';
    }
}

/** What the caller should do in response to a map error. */
export type HealthAction = 'none' | 'refresh-token' | 'refetch-status';

export interface MapErrorLike {
    sourceId?: unknown;
    error?: unknown;
}

export interface HealthOptions {
    now?: () => number;
    onChange?: (state: HealthState) => void;
    log?: Pick<Console, 'warn' | 'error'>;
}

/**
 * Turns MapLibre error events of the weather sources into a HealthState.
 * Messages never contain a URL.
 */
export class HealthMonitor {
    private now: () => number;
    private onChange?: (state: HealthState) => void;
    private log: Pick<Console, 'warn' | 'error'>;
    private current: HealthState = { kind: 'ok' };
    private retryAt = 0;
    private userRetry = false;
    private tokenRefreshed = false;
    private clientErrorLogged = false;
    private errorTimes: number[] = [];

    constructor(opts: HealthOptions = {}) {
        this.now = opts.now ?? Date.now;
        this.onChange = opts.onChange;
        this.log = opts.log ?? console;
    }

    get state(): HealthState {
        return this.current;
    }

    message(): string {
        return healthMessage(this.current);
    }

    private set(next: HealthState, retryAt: number): void {
        const prev = this.current;
        const changed = prev.kind !== next.kind
            || (prev.kind === 'degraded' && next.kind === 'degraded' && prev.status !== next.status)
            || (prev.kind === 'denied' && next.kind === 'denied' && prev.status !== next.status);

        this.current = next;
        this.retryAt = retryAt;
        if (!changed) return;

        this.log.warn(`[weather] ${this.message()}`);
        this.onChange?.(next);
    }

    /** Feed a MapLibre `error` event. Errors of other sources are ignored. */
    onMapError(e: MapErrorLike): HealthAction {
        if (typeof e.sourceId !== 'string' || !e.sourceId.startsWith(ID_PREFIX)) return 'none';

        const raw = (e.error as { status?: unknown } | null | undefined)?.status;
        const status = typeof raw === 'number' ? raw : undefined;
        const now = this.now();

        if (status === undefined) {
            this.errorTimes = this.errorTimes.filter((t) => now - t < BURST_WINDOW_MS);
            this.errorTimes.push(now);
            if (this.errorTimes.length >= BURST_COUNT && this.current.kind === 'ok') {
                this.set({ kind: 'degraded', since: now }, now + PAUSE_MS);
            }
            return 'none';
        }

        if (status === 429) {
            if (this.current.kind === 'limited' && this.current.until > now) return 'none';
            this.set({ kind: 'limited', until: now + PAUSE_MS }, now + PAUSE_MS);
            return 'none';
        }

        if (status === 401) {
            const first = !this.tokenRefreshed;
            this.tokenRefreshed = true;
            this.set({ kind: 'denied', status: 401 }, now + PAUSE_MS);
            return first ? 'refresh-token' : 'none';
        }

        if (status === 403) {
            this.set({ kind: 'denied', status: 403 }, now + PAUSE_MS);
            return 'refetch-status';
        }

        if (status === 400 || status === 404) {
            if (!this.clientErrorLogged) {
                this.clientErrorLogged = true;
                this.log.error(`[weather] Relay rejected a tile request (HTTP ${status})`);
            }
            this.set({ kind: 'degraded', since: now, status }, now + PAUSE_MS);
            return 'none';
        }

        if (status >= 500 && status <= 599) {
            this.set({ kind: 'degraded', since: now, status }, now + PAUSE_MS);
        }
        return 'none';
    }

    /** First loaded tile of a weather source: back to ok. */
    onTileLoaded(sourceId?: unknown): void {
        if (typeof sourceId === 'string' && !sourceId.startsWith(ID_PREFIX)) return;

        this.errorTimes = [];
        this.tokenRefreshed = false;
        this.userRetry = false;
        if (this.current.kind !== 'ok') {
            this.current = { kind: 'ok' };
            this.retryAt = 0;
            this.onChange?.(this.current);
        }
    }

    /** A user action (toggle, slider commit) earns exactly one retry. */
    noteUserAction(): void {
        if (this.current.kind !== 'ok') this.userRetry = true;
    }

    /**
     * May a tile-URL change be applied now? While not ok it is queued (false),
     * except for one retry per user action or per 60 s.
     */
    gate(): boolean {
        if (this.current.kind === 'ok') return true;

        const now = this.now();
        if (this.userRetry) {
            this.userRetry = false;
            this.retryAt = now + PAUSE_MS;
            return true;
        }
        if (now >= this.retryAt) {
            this.retryAt = now + PAUSE_MS;
            return true;
        }
        return false;
    }
}
