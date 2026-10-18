<template>
    <div
        class='position-relative'
        style='width: min(640px, calc(100vw - 24px)); height: 50px;'
        data-test='weather-bar'
    >
        <div
            class='position-absolute cloudtak-panel px-2 d-flex flex-column'
            style='
                left: -9px;
                right: -9px;
                bottom: -1px;
                max-height: min(60vh, calc(100vh - 220px));
                overflow: auto;
            '
            data-test='card'
        >
            <div
                class='pt-2'
                data-test='layers'
            >
                <LayerControls>
                    <button
                        type='button'
                        class='btn btn-icon p-0 d-inline-flex align-items-center justify-content-center ms-auto flex-shrink-0'
                        style='width: 44px; height: 44px; flex: 0 0 44px;'
                        aria-label='Weather Settings'
                        title='Weather Settings'
                        data-test='settings'
                        @click='openSettings'
                    >
                        <IconSettings
                            :size='24'
                            stroke='1.5'
                        />
                    </button>
                </LayerControls>
            </div>
            <div
                class='d-flex align-items-center gap-2 flex-shrink-0'
                style='height: 50px; width: 100%;'
                data-test='row'
            >
                <TimelineSlider class='flex-grow-1' />
            </div>
        </div>
    </div>
</template>

<script setup lang='ts'>
import { useRouter } from 'vue-router';
import { IconSettings } from '@tabler/icons-vue';
import LayerControls from './LayerControls.vue';
import TimelineSlider from './TimelineSlider.vue';
import { ROUTE_NAME } from './constants.ts';

const router = useRouter();

function openSettings(): void {
    router.push({ name: ROUTE_NAME });
}
</script>
