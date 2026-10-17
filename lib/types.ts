export type LayerSlot = 'clouds' | 'precip' | 'radars';
export type PrecipMode = 'none' | 'precip' | 'precip-global';
export type WeatherLayer = 'precip' | 'precip-global' | 'clouds' | 'radars';
export type PaletteCode = '0' | '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | 'dbz_u8';
export type TimeZoneSetting = 'Pacific/Auckland' | 'UTC' | 'local';

export interface WeatherSettings {
    version: 1;
    precip: PrecipMode;
    clouds: boolean;
    radars: boolean;
    opacity: Record<LayerSlot, number>;
    palette: { precip: PaletteCode; radars: PaletteCode };
    coverage: boolean;
    radarsPrecipType: boolean;
    tileSize: 256 | 512;
    timeZone: TimeZoneSetting;
}

export interface RelayStatus {
    apiVersion: number;
    enabled: boolean;
    serverTime: number;
    snapshot: number;
    layers: string[];
}

export type HealthState =
    | { kind: 'ok' }
    | { kind: 'degraded'; since: number; status?: number }
    | { kind: 'limited'; until: number }
    | { kind: 'denied'; status: 401 | 403 };

export interface Host {
    origin(): string;
    token(): Promise<string | undefined>;
    fetch(input: string, init?: RequestInit): Promise<Response>;
}

export interface StorageLike {
    getItem(k: string): string | null | undefined;
    setItem(k: string, v: string): void;
}

/** Query pairs (in wire order) for one relay tile request. */
export interface TileRequest {
    layer: WeatherLayer;
    query: [string, string][];
}
