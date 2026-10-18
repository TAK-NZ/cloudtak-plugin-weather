<template>
    <div
        class='col-12 px-3 py-2 d-flex flex-column gap-3'
        data-test='weather-settings'
    >
        <section class='d-flex flex-column gap-2'>
            <h3 class='card-title m-0'>
                Opacity
            </h3>
            <div
                v-for='slot in SLOTS'
                :key='slot.key'
                class='d-flex align-items-center gap-2'
            >
                <label
                    class='form-label m-0'
                    style='width: 7rem;'
                    :for='`${id}-opacity-${slot.key}`'
                    v-text='slot.label'
                />
                <input
                    :id='`${id}-opacity-${slot.key}`'
                    type='range'
                    class='form-range flex-grow-1 m-0'
                    style='min-width: 0;'
                    min='0.1'
                    max='1'
                    step='0.05'
                    :value='settings.opacity[slot.key]'
                    :aria-label='`${slot.label} opacity`'
                    :data-test='`opacity-${slot.key}`'
                    @input='onOpacity(slot.key, $event)'
                >
                <span
                    class='text-secondary text-end'
                    style='width: 3rem;'
                    v-text='`${Math.round(settings.opacity[slot.key] * 100)}%`'
                />
            </div>
        </section>

        <section class='d-flex flex-column gap-2'>
            <h3 class='card-title m-0'>
                Colour palette
            </h3>
            <div class='d-flex align-items-center gap-2'>
                <label
                    class='form-label m-0'
                    style='width: 5rem;'
                    :for='`${id}-palette-precip`'
                >Rain</label>
                <select
                    :id='`${id}-palette-precip`'
                    class='form-select'
                    data-test='palette-precip'
                    :value='settings.palette.precip'
                    @change='onPalette("precip", $event)'
                >
                    <option
                        v-for='code in PALETTES'
                        :key='code'
                        :value='code'
                        v-text='`Palette ${code}`'
                    />
                </select>
            </div>
            <div class='d-flex align-items-center gap-2'>
                <label
                    class='form-label m-0'
                    style='width: 5rem;'
                    :for='`${id}-palette-radars`'
                >Radar</label>
                <select
                    :id='`${id}-palette-radars`'
                    class='form-select'
                    data-test='palette-radars'
                    :value='settings.palette.radars'
                    @change='onPalette("radars", $event)'
                >
                    <option
                        v-for='code in PALETTES'
                        :key='code'
                        :value='code'
                        v-text='`Palette ${code}`'
                    />
                </select>
            </div>
        </section>

        <section class='d-flex flex-column gap-2'>
            <h3 class='card-title m-0'>
                Options
            </h3>
            <label class='form-check m-0'>
                <input
                    type='checkbox'
                    class='form-check-input'
                    data-test='coverage'
                    :checked='settings.coverage'
                    @change='setCoverage(checked($event))'
                >
                <span class='form-check-label'>Show coverage mask (rain and radar)</span>
            </label>
            <label class='form-check m-0'>
                <input
                    type='checkbox'
                    class='form-check-input'
                    data-test='precip-type'
                    :checked='settings.radarsPrecipType'
                    @change='setRadarsPrecipType(checked($event))'
                >
                <span class='form-check-label'>Show precipitation type on radar</span>
            </label>
            <label class='form-check m-0'>
                <input
                    type='checkbox'
                    class='form-check-input'
                    data-test='play-forecast'
                    :checked='settings.playForecast'
                    @change='setPlayForecast(checked($event))'
                >
                <span class='form-check-label'>Include forecast when playing</span>
            </label>
        </section>

        <fieldset
            class='d-flex flex-column gap-1 border-0 p-0 m-0'
            role='radiogroup'
            aria-label='Map tiles'
        >
            <legend class='card-title fs-4 mb-1'>
                Map tiles
            </legend>
            <label class='form-check m-0'>
                <input
                    type='radio'
                    class='form-check-input'
                    :name='`${id}-tiles`'
                    data-test='tiles-512'
                    :checked='settings.tileSize === 512'
                    @change='setTileSize(512)'
                >
                <span class='form-check-label'>Standard</span>
            </label>
            <label class='form-check m-0'>
                <input
                    type='radio'
                    class='form-check-input'
                    :name='`${id}-tiles`'
                    data-test='tiles-256'
                    :checked='settings.tileSize === 256'
                    @change='setTileSize(256)'
                >
                <span class='form-check-label'>Sharper (about 4x requests; Play loads more tiles)</span>
            </label>
        </fieldset>

        <fieldset
            class='d-flex flex-column gap-1 border-0 p-0 m-0'
            role='radiogroup'
            aria-label='Time zone'
        >
            <legend class='card-title fs-4 mb-1'>
                Time zone
            </legend>
            <p class='text-secondary small m-0'>
                The zone is shown after the time in the timeline.
            </p>
            <label
                v-for='tz in ZONES'
                :key='tz.value'
                class='form-check m-0'
            >
                <input
                    type='radio'
                    class='form-check-input'
                    :name='`${id}-tz`'
                    :data-test='`tz-${tz.value}`'
                    :checked='settings.timeZone === tz.value'
                    @change='setTimeZone(tz.value)'
                >
                <span
                    class='form-check-label'
                    v-text='tz.label'
                />
            </label>
        </fieldset>

        <section class='d-flex flex-column gap-1'>
            <h3 class='card-title m-0'>
                About the layers
            </h3>
            <ul
                class='small text-secondary m-0 ps-3 d-flex flex-column gap-1'
                data-test='about-layers'
            >
                <li>Rain is precipitation derived from radar. Rain Regional covers New Zealand and the nearby Pacific in more detail; Rain Global covers the world. Both can be on at the same time. Only Rain has a forecast, up to 4 hours ahead.</li>
                <li>Radar shows observed radar echoes.</li>
                <li>Clouds shows satellite cloud cover.</li>
            </ul>
        </section>

        <section class='d-flex flex-column gap-1'>
            <h3 class='card-title m-0'>
                Timeline
            </h3>
            <ul
                class='small text-secondary m-0 ps-3 d-flex flex-column gap-1'
                data-test='about-timeline'
            >
                <li>The slider covers the last 2 hours in 10-minute steps, then Now, then the Rain forecast.</li>
                <li>Clouds and Radar hold their newest frame after Now. When a layer is behind the others, frames can repeat, and Now can be 10 to 20 minutes newer than that layer's data.</li>
            </ul>
        </section>

        <section
            class='small text-secondary'
            data-test='attribution'
        >
            Weather data provided by
            <a
                href='https://rainbow.ai'
                target='_blank'
                rel='noopener'
                data-test='attribution-link'
            >Rainbow.ai</a>
        </section>

        <div>
            <button
                type='button'
                class='btn btn-outline-secondary'
                data-test='reset'
                @click='resetSettings'
            >
                Reset to defaults
            </button>
        </div>
    </div>
