<template>
    <div
        class='position-relative'
        data-test='weather-bar'
        :style='{ width: barWidth }'
        @keydown.esc='onEscape'
    >
        <div
            class='d-flex align-items-center gap-2'
            style='height: 50px; width: 100%;'
        >
            <button
                ref='button'
                type='button'
                class='btn btn-icon position-relative p-0 d-inline-flex align-items-center justify-content-center'
                style='width: 44px; height: 44px; flex: 0 0 44px;'
                aria-label='Weather'
                data-test='bar-button'
                :aria-expanded='open ? "true" : "false"'
                :title='buttonTitle'
                @click='toggle'
            >
                <IconWeather :size='28' />
                <span
                    v-if='activeCount > 0'
                    class='badge bg-primary text-white position-absolute'
                    style='top: -2px; right: -2px; min-width: 18px;'
                    data-test='badge'
                    v-text='activeCount'
                />
            </button>

            <template v-if='open && wide'>
                <LayerControls />
                <div style='flex: 1 1 0; min-width: 0;'>
                    <ForecastSlider compact />
                </div>
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
            </template>

            <template v-else-if='open'>
                <span
                    class='badge bg-secondary-lt text-truncate'
                    style='min-width: 0; max-width: 100px;'
                    data-test='chip'
                    :title='label.tooltip'
                    v-text='label.primary'
                />
                <button
                    type='button'
                    class='btn btn-icon p-0 d-inline-flex align-items-center justify-content-center ms-auto'
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
            </template>
        </div>

        <div
            v-if='open && wide'
            class='position-absolute small text-center'
            style='left: 0; right: 0; bottom: calc(100% + 4px); pointer-events: none;'
            data-test='caption'
        >
            <span
                v-if='anyLayer'
                class='text-secondary me-2'
                data-test='note'
                v-text='FORECAST_NOTE'
            />
            <span
                role='status'
                class='me-2'
                data-test='health'
                v-text='message'
            />
            <span
                class='text-secondary'
                data-test='attribution'
            >Weather data provided by Rainbow.ai</span>
        </div>

        <div
            v-else-if='open'
            class='position-absolute cloudtak-panel p-2 d-flex flex-column gap-2'
            style='
                bottom: calc(100% + 8px);
                left: 50%;
                transform: translateX(-50%);
                width: min(380px, calc(100vw - 16px));
                max-height: 60vh;
                overflow: auto;
            '
            data-test='popover'
        >
            <LayerControls />
            <ForecastSlider />
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

        <div
            v-else
            role='status'
            class='visually-hidden'
            data-test='health'
            v-text='message'
        />
    </div>
</template>

<script setup lang='ts'>
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue';
import { useRouter } from 'vue-router';
import { IconSettings } from '@tabler/icons-vue';
import LayerControls from './LayerControls.vue';
import ForecastSlider from './ForecastSlider.vue';
import { IconWeather } from './icon.ts';
import { FORECAST_NOTE, ROUTE_NAME } from './constants.ts';
import { healthMessage } from './health.ts';
import { session, settings } from './state.ts';
import { clock, frameLabel } from './time.ts';

const WIDE_QUERY = '(min-width: 960px)';

const router = useRouter();
const button = ref<HTMLButtonElement | null>(null);

const open = computed(() => session.panelOpen);
const wide = ref(true);

let media: MediaQueryList | undefined;
function onMedia(e: MediaQueryListEvent): void {
    wide.value = e.matches;
}

onMounted(() => {
    if (typeof window.matchMedia !== 'function') return;
    media = window.matchMedia(WIDE_QUERY);
    wide.value = media.matches;
    media.addEventListener('change', onMedia);
});

onBeforeUnmount(() => {
    media?.removeEventListener('change', onMedia);
    media = undefined;
});

const activeCount = computed(() =>
    [settings.clouds, settings.radars, settings.precip !== 'none'].filter(Boolean).length
);

const anyLayer = computed(() => activeCount.value > 0);

const message = computed(() => healthMessage(session.health));

const buttonTitle = computed(() => message.value ? `Weather: ${message.value}` : 'Weather');

const barWidth = computed(() => {
    if (!open.value) return '44px';
    return wide.value ? 'min(880px, calc(100vw - 24px))' : 'min(200px, calc(100vw - 24px))';
});

const label = computed(() => frameLabel({
    frame: session.draftFrame ?? session.frame,
    snapshot: session.snapshot,
    nowMs: clock.now(),
    tz: settings.timeZone,
    precip: settings.precip !== 'none',
}));

function toggle(): void {
    session.panelOpen = !session.panelOpen;
}

function openSettings(): void {
    if (!wide.value) session.panelOpen = false;
    router.push({ name: ROUTE_NAME });
}

async function onEscape(): Promise<void> {
    if (!open.value || wide.value) return;
    session.panelOpen = false;
    await nextTick();
    button.value?.focus();
}
</script>
