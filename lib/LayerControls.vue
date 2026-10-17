<template>
    <div
        class='d-flex flex-wrap align-items-center gap-2'
        data-test='layer-controls'
    >
        <button
            type='button'
            class='btn d-inline-flex align-items-center gap-1'
            :class='settings.clouds ? "btn-primary" : "btn-outline-secondary"'
            :aria-pressed='settings.clouds ? "true" : "false"'
            data-test='toggle-clouds'
            style='min-height: 44px; min-width: 44px;'
            @click='toggleLayer("clouds")'
        >
            <IconCloud
                :size='20'
                stroke='1.5'
            />
            <span>Clouds</span>
            <span
                v-if='showCurrent && settings.clouds'
                class='badge bg-secondary-lt'
                data-test='current-clouds'
                :title='CURRENT_TITLE'
            >current</span>
        </button>
        <button
            type='button'
            class='btn d-inline-flex align-items-center gap-1'
            :class='settings.radars ? "btn-primary" : "btn-outline-secondary"'
            :aria-pressed='settings.radars ? "true" : "false"'
            data-test='toggle-radars'
            style='min-height: 44px; min-width: 44px;'
            @click='toggleLayer("radars")'
        >
            <IconRadar
                :size='20'
                stroke='1.5'
            />
            <span>Radar</span>
            <span
                v-if='showCurrent && settings.radars'
                class='badge bg-secondary-lt'
                data-test='current-radars'
                :title='CURRENT_TITLE'
            >current</span>
        </button>
        <fieldset
            role='radiogroup'
            aria-label='Rain'
            class='d-inline-flex align-items-center gap-1 border-0 p-0 m-0'
            data-test='rain-group'
        >
            <legend class='visually-hidden'>
                Rain
            </legend>
            <span class='me-1'>
                <IconCloudRain
                    :size='20'
                    stroke='1.5'
                />
                Rain
            </span>
            <label
                v-for='opt in RAIN_OPTIONS'
                :key='opt.value'
                class='btn d-inline-flex align-items-center mb-0'
                :class='settings.precip === opt.value ? "btn-primary" : "btn-outline-secondary"'
                style='min-height: 44px; min-width: 44px;'
            >
                <input
                    type='radio'
                    class='visually-hidden'
                    :name='groupName'
                    :value='opt.value'
                    :checked='settings.precip === opt.value'
                    :data-test='`rain-${opt.value}`'
                    @change='setPrecip(opt.value)'
                >
                {{ opt.label }}
            </label>
        </fieldset>
    </div>
</template>

<script setup lang='ts'>
import { computed, useId } from 'vue';
import { IconCloud, IconCloudRain, IconRadar } from '@tabler/icons-vue';
import type { PrecipMode } from './types.ts';
import { session, setPrecip, settings, toggleLayer } from './state.ts';

const CURRENT_TITLE = 'Forecast time applies to rain only. This layer shows current data.';

const RAIN_OPTIONS: { value: PrecipMode; label: string }[] = [
    { value: 'none', label: 'Off' },
    { value: 'precip', label: 'Regional' },
    { value: 'precip-global', label: 'Global' },
];

const groupName = `taknz-wx-rain-${useId()}`;

// Clouds and radar always show the current data; flag that once a forecast is selected.
const showCurrent = computed(() => session.frame > 0 && settings.precip !== 'none');
</script>
