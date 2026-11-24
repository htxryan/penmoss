// @vitest-environment happy-dom
// The replay's frame (PEN-178): a Frame drawn in the app's own markup, checked for what each state
// shows, including those the mockups don't draw: stacked dialogs, Search with and without a query,
// the titled dialog, Confirmation with its field, Android's This Phone and Settings pages outside
// the index.
import { SETTINGS_INDEX, SETTINGS_PAGES } from '@penmoss/web/src/pages/settings-index';
import { SHORTCUTS } from '@penmoss/web/src/shell/sidebar-shortcuts';
import { BUILT_IN_THEMES } from '@penmoss/ui/theme';
import { beforeAll, describe, expect, it } from 'vitest';
import { frameData, type FrameData } from '../../src/client/replay/frame-data';
import { drawFrame, frameMarkup } from '../../src/client/replay/frame-draw';
import { createReplay, type Frame } from '../../src/client/replay/state';
import { FIXTURE_SESSIONS, timelineEvents } from '../fixtures/sessions';

let data: FrameData;
beforeAll(() => {
  data = frameData();
  document.body.innerHTML = '<div id="root"></div>';
});

const mac = createReplay(timelineEvents(FIXTURE_SESSIONS.mac));
const android = createReplay(timelineEvents(FIXTURE_SESSIONS.android));
const older = createReplay(timelineEvents(FIXTURE_SESSIONS.older));

function draw(frame: Frame, variant: 'light' | 'dark' = 'light') {
  drawFrame(document, { type: 'frame', frame, variant }, data);
  return document.getElementById('root')!;
}
const iconsIn = (root: Element, selector: string) =>
  [...root.querySelectorAll(`${selector} svg[data-icon]`)].map((svg) =>
    svg.getAttribute('data-icon'),
  );

