/** The replay frame's sidebar (PEN-178): SidebarBody's sections, a rail, or the phone's drawer. */
import { SHORTCUTS } from '@penmoss/web/src/shell/sidebar-shortcuts';
import { isNoteScreen } from '../state';
import {
  h,
  text,
  vars,
  loremName,
  type Draw,
  icon,
  iconButton,
  historyNav,
  keepOnTop,
  brand,
  noteTitle,
} from './markup';

/** A sidebar section's head: its toggle, open or not. */
/** The sidebar's lorem tags: each name's length and its count of notes. */
const TAG_ROWS: readonly (readonly [number, number])[] = [
  [6, 12],
  [9, 7],
  [5, 5],
  [11, 4],
  [7, 3],
  [8, 3],
  [4, 2],
  [10, 1],
];

const sectionHead = (draw: Draw, name: string, open: boolean, tools = '') =>
  h(
    'header',
    { class: 'sb-section-head sb-part-head' },
    h(
      'h2',
      { class: 'sb-section-title' },
      h(
        'button',
        { type: 'button', class: 'sb-section-toggle', 'aria-expanded': String(open), tabindex: -1 },
        icon(draw, open ? 'chevD' : 'chevR'),
        h('span', { class: 'sb-section-name' }, text(name)),
      ),
    ),
    tools,
  );

/** The notebook's badge: a letter on its colour, as NotebookBadge draws it. */
export const badge = (size: number, className = '') =>
  h(
    'span',
    {
      class: `nb-badge${className ? ` ${className}` : ''}`,
      'aria-hidden': 'true',
      'data-kind': 'letter',
      'data-pf-vars': vars({
        '--nb-badge-bg': 'var(--pm-accent)',
        '--nb-badge-ink': 'var(--pm-on-accent)',
        '--nb-badge-size': `${size / 16}rem`,
      }),
    },
    h('span', { class: 'nb-badge-text', 'aria-hidden': 'true' }, 'l'),
  );

