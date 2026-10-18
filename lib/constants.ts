import type { PaletteCode, WeatherLayer } from './types.ts';

export const MENU_KEY = 'weather';
export const ROUTE_NAME = 'home-menu-plugin-weather';
export const ROUTE_PATH = 'plugin-weather';
export const BOTTOM_KEY = 'taknz-weather';
/** Id in the plugin panel events (see lib/panel-coordinator.ts). */
export const PANEL_ID = BOTTOM_KEY;
export const STORAGE_KEY = 'taknz-weather:v1';
/** Schema version of the stored settings object (the storage key is unchanged). */
export const SETTINGS_VERSION = 3;
export const ID_PREFIX = 'taknz-wx-';

export const STATUS_PATH = '/api/weather/status';
export const TILE_PATH = '/api/weather/tile/{z}/{x}/{y}.png';
export const STATUS_TIMEOUT_MS = 8000;

export const ATTRIBUTION = 'Weather © <a href="https://rainbow.ai" target="_blank" rel="noopener">Rainbow.ai</a>';

export const WEATHER_LAYERS: readonly WeatherLayer[] = ['clouds', 'precip-global', 'precip', 'radars'];
export const API_VERSIONS_SUPPORTED: readonly number[] = [1];

export const PALETTES: readonly PaletteCode[] = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];
export const CONTROL_STYLE_ID = 'taknz-wx-control-style';
export const CONTROL_CLASS = 'taknz-wx-ctrl';
