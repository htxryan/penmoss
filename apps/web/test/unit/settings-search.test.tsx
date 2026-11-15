// @vitest-environment happy-dom
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SETTINGS_SECTIONS, type SettingsSection } from '../../src/router';
import { SettingsSearch, SettingsSearchResults } from '../../src/pages/SettingsSearch';
import { revealSetting, useSettingsSearch } from '../../src/pages/settings-search';
import {
  searchSettings,
  SETTINGS_INDEX,
  SETTINGS_PAGES,
  settingId,
  type SettingEntry,
} from '../../src/pages/settings-index';

// PEN-146: Search Settings finds a setting by its label, its help or another name for it, on the
// pages this build shows, and opens it on its page.

const labels = (query: string, available?: readonly SettingsSection[]) =>
  searchSettings(query, available).map((match) => match.entry.label);

describe('the settings index (PEN-146)', () => {
  it('names each row by its label in kebab case', () => {
    expect(settingId('Note Font Size')).toBe('note-font-size');
    expect(settingId('Today’s Note')).toBe('todays-note');
    expect(settingId('Copy Settings…')).toBe('copy-settings');
    expect(settingId('What’s New')).toBe('whats-new');
    // Each entry's id is its label's, but for a row named apart from another of its label.
    const apart = new Set(['tags-section', 'agent-activity-filters']);
    for (const entry of SETTINGS_INDEX) {
      if (!apart.has(entry.id)) expect(entry.id).toBe(settingId(entry.label));
    }
  });

  it('has one page per section, and every entry is on one of them', () => {
    expect(SETTINGS_PAGES.map((page) => page.id)).toEqual([...SETTINGS_SECTIONS]);
    for (const entry of SETTINGS_INDEX) expect(SETTINGS_SECTIONS).toContain(entry.section);
  });

  it('keeps ids apart within a group of a page', () => {
    const keys = SETTINGS_INDEX.map((entry) => `${entry.section}/${entry.group}/${entry.id}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('searchSettings (PEN-146)', () => {
  it('finds the three fonts for “font”, in the page’s order, each with its place', () => {
    const found = searchSettings('font');
    expect(found.map((match) => match.entry.label)).toEqual([
      'Interface Font',
      'Note Font',
      'Note Font Size',
    ]);
    expect(found.map((match) => match.place)).toEqual([
      'Appearance › Text',
      'Appearance › Text',
      'Appearance › Text',
    ]);
    expect(found[0]!.marks).toEqual([[10, 14]]);
  });

  it('reads other names and help, not only the label', () => {
    expect(labels('typeface')).toEqual(['Interface Font', 'Note Font']);
    expect(labels('text size')).toEqual(['Note Font Size']);
    expect(labels('auto-update')).toEqual(['Update Automatically']);
    expect(labels('keychain')).toContain('GitHub Account');
    // Help: the model never leaves this Mac.
    expect(labels('never leave')).toEqual(['Find Notes by Meaning']);
  });

  it('ranks a label that starts with the query first', () => {
    expect(labels('note')[0]).toBe('Note Font');
    expect(labels('update').slice(0, 2)).toEqual(['Update Automatically', 'Update Channel']);
  });

  it('needs every word, ignores case and spaces, and finds nothing for nothing', () => {
    expect(labels('  NOTE   font size ')).toEqual(['Note Font Size']);
    expect(labels('font zzz')).toEqual([]);
    expect(labels('')).toEqual([]);
    expect(labels('   ')).toEqual([]);
  });

  it('marks each word of the query in the label', () => {
    const [match] = searchSettings('size note');
    expect(match?.entry.label).toBe('Note Font Size');
    expect(match?.marks).toEqual([
      [0, 4],
      [10, 14],
    ]);
  });

  it('searches only the sections this build shows', () => {
    const web: SettingsSection[] = ['appearance', 'sidebar', 'note', 'symbols', 'journal'];
    expect(labels('channel', web)).toEqual([]);
    expect(labels('channel')).toEqual(['Update Channel']);
    expect(labels('font', web)).toHaveLength(3);
  });
});

describe('the Search Settings field (PEN-146)', () => {
  let root: Root | null = null;
  let host: HTMLDivElement;
  let opened: SettingEntry[];

  function Harness() {
    const search = useSettingsSearch([...SETTINGS_SECTIONS]);
    const [, rerender] = useState(0);
    const open = (entry: SettingEntry) => {
      opened.push(entry);
      search.clear();
      rerender((n) => n + 1);
    };
    return (
      <>
        <SettingsSearch search={search} onOpen={open} />
        <div data-testid="content">
          {search.query ? <SettingsSearchResults search={search} onOpen={open} /> : 'the page'}
        </div>
      </>
    );
  }

  const field = () => host.querySelector<HTMLInputElement>('[data-testid="settings-search"]')!;
  const content = () => host.querySelector('[data-testid="content"]')!;
  const type = (value: string) =>
    act(() => {
      const input = field();
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  const press = (key: string, target: Element = field()) =>
    act(() => {
      target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
    });

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    opened = [];
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    act(() => root!.render(<Harness />));
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    host.remove();
  });

  it('shows the results in place of the page while it has a query', () => {
    expect(field().getAttribute('aria-label')).toBe('Search Settings');
    expect(content().textContent).toBe('the page');
    type('font');
    // One header for every page (A1560): Search Results, and the count read out as it changes.
    expect(content().querySelector('h1')?.textContent).toBe('Search Results');
    const count = content().querySelector('[data-testid="settings-intro"]')!;
    expect(count.textContent).toBe('3 settings match “font”.');
    expect(count.getAttribute('aria-live')).toBe('polite');
    const results = [...content().querySelectorAll('[data-testid="settings-search-result"]')];
    expect(results.map((link) => link.getAttribute('href'))).toEqual([
      '/settings/appearance',
      '/settings/appearance',
      '/settings/appearance',
    ]);
    expect(results[0]!.querySelector('mark')?.textContent).toBe('Font');
    expect(results[0]!.textContent).toContain('Appearance › Text');
    type('zzz');
    expect(content().querySelector('[data-testid="settings-intro"]')?.textContent).toBe(
      'No settings match “zzz”.',
    );
  });

  it('opens the first result with Enter', () => {
    type('channel');
    press('Enter');
    expect(opened.map((entry) => entry.id)).toEqual(['update-channel']);
    expect(field().value).toBe('');
    expect(content().textContent).toBe('the page');
  });

  it('clears with Escape', () => {
    type('font');
    press('Escape');
    expect(field().value).toBe('');
    expect(content().textContent).toBe('the page');
    expect(opened).toEqual([]);
  });

  it('moves into the results with ↓ and back with ↑', () => {
    type('font');
    press('ArrowDown');
    const links = [...content().querySelectorAll<HTMLElement>('a')];
    expect(document.activeElement).toBe(links[0]);
    press('ArrowDown', links[0]);
    expect(document.activeElement).toBe(links[1]);
    press('ArrowUp', links[1]);
    press('ArrowUp', links[0]);
    expect(document.activeElement).toBe(field());
  });
});

describe('revealSetting (PEN-146)', () => {
  it('marks the row a result opened and puts focus on its control', () => {
    const root = document.createElement('div');
    root.innerHTML =
      '<div data-setting="note-font"><label>Note Font</label><select><option>A</option></select></div>';
    document.body.append(root);
    let done = false;
    const stop = revealSetting(root, 'note-font', () => {
      done = true;
    });
    const row = root.querySelector('[data-setting="note-font"]')!;
    expect(row.hasAttribute('data-found')).toBe(true);
    expect(document.activeElement).toBe(root.querySelector('select'));
    stop();
    expect(row.hasAttribute('data-found')).toBe(false);
    expect(done).toBe(false);
    root.remove();
  });
});
