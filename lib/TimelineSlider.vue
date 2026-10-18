<template>
    <div
        class='d-flex align-items-center gap-2'
        style='width: 100%; min-width: 0;'
        data-test='timeline'
        :title='disabled ? DISABLED_TITLE : undefined'
    >
        <button
            type='button'
            class='btn btn-sm btn-outline-secondary flex-shrink-0'
            style='min-height: 44px; min-width: 44px;'
            data-test='now'
            :disabled='disabled || shownFrame === 0'
            @click='onNow'
        >
            Now
        </button>
        <div
            class='position-relative'
            style='flex: 1 1 0; min-width: 96px;'
        >
            <input
                type='range'
                class='form-range m-0 w-100'
                style='min-height: 44px;'
                aria-label='Weather time'
                data-test='slider'
                :min='FRAME_MIN'
                :max='bounds.max'
                :step='1'
                :value='shownFrame'
                :disabled='disabled'
                :aria-valuetext='label.text'
                @input='onInput'
                @change='onChange'
            >
            <span
                aria-hidden='true'
                data-test='now-mark'
                class='position-absolute rounded-pill bg-secondary'
                :style='markStyle'
            />
        </div>
        <!-- Fixed width, so the slider never resizes while the label changes under the thumb. -->
        <div
            class='d-flex align-items-center flex-shrink-0'
            style='flex: 0 0 7.5rem; width: 7.5rem;'
        >
            <span
                class='text-nowrap text-truncate'
                style='font-size: 0.8125rem; font-variant-numeric: tabular-nums; min-width: 0; flex: 0 1 auto;'
                data-test='label'
                :title='label.title'
                v-text='label.text'
            />
            <span
                role='status'
                class='d-inline-flex align-items-center flex-shrink-0'
                data-test='health'
                :title='healthText || undefined'
                :aria-label='healthText || undefined'
            >
                <IconAlertTriangle
                    v-if='healthText'
                    class='ms-1 text-warning'
                    :size='16'
                    stroke='1.5'
                />
            </span>
        </div>
    </div>
</template>

<script setup lang='ts'>
import { computed, onBeforeUnmount } from 'vue';
import type { CSSProperties } from 'vue';
import { IconAlertTriangle } from '@tabler/icons-vue';
import { healthShort } from './health.ts';
import { rainOn, session, setDraftFrame, setFrame, settings } from './state.ts';
import { FRAME_MIN, clampFrame, debounce, frameBounds, frameLabel } from './time.ts';

const DISABLED_TITLE = 'Turn on a layer to use the timeline';
const COMMIT_DELAY_MS = 150;
const THUMB_INSET_PX = 8;

const disabled = computed(() => !settings.clouds && !settings.radars && !rainOn(settings));
const bounds = computed(() => frameBounds(rainOn(settings)));
const shownFrame = computed(() => clampFrame(session.draftFrame ?? session.frame, bounds.value.max));

const label = computed(() => frameLabel({
    frame: shownFrame.value,
    anchor: session.snapshot,
    tz: settings.timeZone,
}));

const healthText = computed(() => healthShort(session.health));

// A purely visual mark where the slider is at Now. It never takes pointer events.
const markStyle = computed((): CSSProperties => {
    const { min, max } = bounds.value;
    const share = (0 - min) / (max - min);
    return {
        left: `calc(${THUMB_INSET_PX}px + (100% - ${2 * THUMB_INSET_PX}px) * ${share} - 1px)`,
        top: 'calc(50% - 7px)',
        width: '2px',
        height: '14px',
        opacity: 0.55,
        pointerEvents: 'none',
    };
});

const commit = debounce((frame: number) => setFrame(frame), COMMIT_DELAY_MS);

function readFrame(e: Event): number {
    return clampFrame(Number((e.target as HTMLInputElement).value), bounds.value.max);
}

function onInput(e: Event): void {
    const frame = readFrame(e);
    setDraftFrame(frame);
    commit(frame);
}

function onChange(e: Event): void {
    commit.cancel();
    setFrame(readFrame(e));
}

function onNow(): void {
    commit.cancel();
    setFrame(0);
}

onBeforeUnmount(() => {
    commit.flush();
    setDraftFrame(null);
});
</script>
