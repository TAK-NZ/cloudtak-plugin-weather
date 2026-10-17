import type { PaletteCode, TileRequest } from './types.ts';
import { PALETTES } from './constants.ts';

export interface PrecipTileOptions {
    color: PaletteCode;
    /** Minutes ahead: 0, 10, ... 240 */
    forecast: number;
    snapshot: number;
    coverage: boolean;
}

export interface CloudsTileOptions {
    snapshot: number;
}

export interface RadarsTileOptions {
    color: PaletteCode;
    snapshot: number;
    coverage: boolean;
    usePrecipType: boolean;
}

function checkSnapshot(snapshot: number): string {
    if (!Number.isInteger(snapshot) || snapshot <= 0 || snapshot % 600 !== 0) {
        throw new RangeError(`Invalid snapshot: ${snapshot}`);
    }
    return String(snapshot);
}

function checkPalette(color: PaletteCode): PaletteCode {
    if (!PALETTES.includes(color)) throw new RangeError(`Invalid palette: ${String(color)}`);
    return color;
}

function checkForecast(forecast: number): string {
    if (!Number.isInteger(forecast) || forecast < 0 || forecast > 240 || forecast % 10 !== 0) {
        throw new RangeError(`Invalid forecast: ${forecast}`);
    }
    return String(forecast);
}

/**
 * Query pairs in the fixed wire order layer, color, forecast, snapshot, coverage, use_precip_type.
 * Never emits api, key, provider or size.
 */
export function tileRequest(layer: 'precip' | 'precip-global', opts: PrecipTileOptions): TileRequest;
export function tileRequest(layer: 'clouds', opts: CloudsTileOptions): TileRequest;
export function tileRequest(layer: 'radars', opts: RadarsTileOptions): TileRequest;
export function tileRequest(
    layer: 'precip' | 'precip-global' | 'clouds' | 'radars',
    opts: PrecipTileOptions | CloudsTileOptions | RadarsTileOptions
): TileRequest {
    const query: [string, string][] = [['layer', layer]];

    if (layer === 'clouds') {
        query.push(['snapshot', checkSnapshot(opts.snapshot)]);
        return { layer, query };
    }

    if (layer === 'radars') {
        const o = opts as RadarsTileOptions;
        query.push(['color', checkPalette(o.color)]);
        query.push(['snapshot', checkSnapshot(o.snapshot)]);
        if (o.coverage) query.push(['coverage', '1']);
        if (o.usePrecipType) query.push(['use_precip_type', '1']);
        return { layer, query };
    }

    if (layer === 'precip' || layer === 'precip-global') {
        const o = opts as PrecipTileOptions;
        query.push(['color', checkPalette(o.color)]);
        query.push(['forecast', checkForecast(o.forecast)]);
        query.push(['snapshot', checkSnapshot(o.snapshot)]);
        if (o.coverage) query.push(['coverage', '1']);
        return { layer, query };
    }

    throw new RangeError(`Invalid layer: ${String(layer)}`);
}
