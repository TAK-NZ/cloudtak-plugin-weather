import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import type { VueWrapper } from '@vue/test-utils';
import { nextTick, watch } from 'vue';

const routerMock = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('vue-router', () => ({ useRouter: () => routerMock }));

import LayerControls from '../lib/LayerControls.vue';
import TimelineSlider from '../lib/TimelineSlider.vue';
import WeatherBar from '../lib/WeatherBar.vue';
import WeatherSettings from '../lib/WeatherSettings.vue';
import { bindStorage, session, setFrame, settings, toggleLayer, setTimeZone } from '../lib/state.ts';
import { ROUTE_NAME } from '../lib/constants.ts';
import type { HealthState } from '../lib/types.ts';
import { setRain } from './helpers.ts';

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

    it('offers Clouds, Rain Regional, Rain Global and Radar as four independent toggles', async () => {
        wrapper = mount(LayerControls, { attachTo: document.body });
        const chips = wrapper.findAll('[data-test^=toggle-]').map((c) => c.attributes('data-test'));
        expect(chips).toEqual(['toggle-clouds', 'toggle-precip', 'toggle-precip-global', 'toggle-radars']);
        expect(wrapper.findAll('[data-test^=toggle-]').map((c) => c.text())).toEqual(['Clouds', 'Rain Regional', 'Rain Global', 'Radar']);
        expect(wrapper.find('[role=radiogroup]').exists()).toBe(false);
        expect(wrapper.find('input[type=radio]').exists()).toBe(false);

        const pressed = (t: string): string | undefined => wrapper!.get(`[data-test=${t}]`).attributes('aria-pressed');
        await wrapper.get('[data-test=toggle-precip]').trigger('click');
        expect(settings.precipRegional).toBe(true);
        expect(settings.precipGlobal).toBe(false);
        await wrapper.get('[data-test=toggle-precip-global]').trigger('click');
        expect([settings.precipRegional, settings.precipGlobal]).toEqual([true, true]);
        expect([pressed('toggle-precip'), pressed('toggle-precip-global')]).toEqual(['true', 'true']);
        await wrapper.get('[data-test=toggle-precip]').trigger('click');
        expect([settings.precipRegional, settings.precipGlobal]).toEqual([false, true]);
        expect([pressed('toggle-precip'), pressed('toggle-precip-global')]).toEqual(['false', 'true']);
        expect(settings.clouds).toBe(false);
        expect(settings.radars).toBe(false);
    });

    it('shows a quiet now dot on clouds and radar only in the forecast, with Rain on', async () => {
        toggleLayer('clouds', true);
        toggleLayer('radars', true);
        setRain('precip-global');
        wrapper = mount(LayerControls);
        expect(wrapper.find('[data-test=now-clouds]').exists()).toBe(false);
        expect(wrapper.find('[data-test=now-radars]').exists()).toBe(false);

        setFrame(-4);
        await nextTick();
        expect(wrapper.find('[data-test=now-clouds]').exists()).toBe(false);

        setFrame(6);
        await nextTick();
        expect(wrapper.get('[data-test=now-clouds]').attributes('title')).toBe('Shows the latest frame; no forecast');
        expect(wrapper.get('[data-test=now-radars]').text()).toBe('');
        expect(wrapper.get('[data-test=toggle-clouds]').text()).toContain('latest frame only');
        expect(wrapper.find('.badge').exists()).toBe(false);

        toggleLayer('clouds', false);
        await nextTick();
        expect(wrapper.find('[data-test=now-clouds]').exists()).toBe(false);
        expect(wrapper.find('[data-test=now-radars]').exists()).toBe(true);
    });
});

