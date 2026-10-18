<template>
    <div
        class='d-flex flex-wrap align-items-center gap-2'
        data-test='layer-controls'
    >
        <button
            type='button'
            class='btn d-inline-flex align-items-center gap-1'
            :class='[settings.clouds ? "btn-primary" : "btn-outline-secondary", { "taknz-wx-no-forecast": dimmed("clouds") }]'
            :aria-pressed='settings.clouds ? "true" : "false"'
            :title='dimmed("clouds") ? NO_FORECAST : undefined'
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
                v-if='dimmed("clouds")'
                class='visually-hidden'
            >, no forecast</span>
        </button>
        <button
            v-for='chip in RAIN_CHIPS'
            :key='chip.key'
            type='button'
            class='btn d-inline-flex align-items-center gap-1'
            :class='settings[chip.key] ? "btn-primary" : "btn-outline-secondary"'
            :aria-pressed='settings[chip.key] ? "true" : "false"'
            :data-test='chip.test'
            style='min-height: 44px; min-width: 44px;'
            @click='toggleLayer(chip.key)'
        >
            <component
                :is='chip.icon'
                :size='20'
                stroke='1.5'
            />
            <span v-text='chip.label' />
        </button>
        <button
            type='button'
            class='btn d-inline-flex align-items-center gap-1'
            :class='[settings.radars ? "btn-primary" : "btn-outline-secondary", { "taknz-wx-no-forecast": dimmed("radars") }]'
            :aria-pressed='settings.radars ? "true" : "false"'
            :title='dimmed("radars") ? NO_FORECAST : undefined'
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
                v-if='dimmed("radars")'
                class='visually-hidden'
            >, no forecast</span>
        </button>
        <slot />
    </div>
</template>

<script setup lang='ts'>
import { computed } from 'vue';
import { IconCloud, IconCloudRain, IconRadar, IconWorld } from '@tabler/icons-vue';
import type { ToggleKey } from './types.ts';
import { rainOn, session, settings, toggleLayer } from './state.ts';

const NO_FORECAST = 'No forecast';

const RAIN_CHIPS: { key: ToggleKey; test: string; label: string; icon: typeof IconCloudRain }[] = [
    { key: 'precipRegional', test: 'toggle-precip', label: 'Rain Regional', icon: IconCloudRain },
    { key: 'precipGlobal', test: 'toggle-precip-global', label: 'Rain Global', icon: IconWorld },
];

// Clouds and Radar have no forecast: they are hidden in forecast frames, so their chip is dimmed.
const noForecast = computed(() => session.frame > 0 && rainOn(settings));
const dimmed = (key: 'clouds' | 'radars'): boolean => noForecast.value && settings[key];
</script>

<style scoped>
.taknz-wx-no-forecast {
    opacity: 0.55;
}
</style>