describe('the note view', () => {
  it('draws the window: the sidebar at its width, the tab strip, the note bar and the rail', () => {
    const root = draw(mac.frameAt(5000));
    const app = root.querySelector<HTMLElement>('.notes-app')!;
    expect(app.style.getPropertyValue('--pm-sidebar-width')).toBe('17.5rem');
    expect(app.hasAttribute('data-sidebar')).toBe(false);
    expect(iconsIn(root, '.sb-shortcuts')).toEqual(['plus', ...SHORTCUTS.map((s) => s.icon)]);
    // 2–4 tabs draws 2, the open note's current.
    expect(root.querySelectorAll('.tab-strip .tab')).toHaveLength(2);
    expect(root.querySelector('.tab[aria-selected="true"] .tab-title')?.textContent).toHaveLength(
      24,
    );
    expect(iconsIn(root, '.tab-strip-end .note-actions')).toEqual([
      'widthFull',
      'agentRef',
      'more',
    ]);
    expect(root.querySelector('.note-columns')?.getAttribute('data-panel')).toBe('open');
    expect(root.querySelector('.note-side')).not.toBeNull();
    expect(iconsIn(root, '.note-rail')).toEqual(['info', 'comment', 'history', 'graph']);
    expect(document.documentElement.getAttribute('data-theme')).toBe('penmoss');
    expect(document.documentElement.getAttribute('data-mode')).toBe('light');
  });

  it('draws Quick Access and Tags open and Calendar collapsed, as the app opens them', () => {
    const root = draw(mac.frameAt(5000));
    const open = (section: string) =>
      root
        .querySelector(`.sb-part[data-section="${section}"] .sb-section-toggle`)
        ?.getAttribute('aria-expanded');
    expect(open('quickAccess')).toBe('true');
    expect(open('tags')).toBe('true');
    expect(open('calendar')).toBe('false');
    expect(root.querySelectorAll('.sb-quick .sb-quick-list li').length).toBeGreaterThan(0);
    expect(root.querySelectorAll('.tag-pane .tag-tree .tag-row').length).toBeGreaterThan(4);
  });

  it('gives a Mac window the compact title bar, but not in full screen or on Android', () => {
    const frame = mac.frameAt(5000);
    draw(frame);
    expect(document.documentElement.dataset['titlebar']).toBe('compact');
    draw({ ...frame, window: { ...frame.window, fullScreen: true } });
    expect(document.documentElement.dataset['titlebar']).toBeUndefined();
    draw(android.frameAt(1000));
    expect(document.documentElement.dataset['titlebar']).toBeUndefined();
  });

  it('draws every block as lorem of its kind and length', () => {
    const root = draw(mac.frameAt(3600));
    const body = root.querySelector('.note-body .ProseMirror')!;
    expect(root.querySelector('.doc-title')?.textContent).toHaveLength(24);
    expect(body.querySelector('h1')?.textContent).toHaveLength(24);
    const paragraphs = [...body.children].filter((child) => child.tagName === 'P');
    expect(paragraphs[0]?.textContent).toHaveLength(182);
    expect(paragraphs[1]?.textContent).toHaveLength(96);
    // li.b.1:31, li.b.1:44, then li.b.2:18 nested in the second.
    const bullets = body.querySelector(':scope > ul:not([data-type])')!;
    expect(
      [...bullets.querySelectorAll(':scope > li > p')].map((p) => p.textContent?.length),
    ).toEqual([31, 44]);
    expect(bullets.querySelector('li li > p')?.textContent).toHaveLength(18);
    expect(body.querySelector('.pm-image .pm-image-frame')).not.toBeNull();
    expect(body.querySelectorAll('ul[data-type="taskList"] > li[data-checked]')).toHaveLength(2);
    // table.3x2:60 spreads its 60 characters over 6 cells, the first row its header.
    const table = body.querySelector('.pm-table table')!;
    expect(table.querySelectorAll('tr')).toHaveLength(3);
    expect(table.querySelectorAll('th')).toHaveLength(2);
    expect(
      [...table.querySelectorAll('p')].reduce((n, p) => n + (p.textContent?.length ?? 0), 0),
    ).toBe(60);
    expect(body.querySelector('hr')).not.toBeNull();
    expect(root.querySelector('.status-counts [data-field="characters"]')?.textContent).toMatch(
      / characters$/,
    );
  });

  it('draws the caret at the end of the block typed in, and a selection across blocks', () => {
    const typing = draw(mac.frameAt(6500));
    const item = typing.querySelector('.ProseMirror > ul > li > p')!;
    expect(item.lastElementChild?.className).toBe('pf-caret');
    expect(item.textContent).toHaveLength(34);
    const selected = draw(mac.frameAt(300_000));
    const marks = [...selected.querySelectorAll('.pf-selection')];
    expect(marks).toHaveLength(2);
    expect(marks.map((mark) => mark.textContent?.length)).toEqual([182, 48]);
  });

  it('draws the rail with Back, Forward and the pin at the tab strip’s start, and dark mode', () => {
    const root = draw(mac.frameAt(20_100), 'dark');
    expect(root.querySelector('.notes-app')?.getAttribute('data-sidebar')).toBe('collapsed');
    expect(iconsIn(root, '.tab-strip-lead')).toEqual(['navBack', 'navForward', 'pin']);
    expect(root.querySelector('.sb-head .history-nav')).toBeNull();
    expect(document.documentElement.getAttribute('data-mode')).toBe('dark');
  });

  it('draws the recorded theme and full width', () => {
    const root = draw(mac.frameAt(345_100), 'dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('solarized');
    expect(root.querySelector('article.note')?.getAttribute('data-width')).toBe('full');
    expect(root.querySelector('[aria-label="Full Width"]')?.getAttribute('aria-pressed')).toBe(
      'true',
    );
  });

  it('draws a note from before PEN-177 as placeholders, with an empty status bar', () => {
    const root = draw(older.frameAt(10_000));
    expect(root.querySelector('.pf-placeholder')).not.toBeNull();
    expect(root.querySelector('.doc-title .pf-bar')).not.toBeNull();
    expect(root.querySelector('.ProseMirror')).toBeNull();
    expect(root.querySelector('.status-counts')?.textContent).toBe('');
  });
});

describe('the other screens', () => {
  it("draws Settings: its bar, its nav with each page's icon, and the page's groups and rows", () => {
    const root = draw(mac.frameAt(30_000));
    expect(root.querySelector('.notes-app')).toBeNull();
    expect(iconsIn(root, '.settings-bar')).toEqual(['navBack', 'navForward', 'arrowL']);
    const nav = root.querySelector('.settings-nav')!;
    const entries = [
      ...nav.querySelectorAll(':scope > .settings-nav-group > a:not([class]):not([data-entry])'),
    ];
    expect(entries.map((a) => a.querySelector('svg')?.getAttribute('data-icon'))).toEqual(
      SETTINGS_PAGES.map((page) => page.icon),
    );
    expect(nav.querySelector('a[aria-current="page"]')?.textContent).toBe('Appearance');
    expect(nav.querySelector('[data-entry="privacy-data"] svg')?.getAttribute('data-icon')).toBe(
      'checklist',
    );
    expect(nav.querySelector('.nset-nav-entry .nb-badge')).not.toBeNull();
    expect(nav.querySelector('[data-group="mac"] .settings-nav-heading')?.textContent).toBe(
      'This Mac · Not Synced',
    );
    expect(root.querySelector('.settings-head-title')?.textContent).toBe('Appearance');
    expect(
      [...root.querySelectorAll('.lf-controls [data-setting]')].map((row) =>
        row.getAttribute('data-setting'),
      ),
    ).toEqual(
      SETTINGS_INDEX.filter((entry) => entry.section === 'appearance').map((entry) => entry.id),
    );
    // As AppearanceSettings lays it out: the Settings and Preview tabs, Settings shown; then Mode,
    // the built-in themes' cards (the drawn one checked) and Customize, before Text.
    expect(
      [...root.querySelectorAll('.lf-tabs .lf-tab')].map((tab) => [
        tab.textContent,
        tab.getAttribute('aria-selected'),
      ]),
    ).toEqual([
      ['Settings', 'true'],
      ['Preview', 'false'],
    ]);
    expect(iconsIn(root, '.lf-tabs')).toEqual(['settings', 'eye']);
    expect(root.querySelector('.lf-tabpanel > .lf-controls')).not.toBeNull();
    expect(root.querySelectorAll('.theme-grid .theme-card')).toHaveLength(BUILT_IN_THEMES.length);
    expect(
      root.querySelector('.theme-card:has(input:checked)')?.getAttribute('data-theme-id'),
    ).toBe('penmoss');
    expect(root.querySelector('.lf-actions .btn')?.textContent).toBe('Customize Penmoss…');
    expect(root.querySelector('.settings-head-bar')?.hasAttribute('data-pinned')).toBe(true);
  });

  it('names the device group This Phone on Android', () => {
    const root = draw(android.frameAt(14_000));
    expect(root.querySelector('[data-group="mac"] .settings-nav-heading')?.textContent).toBe(
      'This Phone · Not Synced',
    );
  });

  it('draws a Settings page outside the index over an empty page, current in the nav', () => {
    const base = mac.frameAt(30_000);
    const storage = draw({ ...base, screen: 'settings.storage' });
    expect(storage.querySelector('.settings-head-title')?.textContent).toBe('Storage');
    expect(storage.querySelectorAll('.lf-row')).toHaveLength(0);
    const data = draw({ ...base, screen: 'settings.privacy-data' });
    expect(data.querySelector('[data-entry="privacy-data"]')?.getAttribute('aria-current')).toBe(
      'page',
    );
    const notebook = draw({ ...base, screen: 'settings.git-notebook' });
    expect(notebook.querySelector('.nset-nav-entry')?.getAttribute('aria-current')).toBe('page');
  });

  it('draws any other screen, Home among them, as the app’s empty state titled with its name', () => {
    expect(draw(mac.frameAt(1000)).querySelector('.empty-state h2')?.textContent).toBe('Home');
    expect(draw(mac.frameAt(320_200)).querySelector('.empty-state h2')?.textContent).toBe('Tags');
    // Under the main window's tab strip, as the app keeps it on every route.
    expect(draw(mac.frameAt(320_200)).querySelector('.tab-strip')).not.toBeNull();
  });

  it("draws Android with the app's phone layout: no tab strip, the app bar and the format bar", () => {
    const root = draw(android.frameAt(10_000));
    expect(root.querySelector('.tab-strip')).toBeNull();
    expect(root.querySelector('article.note .app-bar')).not.toBeNull();
    expect(root.querySelectorAll('.phone-format button')).toHaveLength(8);
    expect(root.querySelector('.notes-app')?.hasAttribute('data-drawer')).toBe(false);
    const drawer = draw(android.frameAt(3000));
    expect(drawer.querySelector('.notes-app')?.getAttribute('data-drawer')).toBe('open');
    expect(drawer.querySelector('.drawer-scrim')).not.toBeNull();
  });
});

describe('dialogs', () => {
  const over = (dialogs: Frame['dialogs']) => draw({ ...mac.frameAt(6000), dialogs });

  it("draws the palette as the app's picker, its field holding the recorded length", () => {
    const root = draw(mac.frameAt(24_000));
    const field = root.querySelector<HTMLInputElement>(
      '.overlay .dialog.palette .dlg-search input',
    )!;
    expect(field.value).toHaveLength(10);
    expect(root.querySelector('.dialog.palette .dlg-foot')).not.toBeNull();
  });

  it('draws Search with its own filters, and lorem hits under Notes once a query is typed', () => {
    const empty = over([{ name: 'search', field: null, chars: null }]);
    expect(empty.querySelector('.dialog.palette.search .search-controls')).not.toBeNull();
    expect(empty.querySelector('.search-snippet')).toBeNull();
    expect(empty.querySelector('.search-status')?.textContent).toBe('Recent Notes');
    const typed = over([{ name: 'search', field: 'query', chars: 5 }]);
    expect(typed.querySelector<HTMLInputElement>('.dlg-search input')?.value).toHaveLength(5);
    expect(typed.querySelector('.search-results .grp-h')?.textContent).toBe('Notes');
    expect(typed.querySelectorAll('.search-hit .search-snippet').length).toBeGreaterThan(0);
  });

  it('draws any other dialog titled with its name and the shared ×', () => {
    const root = over([{ name: 'move', field: null, chars: null }]);
    expect(root.querySelector('.dialog .dlg-title h2')?.textContent).toBe('Move to Folder');
    expect(root.querySelector('.dlg-title .dlg-close')).not.toBeNull();
  });

  it('draws Confirmation with placeholder words, Cancel plain and the action filled, and its field', () => {
    const plain = over([{ name: 'confirm', field: null, chars: null }]);
    const dialog = plain.querySelector('dialog.confirm')!;
    expect(dialog.hasAttribute('open')).toBe(true);
    expect(dialog.querySelector('h2 .pf-bar')).not.toBeNull();
    expect([...dialog.querySelectorAll('.confirm-actions button')].map((b) => b.className)).toEqual(
      ['btn', 'btn primary'],
    );
    expect(dialog.querySelector('input')).toBeNull();
    expect(plain.querySelector('.pf-scrim')).not.toBeNull();
    const field = draw(mac.frameAt(323_000));
    expect(field.querySelector<HTMLInputElement>('dialog.confirm input')?.value).toHaveLength(6);
  });

  it('stacks a dialog opened inside another over it, each with its own scrim', () => {
    const root = over([
      { name: 'palette', field: 'query', chars: 4 },
      { name: 'confirm', field: null, chars: null },
    ]);
    const layers = [...root.querySelectorAll('.pf-layer')];
    expect(layers.map((layer) => layer.getAttribute('data-dialog'))).toEqual([
      'palette',
      'confirm',
    ]);
    expect(layers[0]?.querySelector('.overlay')).not.toBeNull();
    expect(layers[1]?.querySelector('.pf-scrim')).not.toBeNull();
  });

  it('writes no style attribute: custom properties are set through the CSSOM (CSP)', () => {
    for (const t of [3600, 5000, 30_000, 300_000, 323_000]) {
      expect(frameMarkup(mac.frameAt(t), data)).not.toMatch(/\sstyle=/);
    }
    expect(
      draw(mac.frameAt(5000))
        .querySelector<HTMLElement>('.note-columns')
        ?.style.getPropertyValue('--pm-panel-width'),
    ).toBe('26rem');
  });
});
