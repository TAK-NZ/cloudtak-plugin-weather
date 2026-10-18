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
                v-if='showNow && settings.clouds'
                class='d-inline-block rounded-circle bg-secondary'
                style='width: 6px; height: 6px; opacity: 0.8;'
                data-test='now-clouds'
                :title='NOW_TITLE'
            />
            <span
                v-if='showNow && settings.clouds'
                class='visually-hidden'
            >, latest frame only</span>
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
                v-if='showNow && settings.radars'
                class='d-inline-block rounded-circle bg-secondary'
                style='width: 6px; height: 6px; opacity: 0.8;'
                data-test='now-radars'
                :title='NOW_TITLE'
            />
            <span
                v-if='showNow && settings.radars'
                class='visually-hidden'
            >, latest frame only</span>
        </button>
    </div>
</template>

<script setup lang='ts'>
import { computed } from 'vue';
import { IconCloud, IconCloudRain, IconRadar, IconWorld } from '@tabler/icons-vue';
import type { ToggleKey } from './types.ts';
import { rainOn, session, settings, toggleLayer } from './state.ts';

const NOW_TITLE = 'Shows the latest frame; no forecast';

const RAIN_CHIPS: { key: ToggleKey; test: string; label: string; icon: typeof IconCloudRain }[] = [
    { key: 'precipRegional', test: 'toggle-precip', label: 'Rain Regional', icon: IconCloudRain },
    { key: 'precipGlobal', test: 'toggle-precip-global', label: 'Rain Global', icon: IconWorld },
];

// Clouds and radar hold their newest frame in the forecast; mark that quietly.
const showNow = computed(() => session.frame > 0 && rainOn(settings));
</script>
