<template>
    <div
        class='d-flex align-items-center gap-2'
        style='width: 100%; min-width: 0;'
        data-test='forecast'
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
        <input
            type='range'
            class='form-range m-0'
            style='flex: 1 1 0; min-width: 96px; min-height: 44px;'
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
        <div
            class='small'
            style='flex: 0 1 8.75rem; min-width: 0; line-height: 1.15;'
            data-test='label'
            :title='labelTitle'
        >
            <div class='text-truncate'>
                <strong v-text='label.primary' />
                <span
                    v-if='label.time'
                    class='ms-1'
                    v-text='label.time'
                />
            </div>
            <div
                v-if='label.secondary'
                class='text-truncate text-secondary'
                v-text='label.secondary'
            />
        </div>
    </div>
</template>

<script setup lang='ts'>
import { computed, onBeforeUnmount, onMounted, ref, useId } from 'vue';
import { session, setDraftFrame, setFrame, settings } from './state.ts';
import { TIMELINE, clampFrame, clock, debounce, frameLabel, frameToMinutes } from './time.ts';

const DISABLED_TITLE = 'Select Regional or Global rain to use the forecast';
const COMMIT_DELAY_MS = 150;
const TICKS = [0, 6, 12, 18, 24];

const listId = `taknz-wx-ticks-${useId()}`;

const disabled = computed(() => settings.precip === 'none');
const shownFrame = computed(() => session.draftFrame ?? session.frame);

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

// The label is truncated in a narrow row, so the title carries the full text.
const labelTitle = computed(() => {
    const l = label.value;
    const text = [l.primary, l.time, l.secondary].filter(Boolean).join(' ');
    return l.tooltip ? `${text}\n${l.tooltip}` : text;
});

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
