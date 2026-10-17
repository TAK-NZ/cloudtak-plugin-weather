import type { PaletteCode } from './types.ts';

export const MENU_KEY = 'weather';
export const ROUTE_NAME = 'home-menu-plugin-weather';
export const ROUTE_PATH = 'plugin-weather';
export const BOTTOM_KEY = 'taknz-weather';
export const STORAGE_KEY = 'taknz-weather:v1';
/** Schema version of the stored settings object (the storage key is unchanged). */
export const SETTINGS_VERSION = 2;
export const ID_PREFIX = 'taknz-wx-';

export const STATUS_PATH = '/api/weather/status';
export const TILE_PATH = '/api/weather/tile/{z}/{x}/{y}.png';
export const STATUS_TIMEOUT_MS = 8000;

export const ATTRIBUTION = 'Weather data provided by <a href="https://rainbow.ai" target="_blank" rel="noopener">Rainbow.ai</a>';

export const API_VERSIONS_SUPPORTED: readonly number[] = [1];

export const PALETTES: readonly PaletteCode[] = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'dbz_u8'];
export const FORECAST_NOTE = 'Clouds and radar always show the current data. Forecast applies to rain only.';
