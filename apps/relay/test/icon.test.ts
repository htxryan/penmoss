/** The relay's icon is the Penmoss logo, the site's favicon (PEN-195's trial). */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ICON_PNG_BASE64, ICON_PNG_SIZE, ICON_SVG } from '../src/icon.gen';
import { iconResponse, SERVER_ICONS } from '../src/icon';

describe("the relay's icon", () => {
  it('is the site’s favicon: run node apps/relay/scripts/icon.mjs when this fails', () => {
    const site = readFileSync(join(__dirname, '../../../site/public/favicon.svg'), 'utf8');
    expect(ICON_SVG).toBe(site.trim());
  });

  it('has a PNG of its size', () => {
    const png = Buffer.from(ICON_PNG_BASE64, 'base64');
    expect(png.subarray(1, 4).toString()).toBe('PNG');
    expect(png.readUInt32BE(16)).toBe(ICON_PNG_SIZE);
    expect(png.readUInt32BE(20)).toBe(ICON_PNG_SIZE);
  });

  it('is served where browsers and crawlers look, and named to MCP clients', async () => {
    const svg = iconResponse('/favicon.svg')!;
    expect(svg.headers.get('content-type')).toBe('image/svg+xml');
    expect(await svg.text()).toBe(ICON_SVG);
    for (const path of ['/favicon.ico', '/favicon.png', '/apple-touch-icon.png']) {
      const png = iconResponse(path)!;
      expect(png.headers.get('content-type')).toBe('image/png');
      expect(Buffer.from(await png.arrayBuffer()).toString('base64')).toBe(ICON_PNG_BASE64);
    }
    expect(iconResponse('/notebooks')).toBeNull();
    expect(SERVER_ICONS.map((icon) => icon.mimeType)).toEqual(['image/svg+xml', 'image/png']);
    expect(atob(SERVER_ICONS[0].src.split(',')[1]!)).toBe(ICON_SVG);
  });
});
