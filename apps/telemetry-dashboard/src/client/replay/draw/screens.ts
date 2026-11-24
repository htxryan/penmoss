/** The replay frame's other screens (PEN-178): the empty state, and Settings with its pages. */
import { BUILT_IN_THEMES } from '@penmoss/ui/theme';
import { PREVIEW_TABS } from '@penmoss/web/src/theme/preview-tabs';
import {
  PRIVACY_DATA_ICON,
  SETTINGS_GROUPS,
  SETTINGS_INDEX,
  SETTINGS_PAGES,
} from '@penmoss/web/src/pages/settings-index';
import { displayName } from '../../names';
import { loremOf } from '../lorem';
import {
  ANDROID_DEVICE_GROUP,
  h,
  text,
  vars,
  loremName,
  type Draw,
  icon,
  iconButton,
  historyNav,
  themeOf,
} from './markup';
import { badge } from './sidebar';
import { appBar } from './bars';

// ---------------------------------------------------------------------------------------------
// The other screens.

/** Any screen but a note or Settings: the app's empty state, titled with the screen's name. */
export function emptyScreen(draw: Draw): string {
  const title = draw.frame.screen === null ? 'Home' : displayName('screen', draw.frame.screen);
  return (
    appBar(draw, title, draw.frame.screen === null || draw.frame.screen === 'home') +
    h(
      'div',
      { class: 'home' },
      h(
        'div',
        { class: 'empty-state' },
        h('h2', {}, text(title)),
        h('p', {}, h('span', { class: 'pf-bar' })),
      ),
    )
  );
}

/** The page a Settings screen shows: its id, as SETTINGS_PAGES and the catalogue name it. */
function settingsPage(screen: string): string {
  return screen === 'settings' ? 'home' : screen.slice('settings.'.length);
}

