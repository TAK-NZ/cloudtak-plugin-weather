import type { Host, RelayStatus, TileRequest } from './types.ts';
import { API_VERSIONS_SUPPORTED, STATUS_PATH, STATUS_TIMEOUT_MS, TILE_PATH } from './constants.ts';

export type StatusReason = 'ok' | 'disabled' | 'not-found' | 'unauthorized' | 'network' | 'invalid' | 'unsupported';

export interface StatusResult {
    status: RelayStatus | null;
    reason: StatusReason;
}

export function parseStatus(raw: unknown): RelayStatus | null {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
    const o = raw as Record<string, unknown>;

    if (!Number.isInteger(o.apiVersion)) return null;
    if (typeof o.enabled !== 'boolean') return null;
    if (!Number.isInteger(o.serverTime)) return null;
    if (!Number.isInteger(o.snapshot) || (o.snapshot as number) % 600 !== 0) return null;
    if (!Array.isArray(o.layers) || !o.layers.every((l) => typeof l === 'string')) return null;

    return {
        apiVersion: o.apiVersion as number,
        enabled: o.enabled,
        serverTime: o.serverTime as number,
        snapshot: o.snapshot as number,
        layers: [...(o.layers as string[])],
    };
}

export function isSupported(s: RelayStatus): boolean {
    return API_VERSIONS_SUPPORTED.includes(s.apiVersion);
}

/**
 * Ask the CloudTAK server whether the weather relay is available. Never throws.
 */
export async function fetchStatus(host: Host): Promise<StatusResult> {
    let token: string | undefined;
    try {
        token = await host.token();
    } catch {
        token = undefined;
    }
    if (!token) return { status: null, reason: 'unauthorized' };

    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), STATUS_TIMEOUT_MS);

    try {
        const res = await host.fetch(host.origin() + STATUS_PATH, {
            headers: { Authorization: `Bearer ${token}` },
            signal: ctl.signal,
        });

        if (res.status === 404) return { status: null, reason: 'not-found' };
        if (res.status === 401 || res.status === 403) return { status: null, reason: 'unauthorized' };
        if (!res.ok) return { status: null, reason: 'network' };

        let raw: unknown;
        try {
            raw = await res.json();
        } catch {
            return { status: null, reason: ctl.signal.aborted ? 'network' : 'invalid' };
        }

        const status = parseStatus(raw);
        if (!status) return { status: null, reason: 'invalid' };
        if (!isSupported(status)) return { status, reason: 'unsupported' };
        if (!status.enabled) return { status, reason: 'disabled' };
        return { status, reason: 'ok' };
    } catch {
        return { status: null, reason: 'network' };
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Pure builder: {z}/{x}/{y} stay literal for MapLibre, the session token is always last.
 */
export function buildTileTemplate(origin: string, req: TileRequest, token: string): string {
    const pairs = req.query.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`);
    pairs.push(`token=${encodeURIComponent(token)}`);
    return `${origin}${TILE_PATH}?${pairs.join('&')}`;
}

/** The session token could not be read (not signed in, or the host refused). */
export class TokenUnavailableError extends Error {
    constructor(message: string, options?: { cause?: unknown }) {
        super(message, options);
        this.name = 'TokenUnavailableError';
    }
}

/**
 * Tile URL template with a freshly read session token.
 * Throws TokenUnavailableError when there is no token.
 */
export async function tileTemplate(host: Host, req: TileRequest): Promise<string> {
    let token: string | undefined;
    try {
        token = await host.token();
    } catch (err) {
        throw new TokenUnavailableError('Token unavailable', { cause: err });
    }
    if (!token) throw new TokenUnavailableError('Not signed in');
    return buildTileTemplate(host.origin(), req, token);
}