</template>

<script setup lang='ts'>
import { useId } from 'vue';
import type { LayerSlot, PaletteCode, TimeZoneSetting } from './types.ts';
import { PALETTES } from './constants.ts';
import {
    resetSettings,
    setCoverage,
    setOpacity,
    setPalette,
    setPlayForecast,
    setRadarsPrecipType,
    setTileSize,
    setTimeZone,
    settings,
} from './state.ts';

const id = `taknz-wx-${useId()}`;

const SLOTS: { key: LayerSlot; label: string }[] = [
    { key: 'precip', label: 'Rain Regional' },
    { key: 'precip-global', label: 'Rain Global' },
    { key: 'radars', label: 'Radar' },
    { key: 'clouds', label: 'Clouds' },
];

const ZONES: { value: TimeZoneSetting; label: string }[] = [
    { value: 'Pacific/Auckland', label: 'New Zealand' },
    { value: 'UTC', label: 'UTC' },
    { value: 'local', label: 'This device' },
];

function checked(e: Event): boolean {
    return (e.target as HTMLInputElement).checked;
}

function onOpacity(slot: LayerSlot, e: Event): void {
    setOpacity(slot, Number((e.target as HTMLInputElement).value));
}

function onPalette(slot: 'precip' | 'radars', e: Event): void {
    setPalette(slot, (e.target as HTMLSelectElement).value as PaletteCode);
}
</script>
