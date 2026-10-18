<template>
    <div
        class='d-flex flex-column gap-1'
        style='padding-left: 5.5rem;'
        data-test='palette-legend'
    >
        <div
            v-for='strip in strips'
            :key='strip.kind'
            class='d-flex align-items-center gap-2'
        >
            <span
                class='text-secondary small'
                style='width: 2.5rem; flex: 0 0 auto;'
                v-text='strip.label'
            />
            <div
                class='flex-grow-1'
                aria-hidden='true'
                :data-test='`legend-${strip.kind}`'
                :style='{
                    height: "0.75rem",
                    minWidth: 0,
                    border: "1px solid var(--tblr-border-color)",
                    borderRadius: "2px",
                    backgroundImage: gradientCss(strip.stops),
                }'
            />
        </div>
        <div
            class='d-flex justify-content-between text-secondary small'
            style='padding-left: 3rem;'
        >
            <span>Light</span>
            <span>Heavy</span>
        </div>
    </div>
</template>
<script setup lang='ts'>
import { computed } from 'vue';
import type { PaletteCode } from './types.ts';
import { RAIN_STOPS, SNOW_STOPS, gradientCss } from './palette-stops.ts';
const props = defineProps<{ palette: PaletteCode; snow: boolean }>();
const strips = computed(() => {
    const list = [{ kind: 'rain', label: 'Rain', stops: RAIN_STOPS[props.palette] }];
    if (props.snow) list.push({ kind: 'snow', label: 'Snow', stops: SNOW_STOPS[props.palette] });
    return list;
});
</script>
