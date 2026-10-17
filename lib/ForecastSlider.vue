<template>
    <div
        class='d-flex gap-1'
        :class='compact ? "flex-row align-items-center gap-2" : "flex-column"'
        data-test='forecast'
        :title='disabled ? DISABLED_TITLE : undefined'
    >
        <div
            class='d-flex align-items-center gap-2'
            :class='{ "flex-grow-1": compact }'
            :style='compact ? "min-width: 0;" : undefined'
        >
            <button
                type='button'
                class='btn btn-sm btn-outline-secondary'
                style='min-height: 44px; min-width: 44px;'
                data-test='now'
                :disabled='disabled || shownFrame === 0'
                @click='onNow'
            >
                Now
            </button>
            <input
                type='range'
                class='form-range flex-grow-1 m-0'
                style='min-width: 0; min-height: 44px;'
                aria-label='Forecast time'
                data-test='slider'
                :min='0'
                :max='TIMELINE.futureFrames'
                :step='1'
                :list='listId'
                :value='shownFrame'
                :disabled='disabled'
                :aria-valuetext='valueText'
                @input='onInput'
                @change='onChange'
            >
            <datalist :id='listId'>
                <option
                    v-for='tick in TICKS'
                    :key='tick'
                    :value='tick'
                />
            </datalist>
        </div>
        <div
            class='d-flex column-gap-2 small'
            :class='compact ? "flex-nowrap text-nowrap flex-shrink-0" : "flex-wrap"'
            data-test='label'
            :title='label.tooltip'
        >
            <strong v-text='label.primary' />
            <span
                v-if='label.time'
                v-text='label.time'
            />
            <span
                v-if='label.secondary'
                class='text-secondary'
                v-text='label.secondary'
            />
        </div>
        <div
            v-if='anyLayer && !compact'
            class='small text-secondary'
            data-test='note'
            v-text='FORECAST_NOTE'
        />
    </div>
</template>

<script setup lang='ts'>
import { computed, onBeforeUnmount, onMounted, ref, useId } from 'vue';
import { FORECAST_NOTE } from './constants.ts';
import { session, setDraftFrame, setFrame, settings } from './state.ts';
import { TIMELINE, clampFrame, clock, debounce, frameLabel, frameToMinutes } from './time.ts';

const DISABLED_TITLE = 'Select Regional or Global rain to use the forecast';
const COMMIT_DELAY_MS = 150;
const TICKS = [0, 6, 12, 18, 24];

defineProps({
    /** One-row layout for the wide bottom bar; the note is then shown by the bar. */
    compact: { type: Boolean, default: false },
});

const listId = `taknz-wx-ticks-${useId()}`;

const disabled = computed(() => settings.precip === 'none');
const shownFrame = computed(() => session.draftFrame ?? session.frame);
const anyLayer = computed(() => settings.clouds || settings.radars || settings.precip !== 'none');

// The "data N min old" text depends on the clock, so refresh it now and then.
const nowMs = ref(clock.now());
let timer: ReturnType<typeof setInterval> | undefined;
onMounted(() => {
    timer = setInterval(() => {
        nowMs.value = clock.now();
    }, 30_000);
});

const label = computed(() => frameLabel({
    frame: shownFrame.value,
    snapshot: session.snapshot,
    nowMs: nowMs.value,
    tz: settings.timeZone,
    precip: !disabled.value,
}));

const valueText = computed(() => {
    const l = label.value;
    const text = l.time ? `${l.primary}, ${l.time}` : l.primary;
    const minutes = frameToMinutes(shownFrame.value);
    return minutes > 0 && !disabled.value ? `${text}, plus ${minutes} minutes` : text;
});

const commit = debounce((frame: number) => setFrame(frame), COMMIT_DELAY_MS);

function readFrame(e: Event): number {
    return clampFrame(Number((e.target as HTMLInputElement).value));
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
    if (timer !== undefined) clearInterval(timer);
    setDraftFrame(null);
});
</script>
