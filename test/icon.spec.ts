import { describe, it, expect } from 'vitest';
import { createSSRApp } from 'vue';
import { renderToString } from 'vue/server-renderer';
import { IconWeather } from '../lib/icon.ts';

// Path data of Font Awesome Free 7.3.1 svgs/solid/cloud-sun.svg, fetched with curl
// from https://raw.githubusercontent.com/FortAwesome/Font-Awesome/7.x/svgs/solid/cloud-sun.svg
const SOURCE_PATH = 'M208.3 192c43.1 0 80.5 24.4 99.2 60.1 14.7-17.2 36.4-28.1 60.8-28.1 44.2 0 80 35.8 80 80 0 5.5-.6 10.9-1.6 16 .5 0 1.1 0 1.6 0 53 0 96 43 96 96s-43 96-96 96l-320 0c-53 0-96-43-96-96 0-42.5 27.7-78.5 66-91.2-1.3-6.8-2-13.7-2-20.8 0-61.9 50.1-112 112-112zm192-223.8c5.3 0 10.3 2.7 13.3 7.1l47.3 70.4 83.3-16.3c5.2-1 10.6 .7 14.3 4.4 3.8 3.8 5.4 9.2 4.4 14.4l-16.3 83.3 70.4 47.3c4.4 3 7.1 8 7.1 13.3 0 5.3-2.6 10.3-7 13.2l-70.4 47.3 14.5 74.2c-17.2-21.7-40.4-38.4-67.2-47.3-2.5-12.7-6.9-24.6-12.8-35.7 9.6-14.9 15.2-32.7 15.2-51.7 0-53-43-96-96-96-47.9 0-87.6 35.1-94.8 80.9-20.9-16-45.9-27-73.1-31.1l21.5-14.5-16.3-83.2-.3-2c-.3-4.6 1.3-9.1 4.6-12.4 3.8-3.8 9.2-5.4 14.4-4.4l83.3 16.3 47.3-70.4 1.2-1.6c3-3.5 7.4-5.5 12.1-5.5zm0 175.8c26.5 0 48 21.5 48 48 0 3.8-.5 7.6-1.4 11.1-21.7-16.9-48.9-27.1-78.6-27.1-4.6 0-9.1 .2-13.5 .7 6.4-19 24.3-32.7 45.5-32.7z';

async function render(props: Record<string, unknown> = {}): Promise<string> {
    return renderToString(createSSRApp(IconWeather, props));
}

describe('IconWeather', () => {
    it('uses the Font Awesome path verbatim and the original viewBox', async () => {
        const html = await render();
        expect(html).toContain(`d="${SOURCE_PATH}"`);
        expect(html).toContain('viewBox="0 0 640 512"');
        expect(html).toContain('fill="currentColor"');
        expect(html).toContain('aria-hidden="true"');
        expect(html).toContain('preserveAspectRatio="xMidYMid meet"');
    });

    it('defaults to a 32 px square', async () => {
        const html = await render();
        expect(html).toContain('width="32"');
        expect(html).toContain('height="32"');
    });

    it.each([32, 36])('maps size %i to width and height', async (size) => {
        const html = await render({ size });
        expect(html).toContain(`width="${size}"`);
        expect(html).toContain(`height="${size}"`);
    });

    it('drives the CSS colour from the colour prop', async () => {
        expect(await render({ color: '#ff0000' })).toMatch(/style="color:\s*#ff0000;?"/);
        expect(await render()).toMatch(/style="color:\s*currentColor;?"/);
    });

    it('accepts stroke without putting it on the svg', async () => {
        const html = await render({ stroke: '1' });
        expect(html).not.toContain('stroke');
    });

    it('lets class fall through to the svg', async () => {
        const html = await render({ class: 'menu-icon' });
        expect(html).toMatch(/<svg[^>]*class="menu-icon"/);
    });
});
