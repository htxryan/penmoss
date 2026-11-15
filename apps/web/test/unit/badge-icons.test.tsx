// @vitest-environment happy-dom
/**
 * A badge's icon from Lucide (A1568): stored as `lucide:<name>`, the 24 icons from before still
 * read and drawn with their Lucide twins, and a name this build has no icon for shown as the
 * badge's letter.
 */
import { lucideIconNames } from '@lucide/icons/dynamic';
import nodes from 'lucide-static/icon-nodes.json';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadLucideIcon, lucideName } from '../../src/shell/lucide';
import {
  APP_ICON_IN_LUCIDE,
  BADGE_GLYPH_SETTING,
  BADGE_ICONS,
  FIRST_BADGE_ICON,
  badgeIconInLucide,
  badgeOf,
  parseBadgeGlyph,
  type NotebookBadgeValue,
} from '../../src/sources/badge';
import { BadgeView } from '../../src/sources/NotebookBadge';

const PERSONAL = '01JD0000000000000000000001';
const CATALOGUE = new Set(Object.keys(nodes));

describe('Lucide names', () => {
  it('are `lucide:` and a kebab-case name', () => {
    expect(lucideName('lucide:notebook-pen')).toBe('notebook-pen');
    expect(lucideName('lucide:a-arrow-down')).toBe('a-arrow-down');
    for (const bad of ['notebook-pen', 'lucide:', 'lucide:Star', 'lucide:../x', 'lucide:a--b']) {
      expect(lucideName(bad)).toBeNull();
    }
    expect(lucideName(`lucide:${'a'.repeat(65)}`)).toBeNull();
  });

  it('are read as an icon badge, a known one or not; anything else still is not', () => {
    expect(parseBadgeGlyph({ kind: 'icon', value: 'lucide:rocket' })).toEqual({
      kind: 'icon',
      value: 'lucide:rocket',
    });
    // Parsed, so it syncs untouched; drawn as the letter until a build knows it (below).
    expect(parseBadgeGlyph({ kind: 'icon', value: 'lucide:from-a-later-lucide' })).not.toBeNull();
    for (const value of ['rocket', 'lucide:Rocket', 'lucide:', 'lucide: star']) {
      expect(parseBadgeGlyph({ kind: 'icon', value })).toBeNull();
    }
    const badge = badgeOf(PERSONAL, 'Personal', {
      [BADGE_GLYPH_SETTING]: { kind: 'icon', value: 'lucide:rocket' },
    });
    expect(badge.glyph).toEqual({ kind: 'icon', value: 'lucide:rocket' });
    expect(badge.custom).toBe(true);
  });

  it('start a new Icon badge with Lucide’s notebook', () => {
    expect(FIRST_BADGE_ICON).toBe('lucide:notebook');
    expect(CATALOGUE.has('notebook')).toBe(true);
  });
});

describe('the badge icons from before Lucide', () => {
  it('still read, as they were stored', () => {
    for (const icon of BADGE_ICONS) {
      expect(parseBadgeGlyph({ kind: 'icon', value: icon })).toEqual({ kind: 'icon', value: icon });
    }
  });

  it('each have a Lucide twin that exists, all different', () => {
    expect(Object.keys(APP_ICON_IN_LUCIDE).sort()).toEqual([...BADGE_ICONS].sort());
    const twins = Object.values(APP_ICON_IN_LUCIDE);
    expect(new Set(twins).size).toBe(twins.length);
    for (const twin of twins) {
      expect(CATALOGUE.has(twin), twin).toBe(true);
      expect(lucideIconNames as readonly string[]).toContain(twin);
    }
    expect(badgeIconInLucide('branch')).toBe('git-branch');
    expect(badgeIconInLucide('journal')).toBe('book-text');
    expect(badgeIconInLucide('lucide:rocket')).toBe('rocket');
    expect(badgeIconInLucide('rocket')).toBeNull();
  });
});

describe('BadgeView', () => {
  let host: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });
  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  const badge = (value: string): NotebookBadgeValue =>
    badgeOf(PERSONAL, 'Personal', { [BADGE_GLYPH_SETTING]: { kind: 'icon', value } });
  const render = async (value: string) => {
    await act(async () => {
      root.render(<BadgeView badge={badge(value)} name="Personal" size={18} />);
      // The icon's chunk, then the redraw.
      const name = badgeIconInLucide(value);
      if (name) await loadLucideIcon(name);
    });
    // The redraw the loaded icon asks for.
    await act(() => Promise.resolve());
    return host.querySelector<HTMLElement>('[data-testid="notebook-badge"]')!;
  };

  it('draws a Lucide icon from its own chunk, in the badge’s ink', async () => {
    const drawn = await render('lucide:rocket');
    const svg = drawn.querySelector('svg')!;
    expect(svg.getAttribute('data-lucide')).toBe('rocket');
    expect(svg.querySelectorAll('path').length).toBeGreaterThan(0);
    expect(svg.style.color).toBe('var(--nb-badge-ink)');
    expect(drawn.dataset['kind']).toBe('icon');
  });

  it('draws an icon from before Lucide with its Lucide twin, keeping the stored value', async () => {
    for (const [old, twin] of [
      ['star', 'star'],
      ['branch', 'git-branch'],
      ['pulse', 'activity'],
    ] as const) {
      const drawn = await render(old);
      const svg = drawn.querySelector('svg')!;
      expect(svg.getAttribute('data-lucide')).toBe(twin);
      expect(svg.hasAttribute('data-icon')).toBe(false);
      expect(svg.style.color).toBe('var(--nb-badge-ink)');
      expect(drawn.dataset['kind']).toBe('icon');
      expect(drawn.dataset['glyph']).toBe(`icon:${old}`);
    }
  });

  it('shows the letter for a Lucide name this build has no icon for', async () => {
    const drawn = await render('lucide:from-a-later-lucide');
    expect(drawn.querySelector('svg')).toBeNull();
    expect(drawn.querySelector('.nb-badge-text')!.getAttribute('data-text')).toBe('P');
    expect(drawn.dataset['kind']).toBe('letter');
    // What is stored is kept: the badge still says which icon it is.
    expect(drawn.dataset['glyph']).toBe('icon:lucide:from-a-later-lucide');
  });
});
