<template>
    <div
        class='position-relative'
        style='width: min(640px, calc(100vw - 24px)); height: 50px;'
        data-test='weather-bar'
        @keydown.esc='onEscape'
    >
        <div
            class='d-flex align-items-center gap-2'
            style='height: 50px; width: 100%;'
            data-test='row'
        >
            <ForecastSlider class='flex-grow-1' />
            <button
                type='button'
                class='btn btn-icon p-0 d-inline-flex align-items-center justify-content-center'
                style='width: 44px; height: 44px; flex: 0 0 44px;'
                aria-label='Weather settings'
                title='Weather settings'
                data-test='settings'
                @click='openSettings'
            >
                <IconSettings
                    :size='24'
                    stroke='1.5'
                />
            </button>
        </div>
        <div
            class='position-absolute cloudtak-panel p-2 d-flex flex-column gap-2'
            style='
                left: -9px;
                right: -9px;
                bottom: calc(100% + 9px);
                max-height: min(60vh, calc(100vh - 220px));
                overflow: auto;
            '
            data-test='controls'
        >
            <LayerControls />
            <div
                v-if='anyLayer'
                class='small text-secondary'
                data-test='note'
                v-text='FORECAST_NOTE'
            />
            <div
                role='status'
                class='small'
                data-test='health'
                v-text='message'
            />
            <div
                class='small text-secondary'
                data-test='attribution'
            >
                Weather data provided by Rainbow.ai
            </div>
        </div>
    </div>
</template>

<script setup lang='ts'>
import { computed, nextTick } from 'vue';
import { useRouter } from 'vue-router';
import { IconSettings } from '@tabler/icons-vue';
import LayerControls from './LayerControls.vue';
import ForecastSlider from './ForecastSlider.vue';
import { focusWeatherControl } from './control.ts';
import { FORECAST_NOTE, ROUTE_NAME } from './constants.ts';
import { healthMessage } from './health.ts';
import { session, settings } from './state.ts';

const router = useRouter();

const anyLayer = computed(() => settings.clouds || settings.radars || settings.precip !== 'none');
const message = computed(() => healthMessage(session.health));

function openSettings(): void {
    router.push({ name: ROUTE_NAME });
}

async function onEscape(): Promise<void> {
    session.panelOpen = false;
    await nextTick();
    focusWeatherControl();
}
</script>