export function settingsScreen(draw: Draw): string {
  const { frame } = draw;
  const page = settingsPage(frame.screen ?? 'settings');
  const android = frame.client === 'android';
  const title =
    page === 'home'
      ? 'Settings'
      : displayName('screen', `settings.${page}`).replace(/^Settings › /, '');
  const navEntry = (id: string, label: string, name: string) =>
    h(
      'a',
      { 'aria-current': id === page ? 'page' : undefined, tabindex: -1 },
      icon(draw, name),
      h('span', { class: 'bold-steady', 'data-label': label }, text(label)),
    );
  const nav = h(
    'nav',
    { class: 'settings-nav', 'aria-label': 'Settings Sections', 'data-pf-area': 'settings.nav' },
    ...SETTINGS_GROUPS.map((group) => {
      const pages = SETTINGS_PAGES.filter((p) => p.group === group.id);
      const label = group.id === 'mac' && android ? ANDROID_DEVICE_GROUP : group.label;
      return h(
        'div',
        { role: 'group', class: 'settings-nav-group', 'data-group': group.id },
        h(
          'p',
          { class: 'settings-nav-heading' },
          text(label),
          group.scope ? h('span', { class: 'settings-nav-scope' }, ` · ${text(group.scope)}`) : '',
        ),
        ...pages.map((p) => {
          let entry = navEntry(p.id, p.label, p.icon);
          if (p.id === 'git-notebooks') {
            // A notebook's own entry, as NotebookNavEntries draws it: its badge, its sync dot, its name.
            const name = loremName('notebook', 8);
            entry += h(
              'a',
              {
                class: 'nset-nav-entry',
                'data-state': 'synced',
                'aria-current': page === 'git-notebook' ? 'page' : undefined,
                tabindex: -1,
              },
              badge(16),
              h('span', { class: 'nset-dot', 'data-state': 'synced', 'aria-hidden': 'true' }),
              h('span', { class: 'bold-steady', 'data-label': name }, text(name)),
            );
          }
          if (p.id === 'privacy') {
            entry += h(
              'a',
              {
                // Flush with the other entries, so it has no class of its own (A1673).
                'data-entry': 'privacy-data',
                'aria-current': page === 'privacy-data' ? 'page' : undefined,
                tabindex: -1,
              },
              icon(draw, PRIVACY_DATA_ICON),
              h('span', { class: 'bold-steady', 'data-label': 'Analytics Data' }, 'Analytics Data'),
            );
          }
          return entry;
        }),
      );
    }),
  );
  // The page's groups and rows, in the index's order, with quiet empty controls: their values
  // weren't recorded.
  const entries = SETTINGS_INDEX.filter((entry) => entry.section === page);
  const groups: { name: string | undefined; rows: typeof entries }[] = [];
  for (const entry of entries) {
    const last = groups.at(-1);
    if (last && last.name === entry.group) last.rows = [...last.rows, entry];
    else groups.push({ name: entry.group, rows: [entry] });
  }
  const settingRow = (row: (typeof entries)[number]) =>
    h(
      'div',
      { class: 'lf-row', 'data-setting': row.id },
      h(
        'div',
        { class: 'lf-row-text' },
        h('span', { class: 'lf-row-label' }, text(row.label)),
        row.help ? h('span', { class: 'lf-row-help' }, text(row.help)) : '',
      ),
      h(
        'div',
        { class: 'lf-row-control' },
        h('span', { class: 'pf-control', 'aria-hidden': 'true' }),
      ),
    );
  const content = groups.map((group) =>
    [
      group.name
        ? h('div', { class: 'lf-sub' }, h('h3', { class: 'lf-sub-name' }, text(group.name)))
        : '',
      // Appearance's Theme group as AppearanceSettings lays it out: Mode, then the theme cards,
      // then Customize, so the page is its real height and a recorded scroll lands where it did.
      page === 'appearance' && group.name === 'Theme'
        ? appearanceTheme(draw, group.rows.filter((row) => row.label === 'Mode').map(settingRow))
        : h('div', { class: 'lf-group', role: 'group' }, ...group.rows.map(settingRow)),
    ].join(''),
  );
  // Appearance, Sidebar and Note have Settings and Preview tabs (PreviewTabs, A1633), Settings shown.
  const controls = PREVIEW_TAB_PAGES.has(page)
    ? h(
        'div',
        { class: 'lf-tabs', role: 'tablist', 'aria-label': title },
        ...PREVIEW_TABS.map(({ tab, label, icon: name }) =>
          h(
            'button',
            {
              type: 'button',
              role: 'tab',
              class: 'lf-tab',
              'aria-selected': String(tab === 'settings'),
              tabindex: -1,
            },
            icon(draw, name),
            text(label),
          ),
        ),
      ) +
      h(
        'div',
        { class: 'lf-tabpanel', role: 'tabpanel' },
        h('div', { class: 'lf-controls' }, ...content),
      )
    : h('div', { class: 'lf-controls' }, ...content);
  const scrolled = (frame.scroll['settings'] ?? 0) > 0;
  const search = frame.settingsSearch;
  return h(
    'main',
    { class: 'settings-shell' },
    h(
      'header',
      { class: 'settings-bar' },
      historyNav(draw),
      h('a', { class: 'back-link', tabindex: -1 }, icon(draw, 'arrowL'), 'Notes'),
    ),
    h(
      'div',
      { class: 'settings-page' },
      h(
        'div',
        { class: 'settings-layout' },
        h(
          'div',
          { class: 'settings-side' },
          h(
            'div',
            { class: 'settings-search', role: 'search' },
            icon(draw, 'search'),
            h('input', {
              type: 'search',
              class: 'input',
              placeholder: 'Search Settings',
              'aria-label': 'Search Settings',
              value: search ? loremOf('settings-search', search) : '',
              tabindex: -1,
              readonly: true,
            }),
          ),
          nav,
        ),
        h(
          'div',
          { class: 'settings-content', 'data-pf-area': 'settings' },
          h(
            'section',
            { class: 'settings-section lf-page' },
            h(
              'div',
              { class: 'settings-head-bar', 'data-pinned': scrolled ? '' : undefined },
              h('span', { class: 'settings-head-root' }, 'Settings'),
              h(
                'span',
                { class: 'settings-info' },
                iconButton(draw, 'info', 'About Settings', { class: 'settings-info-button' }),
              ),
              h(
                'span',
                { class: 'settings-head-crumb', 'aria-hidden': 'true' },
                h('span', { class: 'settings-head-slash' }, '/'),
                text(title),
              ),
            ),
            h(
              'div',
              { class: 'settings-head' },
              h(
                'div',
                { class: 'settings-head-row' },
                h('h1', { class: 'settings-head-title' }, text(title)),
              ),
            ),
            controls,
          ),
        ),
      ),
    ),
  );
}