export function sidebar(draw: Draw, navInTitleBar: boolean): string {
  const { frame } = draw;
  const rail = frame.layout.sidebar === 'rail' && !draw.phone;
  const shownTitle = isNoteScreen(frame.screen) ? noteTitle(frame.note) : null;
  const shortcuts = h(
    'div',
    { class: 'sb-shortcuts' },
    iconButton(draw, 'plus', 'New Note', { class: 'sb-shortcut new-note' }, 18),
    ...SHORTCUTS.map((shortcut) =>
      shortcut.command === 'app.graph'
        ? h(
            'a',
            { class: 'icon-btn sb-shortcut sb-graph', 'aria-label': shortcut.label, tabindex: -1 },
            icon(draw, shortcut.icon, 18),
          )
        : iconButton(
            draw,
            shortcut.icon,
            shortcut.label,
            {
              class: 'sb-shortcut',
              'aria-current':
                shortcut.command === 'app.tags' && frame.screen === 'tags' ? 'page' : undefined,
            },
            18,
          ),
    ),
  );
  const noteRow = (title: string, current: boolean, level: number) =>
    h(
      'div',
      {
        class: 'tree-row note-row',
        role: 'treeitem',
        'aria-level': level,
        'data-pf-vars': vars({ '--depth': String(level - 1) }),
      },
      h('span', { class: 'twisty', 'data-empty': '', 'aria-hidden': 'true' }),
      h(
        'a',
        { class: 'tree-link', 'aria-current': current ? 'page' : undefined, tabindex: -1 },
        icon(draw, 'file', 16, 'tree-icon'),
        h('span', { class: 'tree-label' }, text(title)),
      ),
    );
  const folderRow = (name: string, open: boolean, level: number) =>
    h(
      'div',
      {
        class: 'tree-row folder-row',
        role: 'treeitem',
        'aria-level': level,
        'aria-expanded': String(open),
        'data-pf-vars': vars({ '--depth': String(level - 1) }),
      },
      h(
        'span',
        { class: 'twisty', 'data-open': String(open), 'aria-hidden': 'true' },
        icon(draw, 'chevR', 12, 'chevron'),
      ),
      icon(draw, 'folder', 16, 'tree-icon'),
      h('span', { class: 'tree-label' }, text(name)),
    );
  const tree = rail
    ? ''
    : h(
        'div',
        { class: 'folders' },
        h(
          'div',
          { class: 'tree', role: 'tree', 'aria-label': 'Folders and notes' },
          folderRow(loremName('folder:1', 9), true, 1),
          ...(shownTitle ? [noteRow(shownTitle, true, 2)] : []),
          noteRow(loremName('tree:1', 16), false, 2),
          noteRow(loremName('tree:2', 11), false, 2),
          folderRow(loremName('folder:2', 7), false, 1),
          folderRow(loremName('folder:3', 12), false, 1),
          noteRow(loremName('tree:3', 14), false, 1),
        ),
      );
  const recent = [
    ...(shownTitle ? [{ title: shownTitle, current: true }] : []),
    { title: loremName('recent:1', 15), current: false },
    { title: loremName('recent:2', 10), current: false },
  ];
  const list = h(
    'nav',
    { class: 'sb-list', 'aria-label': 'All notes' },
    h(
      'div',
      { class: 'sb-part', 'data-section': 'quickAccess' },
      // Open, as the app opens it, with lorem pinned notes.
      h(
        'section',
        { class: 'sb-section sb-quick' },
        sectionHead(draw, 'Quick Access', true),
        h(
          'ul',
          { class: 'sb-quick-list', role: 'list' },
          ...[loremName('pinned:1', 12), loremName('pinned:2', 9)].map((title) =>
            h(
              'li',
              {},
              h(
                'a',
                { class: 'sb-item', tabindex: -1 },
                icon(draw, 'file'),
                h('span', { class: 'label' }, h('span', { class: 'sb-item-title' }, text(title))),
              ),
            ),
          ),
        ),
      ),
    ),
    h(
      'div',
      { class: 'sb-part', 'data-section': 'recent' },
      h(
        'section',
        { class: 'sb-section sb-recent' },
        sectionHead(draw, 'Recent Notes', true),
        h(
          'ul',
          { class: 'sb-quick-list', role: 'list' },
          ...recent.map((note) =>
            h(
              'li',
              {},
              h(
                'a',
                {
                  class: 'sb-item',
                  'aria-current': note.current ? 'page' : undefined,
                  tabindex: -1,
                },
                icon(draw, 'file'),
                h('span', { class: 'label' }, text(note.title)),
              ),
            ),
          ),
        ),
      ),
    ),
    h(
      'div',
      { class: 'sb-part', 'data-section': 'notebooks' },
      h(
        'section',
        { class: 'sb-notebooks' },
        sectionHead(draw, 'Notebooks', true),
        h(
          'div',
          { class: 'sb-notebooks-body' },
          h(
            'section',
            { class: 'sb-section sb-source', 'data-kind': 'git' },
            h(
              'header',
              { class: 'sb-section-head', 'data-sync': 'synced' },
              h(
                'button',
                {
                  type: 'button',
                  class: 'sb-section-toggle sb-notebook-name',
                  'aria-expanded': 'true',
                  tabindex: -1,
                },
                icon(draw, 'chevD'),
                badge(18, 'sb-source-badge'),
                h('span', { class: 'sb-section-name' }, text(loremName('notebook', 8))),
              ),
              h(
                'a',
                {
                  class: 'sync-dot',
                  'data-state': 'synced',
                  'aria-label': 'Sync status',
                  tabindex: -1,
                },
                h('span', { class: 'dot', 'aria-hidden': 'true' }),
              ),
            ),
            h('div', { class: 'sb-section-body' }, tree),
          ),
        ),
      ),
    ),
    // Collapsed, so no date that wasn't the session's appears.
    h(
      'div',
      { class: 'sb-part', 'data-section': 'calendar' },
      h(
        'section',
        { class: 'calendar', 'data-collapsed': 'true' },
        sectionHead(draw, 'Calendar', false),
      ),
    ),
    // Open, as the app opens it, with lorem tags, so a recorded scroll of Tags has rows to move.
    h(
      'div',
      { class: 'sb-part', 'data-section': 'tags' },
      h(
        'section',
        { class: 'tag-pane' },
        sectionHead(draw, 'Tags', true),
        h(
          'ul',
          { class: 'tag-tree', role: 'list' },
          ...TAG_ROWS.map(([length, count], i) =>
            h(
              'li',
              { class: 'tag-item' },
              h(
                'div',
                { class: 'tag-row', 'data-pf-vars': vars({ '--depth': '0' }) },
                h('span', { class: 'twisty', 'data-empty': '', 'aria-hidden': 'true' }),
                h(
                  'button',
                  { type: 'button', class: 'tag-name', tabindex: -1 },
                  h('span', { class: 'tag-hash', 'aria-hidden': 'true' }, '#'),
                  h('span', { class: 'tag-label' }, text(loremName(`tag:${i + 1}`, length))),
                  h('span', { class: 'count' }, String(count)),
                ),
              ),
            ),
          ),
        ),
      ),
    ),
  );
  const feedback = iconButton(draw, 'feedback', 'Send Feedback', {}, 18);
  const settings = h(
    'a',
    { class: 'icon-btn', 'aria-label': 'Settings', tabindex: -1 },
    icon(draw, 'gear', 18),
  );
  return h(
    'aside',
    { id: 'app-sidebar', class: 'sidebar', 'aria-label': 'Notes' },
    h(
      'div',
      { class: 'sb-head' },
      navInTitleBar ? '' : historyNav(draw),
      brand(),
      navInTitleBar ? '' : keepOnTop(draw),
      iconButton(draw, 'panelL', rail ? 'Expand the Sidebar' : 'Collapse the Sidebar', {
        class: 'sb-collapse',
        'aria-expanded': String(!rail),
      }),
      iconButton(draw, 'close', 'Close Navigation', { class: 'drawer-close' }),
    ),
    h('div', { class: 'sb-actions' }, shortcuts),
    list,
    h('footer', { class: 'sb-foot' }, rail ? feedback : '', settings, rail ? '' : feedback),
    rail || draw.phone
      ? ''
      : h('div', { role: 'separator', 'aria-label': 'Sidebar Width', class: 'pane-resizer' }),
  );
}
