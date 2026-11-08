import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { BrandMark, Icon, ICON_NAMES } from '../src/icons/Icon';

describe('Icon (T36)', () => {
  it('draws every icon, hidden from assistive technology', () => {
    expect(ICON_NAMES.length).toBeGreaterThan(30);
    for (const name of ICON_NAMES) {
      const html = renderToStaticMarkup(<Icon name={name} />);
      expect(html, name).toMatch(/^<svg class="i" viewBox="0 0 24 24"/);
      expect(html, name).toContain('aria-hidden="true"');
      expect(html, name).toContain('focusable="false"');
      // Something to draw, in the current colour.
      expect(html, name).toMatch(/<(path|circle|rect) /);
      expect(html, name).toContain('stroke="currentColor"');
    }
  });

  // T51 (A935): Settings' gear and Feedback's chat bubble in the sidebar's footer.
  it('has a gear and a chat bubble', () => {
    expect(ICON_NAMES).toContain('gear');
    expect(ICON_NAMES).toContain('comment');
    expect(renderToStaticMarkup(<Icon name="gear" />)).toContain('<circle cx="12" cy="12"');
  });

  it('takes a size and a class', () => {
    const html = renderToStaticMarkup(<Icon name="search" size={20} className="lg" />);
    expect(html).toContain('class="i lg"');
    expect(html).toContain('width="20"');
    expect(html).toContain('height="20"');
  });

  it('draws the Moss Pen mark from the logo files, light and dark (A402)', () => {
    const html = renderToStaticMarkup(<BrandMark size={22} />);
    expect(html).toContain(
      '<span class="brand-mark" aria-hidden="true"><img class="brand-mark-light"',
    );
    for (const variant of ['light', 'dark']) {
      expect(html).toMatch(
        new RegExp(
          `<img class="brand-mark-${variant}" src="[^"]*/brand-mark-${variant}\\.svg" alt="" width="22" height="22"/>`,
        ),
      );
    }
  });
});