describe('TimelineSlider', () => {
    const slider = () => wrapper!.get('[data-test=slider]');
    const input = async (v: number): Promise<void> => {
        // setValue would also fire "change"; a drag only fires "input".
        const el = wrapper!.get('[data-test=slider]');
        (el.element as HTMLInputElement).value = String(v);
        await el.trigger('input');
    };

    it('is disabled, with an explanation, when no layer is on', () => {
        wrapper = mount(TimelineSlider);
        expect(slider().attributes('disabled')).toBeDefined();
        expect(wrapper.get('[data-test=now]').attributes('disabled')).toBeDefined();
        expect(wrapper.get('[data-test=timeline]').attributes('title')).toBe('Turn on a layer to use the timeline');
    });

    it('is enabled by Clouds alone and then only covers the past', () => {
        toggleLayer('clouds', true);
        wrapper = mount(TimelineSlider);
        expect(slider().attributes('disabled')).toBeUndefined();
        expect(slider().attributes('min')).toBe('-12');
        expect(slider().attributes('max')).toBe('0');
    });

    it('is an index slider from -12 to 24 with Rain on', () => {
        setRain('precip');
        wrapper = mount(TimelineSlider);
        expect(slider().attributes('disabled')).toBeUndefined();
        expect(slider().attributes('min')).toBe('-12');
        expect(slider().attributes('max')).toBe('24');
        expect(slider().attributes('step')).toBe('1');
        expect(slider().attributes('aria-label')).toBe('Weather time');
        expect(wrapper.find('datalist').exists()).toBe(false);
    });

    it('the range follows Rain being switched on and off', async () => {
        toggleLayer('clouds', true);
        wrapper = mount(TimelineSlider);
        expect(slider().attributes('max')).toBe('0');
        setRain('precip-global');
        await nextTick();
        expect(slider().attributes('max')).toBe('24');
        setRain('none');
        await nextTick();
        expect(slider().attributes('max')).toBe('0');
    });

    it('draws a purely visual Now mark at the position of frame 0', async () => {
        setRain('precip');
        wrapper = mount(TimelineSlider);
        const mark = wrapper.get('[data-test=now-mark]');
        expect(mark.attributes('aria-hidden')).toBe('true');
        expect(mark.attributes('style')).toContain('pointer-events: none');
        // 12 of the 36 steps lie before Now
        expect(mark.attributes('style')).toContain('0.3333');
        toggleLayer('clouds', true);
        setRain('none');
        await nextTick();
        expect(wrapper.get('[data-test=now-mark]').attributes('style')).toContain('7px + 1 *');
    });

    it('debounces input by 150 ms and commits once', async () => {
        vi.useFakeTimers();
        setRain('precip');
        const seen: number[] = [];
        const stop = watch(() => session.frame, (v) => seen.push(v), { flush: 'sync' });
        wrapper = mount(TimelineSlider);

        await input(3);
        expect(session.draftFrame).toBe(3);
        expect(session.frame).toBe(0);

        vi.advanceTimersByTime(100);
        await input(-4);
        vi.advanceTimersByTime(149);
        expect(session.frame).toBe(0);
        expect(session.draftFrame).toBe(-4);

        vi.advanceTimersByTime(1);
        expect(session.frame).toBe(-4);
        expect(session.draftFrame).toBeNull();

        vi.advanceTimersByTime(1000);
        expect(seen).toEqual([-4]);
        stop();
    });

    it('commits immediately on change and cancels the pending debounce', async () => {
        vi.useFakeTimers();
        setRain('precip');
        const seen: number[] = [];
        const stop = watch(() => session.frame, (v) => seen.push(v), { flush: 'sync' });
        wrapper = mount(TimelineSlider);

        await input(5);
        (slider().element as HTMLInputElement).value = '7';
        await slider().trigger('change');
        expect(session.frame).toBe(7);

        vi.advanceTimersByTime(1000);
        expect(seen).toEqual([7]);
        stop();
    });

    it('does nothing when the committed frame is unchanged', async () => {
        setRain('precip');
        setFrame(4);
        const seen: number[] = [];
        const stop = watch(() => session.frame, (v) => seen.push(v), { flush: 'sync' });
        wrapper = mount(TimelineSlider);

        (slider().element as HTMLInputElement).value = '4';
        await slider().trigger('change');
        expect(seen).toEqual([]);
        stop();
    });

    it('Now returns to frame 0 at once from the past and the future, and is disabled at 0', async () => {
        setRain('precip');
        setFrame(9);
        wrapper = mount(TimelineSlider);
        const now = wrapper.get('[data-test=now]');
        expect(now.attributes('disabled')).toBeUndefined();

        await now.trigger('click');
        expect(session.frame).toBe(0);
        expect(now.attributes('disabled')).toBeDefined();

        setFrame(-5);
        await nextTick();
        expect(now.attributes('disabled')).toBeUndefined();
        await now.trigger('click');
        expect(session.frame).toBe(0);
    });

    it('shows a compact label and uses it as aria-valuetext', async () => {
        setRain('precip');
        wrapper = mount(TimelineSlider);
        expect(wrapper.get('[data-test=label]').text()).toBe('Now · 00:00');
        expect(slider().attributes('aria-valuetext')).toBe('Now · 00:00');

        setFrame(12);
        await nextTick();
        expect(wrapper.get('[data-test=label]').text()).toBe('+120 min · 02:00');
        expect(slider().attributes('aria-valuetext')).toBe('+120 min · 02:00');

        setFrame(-4);
        await nextTick();
        expect(wrapper.get('[data-test=label]').text()).toBe('-40 min · 23:20');
        expect(slider().attributes('aria-valuetext')).toBe('-40 min · 23:20');
        expect(wrapper.get('[data-test=label]').attributes('title')).toBe('-40 min · Wed 23:20 UTC');
    });

    it('follows the time zone setting', async () => {
        setRain('precip');
        wrapper = mount(TimelineSlider);
        setTimeZone('Pacific/Auckland');
        await nextTick();
        expect(wrapper.get('[data-test=label]').text()).toBe('Now · 13:00');
    });

    it('the label is one truncating line, without the old approximation marker', () => {
        setRain('precip');
        wrapper = mount(TimelineSlider);
        const label = wrapper.get('[data-test=label]');
        expect(label.classes()).toContain('text-truncate');
        expect(label.text()).not.toContain('~');
        expect(wrapper.find('[data-test=note]').exists()).toBe(false);
    });

    it('has no Play button', () => {
        setRain('precip');
        wrapper = mount(TimelineSlider);
        expect(wrapper.findAll('button').some((b) => /play/i.test(b.text() + (b.attributes('aria-label') ?? '')))).toBe(false);
        expect(wrapper.html()).not.toMatch(/play/i);
    });

    const HEALTH: [string, HealthState, string][] = [
        ['ok', { kind: 'ok' }, ''],
        ['limited', { kind: 'limited', until: 1 }, 'Rate limited, retrying'],
        ['session expired', { kind: 'denied', status: 401 }, 'Session expired'],
        ['disabled', { kind: 'denied', status: 403 }, 'Disabled by admin'],
        ['unavailable', { kind: 'degraded', since: 1, status: 404 }, 'Weather unavailable'],
        ['service unavailable', { kind: 'degraded', since: 1, status: 502 }, 'Weather unavailable'],
    ];

    it.each(HEALTH)('the %s state is a status icon with a short title and aria-label', async (_name, state, text) => {
        toggleLayer('clouds', true);
        session.health = state;
        wrapper = mount(TimelineSlider);
        await nextTick();
        const status = wrapper.get('[role=status]');
        expect(status.attributes('data-test')).toBe('health');
        expect(status.text()).toBe('');
        expect(status.attributes('title')).toBe(text || undefined);
        expect(status.attributes('aria-label')).toBe(text || undefined);
        expect(status.find('svg').exists()).toBe(text !== '');
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

    it('has an opacity slider per layer, including Rain Global, and one shared Rain palette', async () => {
        wrapper = mount(WeatherSettings);
        for (const slot of ['clouds', 'precip-global', 'precip', 'radars']) {
            expect(wrapper.find(`[data-test=opacity-${slot}]`).exists()).toBe(true);
        }
        const global = wrapper.get('[data-test=opacity-precip-global]');
        (global.element as HTMLInputElement).value = '0.4';
        await global.trigger('input');
        expect(settings.opacity['precip-global']).toBe(0.4);
        expect(settings.opacity.precip).toBe(0.7);
        expect(wrapper.findAll('[data-test^=palette-]').map((e) => e.attributes('data-test'))).toEqual(['palette-precip', 'palette-radars']);
        expect(wrapper.find('input[type=radio][data-test^=rain]').exists()).toBe(false);
    });

    it('holds the explanations and the Rainbow.ai link that the panel no longer shows', () => {
        wrapper = mount(WeatherSettings);
        const link = wrapper.get('[data-test=attribution-link]');
        expect(link.attributes('href')).toBe('https://rainbow.ai');
        expect(link.attributes('rel')).toBe('noopener');
        expect(link.attributes('target')).toBe('_blank');
        expect(wrapper.get('[data-test=attribution]').text()).toBe('Weather data provided by Rainbow.ai');
        const layers = wrapper.get('[data-test=about-layers]').text();
        expect(layers).toContain('Only Rain has a forecast');
        expect(layers).toContain('Regional');
        const timeline = wrapper.get('[data-test=about-timeline]').text();
        expect(timeline).toContain('last 2 hours');
        expect(timeline).toContain('hold their newest frame');
    });
});

describe('WeatherBar', () => {
    const bar = (): VueWrapper => wrapper!;
    const text = (): string => bar().element.textContent?.replace(/\s+/g, ' ').trim() ?? '';

    it('renders ONE card holding the chips on top and the timeline row below', () => {
        wrapper = mount(WeatherBar);
        expect(bar().findAll('.cloudtak-panel')).toHaveLength(1);
        const card = bar().get('[data-test=card]');
        expect(card.classes()).toContain('cloudtak-panel');
        const layers = card.get('[data-test=layers]');
        const row = card.get('[data-test=row]');
        expect(layers.find('[data-test=layer-controls]').exists()).toBe(true);
        expect(row.find('[data-test=layer-controls]').exists()).toBe(false);
        for (const t of ['now', 'slider', 'label', 'health', 'settings']) expect(row.find(`[data-test=${t}]`).exists()).toBe(true);
        // layers section comes first
        expect(layers.element.compareDocumentPosition(row.element) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        expect(bar().find('[data-test=controls]').exists()).toBe(false);
        expect(bar().find('[data-test=bar-button]').exists()).toBe(false);
        expect(bar().get('[data-test=weather-bar]').attributes('style')).toContain('width: min(640px');
    });

    it('has no note, attribution or always-visible health text', async () => {
        toggleLayer('radars', true);
        session.health = { kind: 'limited', until: 1 };
        wrapper = mount(WeatherBar);
        await nextTick();
        for (const t of ['note', 'attribution']) expect(bar().find(`[data-test=${t}]`).exists()).toBe(false);
        expect(text()).not.toMatch(/Rainbow|current data|Forecast applies|Rate limited|provided by/i);
        expect(bar().get('[data-test=health]').text()).toBe('');
    });

    it('shows only the allowed text', () => {
        setRain('precip');
        toggleLayer('clouds', true);
        toggleLayer('radars', true);
        wrapper = mount(WeatherBar);
        const rest = text().replace(/Clouds|Radar|Rain|Off|Regional|Global|Now|[\d:+\-·]|min/g, '').trim();
        expect(rest).toBe('');
        expect(text()).toContain('Now · 00:00');
    });

    it('either Rain layer gives the forecast range, with no Rain there is no forecast frame', async () => {
        toggleLayer('clouds', true);
        wrapper = mount(WeatherBar);
        const max = (): string | undefined => bar().get('[data-test=slider]').attributes('max');
        expect(max()).toBe('0');
        for (const mode of ['precip', 'precip-global', 'both'] as const) {
            setRain(mode);
            await nextTick();
            expect(max()).toBe('24');
            setRain('none');
            await nextTick();
            expect(max()).toBe('0');
        }
    });

    it('the slider range follows Rain', async () => {
        toggleLayer('clouds', true);
        wrapper = mount(WeatherBar);
        expect(bar().get('[data-test=slider]').attributes('max')).toBe('0');
        setRain('precip');
        await nextTick();
        expect(bar().get('[data-test=slider]').attributes('max')).toBe('24');
        expect(bar().get('[data-test=slider]').attributes('min')).toBe('-12');
    });

    it('the settings gear opens the settings route and leaves the panel open', async () => {
        session.panelOpen = true;
        wrapper = mount(WeatherBar);
        await bar().get('[data-test=settings]').trigger('click');
        expect(routerMock.push).toHaveBeenCalledWith({ name: ROUTE_NAME });
        expect(session.panelOpen).toBe(true);
    });

    it('does not handle Escape itself (the plugin does, at document level)', async () => {
        session.panelOpen = true;
        wrapper = mount(WeatherBar, { attachTo: document.body });
        await bar().get('[data-test=toggle-clouds]').trigger('keydown', { key: 'Escape' });
        expect(session.panelOpen).toBe(true);
    });
});
