import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import type { VueWrapper } from '@vue/test-utils';
import { nextTick, watch } from 'vue';

const routerMock = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('vue-router', () => ({ useRouter: () => routerMock }));

import LayerControls from '../lib/LayerControls.vue';
import ForecastSlider from '../lib/ForecastSlider.vue';
import WeatherBar from '../lib/WeatherBar.vue';
import WeatherSettings from '../lib/WeatherSettings.vue';
import { WeatherControl } from '../lib/control.ts';
import { bindStorage, session, setFrame, setPrecip, settings, toggleLayer, setTimeZone } from '../lib/state.ts';
import { CONTROL_CLASS, ROUTE_NAME } from '../lib/constants.ts';
import type { HealthState } from '../lib/types.ts';
import { EventedFakeMap } from './helpers.ts';

// 2026-01-15T00:00:00Z, a Thursday.
const SNAPSHOT = 1768435200;

let wrapper: VueWrapper | undefined;

function reset(): void {
    bindStorage(null);
    setFrame(0);
    session.panelOpen = false;
    session.snapshot = SNAPSHOT;
    session.health = { kind: 'ok' };
    setTimeZone('UTC');
}

beforeEach(() => {
    reset();
    routerMock.push.mockReset();
});

afterEach(() => {
    wrapper?.unmount();
    wrapper = undefined;
    vi.useRealTimers();
    document.body.innerHTML = '';
});

describe('LayerControls', () => {
    it('toggles clouds and radar with aria-pressed', async () => {
        wrapper = mount(LayerControls);
        const clouds = wrapper.get('[data-test=toggle-clouds]');
        const radars = wrapper.get('[data-test=toggle-radars]');
        expect(clouds.attributes('aria-pressed')).toBe('false');
        expect(radars.attributes('aria-pressed')).toBe('false');

        await clouds.trigger('click');
        expect(settings.clouds).toBe(true);
        expect(clouds.attributes('aria-pressed')).toBe('true');
        expect(radars.attributes('aria-pressed')).toBe('false');

        await clouds.trigger('click');
        expect(clouds.attributes('aria-pressed')).toBe('false');
    });

    it('offers Off, Regional and Global as one exclusive radiogroup', async () => {
        wrapper = mount(LayerControls, { attachTo: document.body });
        expect(wrapper.find('[role=radiogroup]').exists()).toBe(true);

        const radio = (v: string): HTMLInputElement => wrapper!.get(`[data-test="rain-${v}"]`).element as HTMLInputElement;
        const names = new Set(['none', 'precip', 'precip-global'].map((v) => radio(v).name));
        expect(names.size).toBe(1);
        expect(radio('none').checked).toBe(true);

        await wrapper.get('[data-test="rain-precip"]').setValue(true);
        expect(settings.precip).toBe('precip');
        expect([radio('none').checked, radio('precip').checked, radio('precip-global').checked]).toEqual([false, true, false]);

        await wrapper.get('[data-test="rain-precip-global"]').setValue(true);
        expect(settings.precip).toBe('precip-global');
        expect([radio('none').checked, radio('precip').checked, radio('precip-global').checked]).toEqual([false, false, true]);
    });

    it('shows a "current" pill on clouds and radar when a forecast time is selected', async () => {
        toggleLayer('clouds', true);
        toggleLayer('radars', true);
        setPrecip('precip');
        wrapper = mount(LayerControls);
        expect(wrapper.find('[data-test=current-clouds]').exists()).toBe(false);
        expect(wrapper.find('[data-test=current-radars]').exists()).toBe(false);

        setFrame(6);
        await nextTick();
        expect(wrapper.get('[data-test=current-clouds]').text()).toBe('current');
        expect(wrapper.get('[data-test=current-radars]').attributes('title')).toContain('shows current data');

        toggleLayer('clouds', false);
        await nextTick();
        expect(wrapper.find('[data-test=current-clouds]').exists()).toBe(false);
        expect(wrapper.find('[data-test=current-radars]').exists()).toBe(true);
    });
});

