// Colours for the palette legend in the weather settings.
// The colours were sampled from the colours the Rainbow API returns for palettes 0-9 (rain and
// snow), not copied from any image. A strip runs from light to heavy precipitation. Smooth palettes
// have 16 evenly spaced stops; palettes with hard colour steps (Meteored and Universal Blue rain)
// have the first and last colour of every block. Snow strips that are the same colours share one array.
import type { PaletteCode } from './types.ts';

/** Palette names, as shown in the settings dropdowns. */
export const PALETTE_NAMES: Record<PaletteCode, string> = {
    '0': 'Rainbow',
    '1': 'TWC',
    '2': 'Dark Sky',
    '3': 'Meteored',
    '4': 'Nexrad',
    '5': 'Rainviewer',
    '6': 'Selex',
    '7': 'Titan',
    '8': 'Universal Blue',
    '9': 'TWC RV',
};

const SNOW_SHARED_DARK_SKY: readonly string[] = [
    '#bafaff', '#a1e1ff', '#82c2ff', '#68a8ff', '#5696ff', '#4989ff', '#3a7aff', '#2e6eff',
    '#2161ff', '#1454ff', '#0544ff', '#0037ff', '#002aff', '#001eff', '#000fff', '#0002ff',
];

const SNOW_SHARED_TITAN: readonly string[] = [
    '#bdfdff', '#a3e3ff', '#84c4ff', '#6aaaff', '#5797ff', '#4888ff', '#3b7bff', '#2f6fff',
    '#2060ff', '#1353ff', '#0746ff', '#0036ff', '#0029ff', '#001dff', '#000eff', '#0001ff',
];

/** Rain colours per palette, light to heavy. */
export const RAIN_STOPS: Record<PaletteCode, readonly string[]> = {
    '0': [
        '#ddf5ff', '#ddf5ff', '#ddf5ff', '#ddf5ff', '#ddf5ff', '#d3f0ff', '#c2eaff', '#b1e3ff',
        '#9cd6ff', '#8bc8ff', '#7cbcff', '#579cff', '#3480ff', '#1b49da', '#5344e1', '#ff9571',
    ],
    '1': [
        '#bae5b8', '#bae5b8', '#bae5b8', '#bae5b8', '#bae5b8', '#bae5b8', '#bae5b8', '#bae5b8',
        '#a2dc9f', '#7bcf77', '#54c24f', '#2db426', '#14900e', '#0d430a', '#d5cd0d', '#d33e05',
    ],
    '2': [
        '#8e4b9b', '#a44c92', '#ba4e89', '#d04f81', '#e65178', '#fc5370', '#fc676f', '#fd7b6f',
        '#fd7b6f', '#fd8f6e', '#fea36e', '#ffb76e', '#ffc559', '#ffd344', '#ffe12f', '#ffef19',
    ],
    '3': [
        '#3ffefc', '#0000f3', '#74f560', '#16731e', '#feff49', '#f67d2c', '#ed2222', '#67061d',
        '#f649d1', '#5a2d71',
    ],
    '4': [
        '#03e9e7', '#00eee7', '#007cf7', '#0033c5', '#00f000', '#04a903', '#6aab03', '#f7eb00',
        '#f3b600', '#fe5800', '#d70000', '#bd0000', '#e40098', '#c331dc', '#eadbf2', '#fefefe',
    ],
    '5': [
        '#dfdfdf', '#9bea8f', '#65fa51', '#4ace6d', '#47a5c5', '#2370fc', '#3f55d9', '#a06cb5',
        '#ff7177', '#f2332d', '#ce330f', '#ffda0b', '#ff9811', '#a84c06', '#d295cd', '#f8edff',
    ],
    '6': [
        '#009f9f', '#008c4b', '#00c423', '#1af420', '#a6fd1d', '#ffe40a', '#ffbb00', '#ff9200',
        '#f94800', '#e90d08', '#d4043f', '#e90ac0', '#ff33ff', '#ff66ff', '#ff8eff', '#ffa6ff',
    ],
    '7': [
        '#353535', '#747574', '#006100', '#017e2b', '#0c73dd', '#2c3be1', '#920dac', '#c43186',
        '#c77268', '#e2a037', '#fce514', '#fec035', '#fe7626', '#fd4512', '#caa29d', '#cecece',
    ],
    '8': [
        '#88ddee', '#004768', '#ffee00', '#ff8100', '#ff4400', '#5d0000', '#ffaaff', '#ff4eff',
        '#ffffff', '#ffffff',
    ],
    '9': [
        '#63eb63', '#63eb63', '#44cd44', '#2bae37', '#198829', '#0f6016', '#074209', '#ffff00',
        '#ff9800', '#f03200', '#d70000', '#b90000', '#960000', '#820000', '#690000', '#d000c5',
    ],
};

/** Snow colours per palette, light to heavy. Palettes 2, 6 and 9 share one set, and 7 and 8 share one set. */
export const SNOW_STOPS: Record<PaletteCode, readonly string[]> = {
    '0': [
        '#d4f8ff', '#d4f8ff', '#d4f8ff', '#d4f8ff', '#d4f8ff', '#d4f8ff', '#d4f8ff', '#d4f8ff',
        '#d4f8ff', '#bbf2ff', '#98ecff', '#31e1ff', '#00d4f1', '#00b7dc', '#009cd0', '#0079b8',
    ],
    '1': [
        '#83f7ff', '#83f7ff', '#83f7ff', '#83f7ff', '#83f7ff', '#83f7ff', '#83f7ff', '#73e6f3',
        '#36a5c7', '#258eb7', '#2383b0', '#217baa', '#1f72a4', '#1e6a9f', '#11367b', '#080c5e',
    ],
    '2': SNOW_SHARED_DARK_SKY,
    '3': [
        '#3df9fb', '#168ff8', '#0005f3', '#31c176', '#36d241', '#439639', '#bed247', '#fdd543',
        '#f09427', '#e96c38', '#f65b5b', '#d60000', '#b81538', '#eb5aeb', '#914bbd', '#522b6b',
    ],
    '4': [
        '#03e9e7', '#00daea', '#007bf7', '#0051a7', '#00ea00', '#059a03', '#88bb02', '#f5e600',
        '#f6a900', '#fe3f00', '#d10000', '#bd0000', '#ee00c0', '#a747cc', '#eee2f4', '#fefefe',
    ],
    '5': [
        '#8efeff', '#7eeeff', '#71e1ff', '#62d2ff', '#53b7ff', '#43a3ff', '#3696ff', '#2787ff',
        '#1777ff', '#0968ff', '#005bff', '#004cff', '#003dff', '#002eff', '#0021ff', '#0011ff',
    ],
    '6': SNOW_SHARED_DARK_SKY,
    '7': SNOW_SHARED_TITAN,
    '8': SNOW_SHARED_TITAN,
    '9': SNOW_SHARED_DARK_SKY,
};

/** CSS background for a legend strip. */
export function gradientCss(stops: readonly string[]): string {
    return `linear-gradient(to right, ${stops.join(', ')})`;
}
