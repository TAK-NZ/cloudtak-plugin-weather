/** One map layer per slot. Regional Rain is `precip`, Global Rain is `precip-global`. */
export type LayerSlot = 'clouds' | 'precip-global' | 'precip' | 'radars';
export type WeatherLayer = LayerSlot;
/** The independent on/off switches of the settings. */
export type ToggleKey = 'clouds' | 'precipGlobal' | 'precipRegional' | 'radars';
export type PaletteCode = '0' | '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9' | 'dbz_u8';
export type TimeZoneSetting = 'Pacific/Auckland' | 'UTC' | 'local';

export interface WeatherSettings {
    version: 3;
    clouds: boolean;
    /** Rain, Regional. */
    precipRegional: boolean;
    /** Rain, Global. */
    precipGlobal: boolean;
    radars: boolean;
    opacity: Record<LayerSlot, number>;
    /** `precip` is shared by both Rain layers. */
    palette: { precip: PaletteCode; radars: PaletteCode };
    coverage: boolean;
    radarsPrecipType: boolean;
    tileSize: 256 | 512;
    timeZone: TimeZoneSetting;
    /** Play also steps through the Rain forecast (only with a Rain layer on). */
    playForecast: boolean;
}

export interface RelayStatus {
    apiVersion: number;
    enabled: boolean;
    serverTime: number;
    snapshot: number;
    layers: string[];
    /** Newest snapshot per layer (relays that support the timeline only). */
    latest?: Partial<Record<WeatherLayer, number>>;
    stepSeconds?: number;
    windowSeconds?: number;
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