describe('ForecastSlider', () => {
    const slider = () => wrapper!.get('[data-test=slider]');
    const input = async (v: number): Promise<void> => {
        // setValue would also fire "change"; a drag only fires "input".
        const el = wrapper!.get('[data-test=slider]');
        (el.element as HTMLInputElement).value = String(v);
        await el.trigger('input');
    };

    it('is disabled, with an explanation, when no rain layer is selected', () => {
        wrapper = mount(ForecastSlider);
        expect(slider().attributes('disabled')).toBeDefined();
        expect(wrapper.get('[data-test=now]').attributes('disabled')).toBeDefined();
        expect(wrapper.get('[data-test=forecast]').attributes('title')).toBe('Select Regional or Global rain to use the forecast');
        expect(wrapper.get('[data-test=label]').text()).toContain('Current data');
    });

    it('is an index slider from 0 to 24 with ticks', () => {
        setPrecip('precip');
        wrapper = mount(ForecastSlider);
        expect(slider().attributes('disabled')).toBeUndefined();
        expect(slider().attributes('min')).toBe('0');
        expect(slider().attributes('max')).toBe('24');
        expect(slider().attributes('step')).toBe('1');
        expect(slider().attributes('aria-label')).toBe('Forecast time');
        expect(wrapper.findAll('datalist option').map((o) => o.attributes('value'))).toEqual(['0', '6', '12', '18', '24']);
    });

    it('debounces input by 150 ms and commits once', async () => {
        vi.useFakeTimers();
        setPrecip('precip');
        const seen: number[] = [];
        const stop = watch(() => session.frame, (v) => seen.push(v), { flush: 'sync' });
        wrapper = mount(ForecastSlider);

        await input(3);
        expect(session.draftFrame).toBe(3);
        expect(session.frame).toBe(0);

        vi.advanceTimersByTime(100);
        await input(4);
        vi.advanceTimersByTime(149);
        expect(session.frame).toBe(0);
        expect(session.draftFrame).toBe(4);

        vi.advanceTimersByTime(1);
        expect(session.frame).toBe(4);
        expect(session.draftFrame).toBeNull();

        vi.advanceTimersByTime(1000);
        expect(seen).toEqual([4]);
        stop();
    });

    it('commits immediately on change and cancels the pending debounce', async () => {
        vi.useFakeTimers();
        setPrecip('precip');
        const seen: number[] = [];
        const stop = watch(() => session.frame, (v) => seen.push(v), { flush: 'sync' });
        wrapper = mount(ForecastSlider);

        await input(5);
        (slider().element as HTMLInputElement).value = '7';
        await slider().trigger('change');
        expect(session.frame).toBe(7);

        vi.advanceTimersByTime(1000);
        expect(seen).toEqual([7]);
        stop();
    });

    it('does nothing when the committed frame is unchanged', async () => {
        setPrecip('precip');
        setFrame(4);
        const seen: number[] = [];
        const stop = watch(() => session.frame, (v) => seen.push(v), { flush: 'sync' });
        wrapper = mount(ForecastSlider);

        (slider().element as HTMLInputElement).value = '4';
        await slider().trigger('change');
        expect(seen).toEqual([]);
        stop();
    });

    it('Now returns to frame 0 at once and is disabled at 0', async () => {
        setPrecip('precip');
        setFrame(9);
        wrapper = mount(ForecastSlider);
        const now = wrapper.get('[data-test=now]');
        expect(now.attributes('disabled')).toBeUndefined();

        await now.trigger('click');
        expect(session.frame).toBe(0);
        expect(now.attributes('disabled')).toBeDefined();
    });

    it('describes the position in aria-valuetext', async () => {
        setPrecip('precip');
        wrapper = mount(ForecastSlider);
        expect(slider().attributes('aria-valuetext')).toBe('Now, ~Thu 00:00 UTC');

        setFrame(12);
        await nextTick();
        expect(slider().attributes('aria-valuetext')).toBe('~Thu 02:00 UTC, plus 120 minutes');
    });

    it('shows the label on two truncating lines and the full text in its title', async () => {
        setPrecip('precip');
        setFrame(12);
        wrapper = mount(ForecastSlider);
        const label = wrapper.get('[data-test=label]');
        expect(label.findAll('.text-truncate')).toHaveLength(2);
        expect(label.attributes('title')).toContain('~Thu 02:00 UTC');
        expect(label.attributes('title')).toContain('+120 min');
        expect(wrapper.find('[data-test=note]').exists()).toBe(false);
    });

    it('has no Play button', () => {
        setPrecip('precip');
        wrapper = mount(ForecastSlider);
        expect(wrapper.findAll('button').some((b) => /play/i.test(b.text() + (b.attributes('aria-label') ?? '')))).toBe(false);
        expect(wrapper.html()).not.toMatch(/play/i);
    });
});