/** The Settings pages with Settings and Preview tabs (PreviewTabs.tsx's callers). */
const PREVIEW_TAB_PAGES = new Set(['appearance', 'sidebar', 'note']);

/**
 * Appearance's Theme group: the Mode row, the built-in themes' cards as ThemeCard draws them (the
 * one drawn checked), then Customize. Hand-written markup, under O1's exception.
 */
function appearanceTheme(draw: Draw, modeRows: readonly string[]): string {
  const shown = themeOf(draw.frame);
  return (
    h('div', { class: 'lf-group', role: 'group' }, ...modeRows) +
    h(
      'div',
      { class: 'theme-grid', role: 'radiogroup', 'aria-label': 'Theme', 'data-setting': 'theme' },
      ...BUILT_IN_THEMES.map((theme) =>
        h(
          'label',
          { class: 'theme-card', 'data-theme-id': theme.id },
          h('input', {
            type: 'radio',
            value: theme.id,
            checked: theme.id === shown.id ? true : undefined,
            tabindex: -1,
            disabled: true,
          }),
          h(
            'span',
            { class: 'theme-swatch', 'aria-hidden': 'true' },
            ...(['light', 'dark'] as const).map((variant) => {
              const c = theme[variant];
              return h(
                'span',
                {
                  class: 'sw-half',
                  'data-pf-vars': vars({
                    '--sw-bg': c.bg,
                    '--sw-sidebar': c.sidebar,
                    '--sw-fg': c.fg,
                    '--sw-muted': c.muted,
                    '--sw-border': c.border,
                    '--sw-accent': c.accent,
                    '--sw-k': c.codeKeyword,
                    '--sw-s': c.codeString,
                    '--sw-f': c.codeFunction,
                  }),
                },
                h('span', { class: 'sw-side' }),
                h(
                  'span',
                  { class: 'sw-main' },
                  h('span', { class: 'sw-line sw-title' }),
                  h('span', { class: 'sw-line sw-text' }),
                  h('span', { class: 'sw-line sw-text short' }),
                  h(
                    'span',
                    { class: 'sw-code' },
                    h('span', { class: 'sw-k' }),
                    h('span', { class: 'sw-s' }),
                    h('span', { class: 'sw-f' }),
                  ),
                  h('span', { class: 'sw-button' }),
                ),
              );
            }),
          ),
          h(
            'span',
            { class: 'theme-card-foot' },
            h(
              'span',
              { class: 'theme-card-name' },
              text(theme.name),
              h('span', { class: 'theme-card-note' }, text(theme.description)),
            ),
            theme.id === shown.id ? icon(draw, 'check') : '',
          ),
        ),
      ),
    ) +
    h(
      'div',
      { class: 'lf-actions', 'data-setting': 'customize-theme' },
      h(
        'button',
        { type: 'button', class: 'btn', tabindex: -1 },
        icon(draw, 'brush', 14),
        text(`Customize ${shown.name}…`),
      ),
      h('span', { class: 'lf-help' }, 'Edits a copy, which syncs to your other devices.'),
    )
  );
}