describe('WeatherSettings', () => {
    it('shows Palette 4 selected for Rain and Radar on fresh settings', () => {
        wrapper = mount(WeatherSettings);
        for (const slot of ['precip', 'radars']) {
            const select = wrapper.get(`[data-test=palette-${slot}]`).element as HTMLSelectElement;
            expect(select.value).toBe('4');
            expect(select.selectedOptions[0]?.textContent?.trim()).toBe('Palette 4');
        }
    });
});

describe('WeatherBar', () => {
    let control: WeatherControl | undefined;

    afterEach(() => {
        control?.destroy();
        control = undefined;
    });

    const bar = (): VueWrapper => wrapper!;

    it('renders the row and the controls card, with no bar button', () => {
        wrapper = mount(WeatherBar);
        const row = bar().get('[data-test=row]');
        expect(row.find('[data-test=slider]').exists()).toBe(true);
        expect(row.find('[data-test=now]').exists()).toBe(true);
        expect(row.find('[data-test=label]').exists()).toBe(true);
        expect(row.find('[data-test=settings]').exists()).toBe(true);
        const controls = bar().get('[data-test=controls]');
        expect(controls.find('[data-test=layer-controls]').exists()).toBe(true);
        expect(controls.get('[data-test=attribution]').text()).toBe('Weather data provided by Rainbow.ai');
        expect(row.find('[data-test=layer-controls]').exists()).toBe(false);
        expect(bar().find('[data-test=bar-button]').exists()).toBe(false);
        expect(bar().get('[data-test=weather-bar]').attributes('style')).toContain('width: min(640px');
    });

    it('shows the current-data note in the controls card only while a layer is on', async () => {
        wrapper = mount(WeatherBar);
        expect(bar().find('[data-test=note]').exists()).toBe(false);

        toggleLayer('radars', true);
        await nextTick();
        expect(bar().get('[data-test=controls] [data-test=note]').text())
            .toBe('Clouds and radar always show the current data. Forecast applies to rain only.');

        toggleLayer('radars', false);
        await nextTick();
        expect(bar().find('[data-test=note]').exists()).toBe(false);
    });

    it('Escape closes the panel and returns focus to the weather button', async () => {
        const fake = new EventedFakeMap();
        control = new WeatherControl({ onToggle: () => undefined });
        fake.addControl(control, 'top-left');
        session.panelOpen = true;
        wrapper = mount(WeatherBar, { attachTo: document.body });
        const toggle = bar().get('[data-test=toggle-clouds]');
        (toggle.element as HTMLElement).focus();

        await toggle.trigger('keydown', { key: 'Escape' });
        await nextTick();

        expect(session.panelOpen).toBe(false);
        expect(document.activeElement).toBe(document.querySelector(`.${CONTROL_CLASS} button`));
    });

    it('the settings gear opens the settings route and leaves the panel open', async () => {
        session.panelOpen = true;
        wrapper = mount(WeatherBar);
        await bar().get('[data-test=settings]').trigger('click');
        expect(routerMock.push).toHaveBeenCalledWith({ name: ROUTE_NAME });
        expect(session.panelOpen).toBe(true);
    });

    const HEALTH: [string, HealthState, string][] = [
        ['ok', { kind: 'ok' }, ''],
        ['limited', { kind: 'limited', until: 1 }, 'Rate limited, retrying'],
        ['session expired', { kind: 'denied', status: 401 }, 'Session expired: reload CloudTAK'],
        ['disabled', { kind: 'denied', status: 403 }, 'Weather is disabled by an administrator'],
        ['unavailable', { kind: 'degraded', since: 1, status: 404 }, 'Weather unavailable'],
        ['service unavailable', { kind: 'degraded', since: 1, status: 502 }, 'Weather service unavailable'],
    ];

    it.each(HEALTH)('shows the %s text in the status region of the controls card', async (_name, state, text) => {
        session.health = state;
        wrapper = mount(WeatherBar);
        await nextTick();
        const status = bar().get('[data-test=controls] [role=status]');
        expect(status.attributes('data-test')).toBe('health');
        expect(status.text()).toBe(text);
    });
});
