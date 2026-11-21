/**
 * Draws a replay's Frame (PEN-178) as Penmoss looked: the app's own markup (the class names and
 * structure the running app renders: App.tsx, SidebarBody, TabStrip, NoteView, SettingsPage, the
 * pickers and dialogs) under the app's own stylesheets, loaded by player.html. The markup is
 * written here by hand, a stated exception to A1564 (the components need a notebook source and
 * an editor the dashboard hasn't got), and test/client/app-classes.test.ts fails when a class it
 * uses is no longer in the app. The lists it draws (Settings' pages, groups, rows and icons, the
 * sidebar's shortcuts, the phone's formatting bar, the note's bar) are the app's own, imported.
 *
 * Nothing a person wrote is drawn: notes, names and fields are lorem ipsum of recorded lengths.
 * Under the page's CSP (style-src 'self') no style attribute is written: a custom property goes
 * in data-pf-vars and is set through style.setProperty.
 */
import { BUILT_IN_THEMES, PENMOSS, applyThemeTo } from '@penmoss/ui/theme';
import { SHORTCUTS } from '@penmoss/web/src/shell/sidebar-shortcuts';
import { PHONE_FORMAT_BUTTONS } from '@penmoss/web/src/notes/phone-format-buttons';
import {
  NOTE_BAR_BUTTONS,
  NOTE_BAR_BUTTON_INFO,
  noteBarShows,
} from '@penmoss/web/src/notes/note-bar-buttons';
import {
  PRIVACY_DATA_ICON,
  SETTINGS_GROUPS,
  SETTINGS_INDEX,
  SETTINGS_PAGES,
} from '@penmoss/web/src/pages/settings-index';
import { displayName } from '../names';
import type { FrameData } from './frame-data';
import { loremOf } from './lorem';
import { bucketFloor, isNoteScreen, type Frame, type FrameDialog, type FrameNote } from './state';

/** What the page posts the frame. */
export interface FrameMessage {
  readonly type: 'frame';
  readonly frame: Frame;
  /** Light or dark, System already resolved by the page. */
  readonly variant: 'light' | 'dark';
}

/** The app's narrow layout: one breakpoint, NARROW_QUERY (shell/media.ts). */
export const NARROW_PX = 700;

/** The phone's Settings group in place of This Mac, as Android names it. */
const ANDROID_DEVICE_GROUP = 'This Phone';

/** The dialogs drawn as the app's picker (.dialog.palette). */
const PICKERS = new Set(['palette', 'quickOpen', 'newTab', 'recent']);

// ---------------------------------------------------------------------------------------------
// Markup.

type Attr = string | number | boolean | null | undefined;

const escape = (text: string) =>
  text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

const VOID = new Set(['input', 'img', 'hr', 'br']);

/** An element as markup: `false`, null and undefined attributes are left out, `true` is bare. */
function h(tag: string, attrs: Readonly<Record<string, Attr>>, ...children: string[]): string {
  let open = `<${tag}`;
  for (const [name, value] of Object.entries(attrs)) {
    if (value === false || value === null || value === undefined) continue;
    open += value === true ? ` ${name}` : ` ${name}="${escape(String(value))}"`;
  }
  return VOID.has(tag) ? `${open}>` : `${open}>${children.join('')}</${tag}>`;
}

const text = (value: string) => escape(value);

/** Custom properties for an element, set through style.setProperty once it is in the page. */
const vars = (entries: Readonly<Record<string, string>>) =>
  Object.entries(entries)
    .map(([name, value]) => `${name}:${value}`)
    .join(';');

/** A name made of lorem: lower case on purpose, since it stands for what a person wrote. */
const loremName = (seed: string, length: number) => {
  const words = loremOf(seed, length + 12)
    .replace(/[.,]/g, '')
    .split(' ');
  let name = words[0] ?? 'lorem';
  for (const word of words.slice(1)) {
    if (name.length + 1 + word.length > length) break;
    name += ` ${word}`;
  }
  return name;
};

// ---------------------------------------------------------------------------------------------
// The drawing.

interface Draw {
  readonly frame: Frame;
  readonly data: FrameData;
  /** At or under NARROW_PX: the app's phone layout. */
  readonly phone: boolean;
  readonly mac: boolean;
}

function icon(draw: Draw, name: string, size = 16, className?: string): string {
  const svg = draw.data.icons[name] ?? '';
  return svg
    .replace(/ width="16" height="16"/, ` width="${size}" height="${size}"`)
    .replace('class="i"', className ? `class="i ${className}"` : 'class="i"');
}

function iconButton(
  draw: Draw,
  name: string,
  label: string,
  extra: Readonly<Record<string, Attr>> = {},
  size = 16,
): string {
  const { class: className, ...rest } = extra;
  return h(
    'button',
    {
      type: 'button',
      class: `icon-btn${className ? ` ${String(className)}` : ''}`,
      'aria-label': label,
      tabindex: -1,
      ...rest,
    },
    icon(draw, name, size),
  );
}

const historyNav = (draw: Draw) =>
  h(
    'nav',
    { class: 'history-nav', 'aria-label': 'History' },
    h(
      'span',
      { class: 'history-pair' },
      iconButton(draw, 'navBack', 'Back', { class: 'history-half' }),
      iconButton(draw, 'navForward', 'Forward', { class: 'history-half' }),
    ),
  );

const keepOnTop = (draw: Draw) =>
  draw.mac
    ? iconButton(draw, 'pin', 'Keep on Top', { class: 'keep-on-top', 'aria-pressed': 'false' }, 18)
    : '';

const brand = () =>
  h(
    'h1',
    { class: 'brand' },
    h(
      'span',
      { class: 'brand-mark', 'aria-hidden': 'true' },
      h('img', {
        class: 'brand-mark-light',
        src: '/brand-mark-light.svg',
        alt: '',
        width: 20,
        height: 20,
      }),
      h('img', {
        class: 'brand-mark-dark',
        src: '/brand-mark-dark.svg',
        alt: '',
        width: 20,
        height: 20,
      }),
    ),
    h('span', {}, 'Penmoss'),
  );

/** The open note's title as the sidebar and the tab show it. */
function noteTitle(note: FrameNote | null): string {
  if (!note?.title) return loremName('note:shown', 18);
  // As the note's own title field holds it; an empty title shows as the app shows it.
  return note.title.length === 0 ? 'Untitled' : loremOf(note.title.seed, note.title.length);
}

/** A sidebar section's head: its toggle, open or not. */
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
const badge = (size: number, className = '') =>
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

function sidebar(draw: Draw, navInTitleBar: boolean): string {
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
      h('section', { class: 'sb-section sb-quick' }, sectionHead(draw, 'Quick Access', false)),
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
      h('section', { class: 'calendar' }, sectionHead(draw, 'Calendar', false)),
    ),
    h(
      'div',
      { class: 'sb-part', 'data-section': 'tags' },
      h('section', { class: 'tag-pane' }, sectionHead(draw, 'Tags', false)),
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

/** The note's bar's buttons: those noteBarShows gives with no settings recorded, then More. */
function noteBar(draw: Draw): string {
  const full = draw.frame.layout.fullWidth;
  return h(
    'div',
    { class: 'note-actions' },
    ...NOTE_BAR_BUTTONS.filter((button) => noteBarShows({}, button)).map((button) => {
      const info = NOTE_BAR_BUTTON_INFO[button];
      return iconButton(draw, info.icon, info.label, {
        'aria-pressed': button === 'fullWidth' ? String(full) : undefined,
      });
    }),
    h('div', { class: 'menu-anchor' }, iconButton(draw, 'more', 'Note Actions')),
  );
}

function tabStrip(draw: Draw, navInTitleBar: boolean): string {
  const { frame } = draw;
  const count = Math.max(1, bucketFloor(frame.layout.tabs) ?? 1);
  const onNote = isNoteScreen(frame.screen);
  const currentTitle = onNote
    ? noteTitle(frame.note)
    : displayName('screen', frame.screen ?? 'home');
  const currentIcon = onNote
    ? 'file'
    : frame.screen === 'tags'
      ? 'hash'
      : frame.screen === 'graph'
        ? 'graph'
        : frame.screen === 'trash'
          ? 'trash'
          : 'file';
  const tabs = Array.from({ length: count }, (_, i) => {
    const current = i === 0;
    return h(
      'div',
      {
        role: 'tab',
        class: 'tab',
        'aria-selected': String(current),
        'data-kind': current && !onNote ? 'page' : 'note',
        tabindex: -1,
      },
      h(
        'span',
        { class: 'tab-mark', 'aria-hidden': 'true' },
        icon(draw, current ? currentIcon : 'file'),
      ),
      h(
        'span',
        { class: 'tab-title' },
        h('bdi', {}, text(current ? currentTitle : loremName(`tab:${i}`, 9 + (i % 3) * 4))),
      ),
      h('span', { class: 'tab-close', 'aria-hidden': 'true' }, icon(draw, 'close', 12)),
    );
  });
  return h(
    'div',
    { class: 'tab-strip' },
    navInTitleBar ? h('div', { class: 'tab-strip-lead' }, historyNav(draw), keepOnTop(draw)) : '',
    h(
      'div',
      { class: 'tab-list', role: 'tablist', 'aria-label': 'Open Tabs' },
      h('div', { class: 'tab-group tab-group-scroll', role: 'presentation' }, ...tabs),
    ),
    iconButton(draw, 'plus', 'New Tab', { class: 'tab-new' }),
    h(
      'button',
      { type: 'button', class: 'tab-all', 'aria-label': `All Tabs, ${count}`, tabindex: -1 },
      icon(draw, 'chevD', 14),
      h('span', {}, String(count)),
    ),
    h('span', { class: 'tab-strip-fill', 'aria-hidden': 'true' }),
    h('div', { class: 'tab-strip-end' }, onNote ? noteBar(draw) : ''),
  );
}

/** The phone's app bar, at the top of every notes screen (AppBar.tsx). */
const appBar = (draw: Draw, title: string, brandMark = false) =>
  h(
    'header',
    { class: 'app-bar' },
    iconButton(draw, 'menu', 'Open Navigation'),
    brandMark
      ? h(
          'span',
          { class: 'brand-mark', 'aria-hidden': 'true' },
          h('img', {
            class: 'brand-mark-light',
            src: '/brand-mark-light.svg',
            alt: '',
            width: 20,
            height: 20,
          }),
          h('img', {
            class: 'brand-mark-dark',
            src: '/brand-mark-dark.svg',
            alt: '',
            width: 20,
            height: 20,
          }),
        )
      : '',
    h('h1', { class: 'app-bar-title' }, text(title)),
    iconButton(draw, 'search', 'Search Notes'),
  );

// ---------------------------------------------------------------------------------------------
// The note.

/** A block's text with the caret and the selection drawn in it. */
interface Marks {
  readonly caret: boolean;
  /** How many characters from the start are selected. */
  readonly selected: number;
}

function blockText(seed: string, length: number | null, marks: Marks): string {
  const full = loremOf(seed, length ?? 0);
  const selected = Math.min(full.length, marks.selected);
  return (
    (selected > 0 ? h('span', { class: 'pf-selection' }, text(full.slice(0, selected))) : '') +
    text(full.slice(selected)) +
    (marks.caret ? h('span', { class: 'pf-caret', 'aria-hidden': 'true' }) : '')
  );
}

/** A table's text spread over its cells, the first row its header. */
function table(token: string, seed: string, length: number, marks: Marks): string {
  const match = token.match(/^table\.(\d+)x(\d+)/);
  const rows = Math.min(30, Number(match?.[1] ?? 1));
  const cols = Math.min(12, Number(match?.[2] ?? 1));
  const cells = rows * cols;
  const each = Math.floor(length / cells);
  const extra = length % cells;
  let n = 0;
  const body = Array.from({ length: rows }, (_, r) =>
    h(
      'tr',
      {},
      ...Array.from({ length: cols }, () => {
        const k = n++;
        const chars = each + (k < extra ? 1 : 0);
        const last = k === cells - 1;
        return h(
          r === 0 ? 'th' : 'td',
          {},
          h('p', {}, blockText(`${seed}:${k}`, chars, { caret: marks.caret && last, selected: 0 })),
        );
      }),
    ),
  );
  return h(
    'div',
    { class: 'pm-table' },
    h('div', { class: 'pm-table-scroll' }, h('table', {}, h('tbody', {}, ...body))),
  );
}

/** One block that isn't a list item, as the editor draws it. */
function block(token: string, seed: string, length: number | null, marks: Marks): string {
  const kind = token.match(/^[a-z]+/)?.[0] ?? 'other';
  const inner = () => blockText(seed, length, marks);
  switch (kind) {
    case 'p':
      return h('p', {}, inner());
    case 'h':
      return h(`h${token[1]}`, {}, inner());
    case 'quote':
      return h('blockquote', {}, h('p', {}, inner()));
    case 'code':
      return h('div', { class: 'pm-code-block' }, h('pre', {}, h('code', {}, inner())));
    case 'callout':
      return h(
        'div',
        { class: 'pm-callout', 'data-callout-type': 'note' },
        h(
          'div',
          { class: 'pm-callout-header' },
          h('span', { class: 'pm-callout-icon', 'aria-hidden': 'true' }),
        ),
        h('div', { class: 'pm-callout-body' }, h('p', {}, inner())),
      );
    case 'math':
      return h(
        'div',
        { class: 'pm-math pm-math-block' },
        h('div', { class: 'pm-math-output' }, inner()),
      );
    case 'raw':
      return h('pre', { class: 'pm-raw-markdown' }, inner());
    case 'table':
      return table(token, seed, length ?? 0, marks);
    case 'image':
      return h(
        'p',
        {},
        h('span', { class: 'pm-image' }, h('span', { class: 'pm-image-frame pf-media' })),
      );
    case 'drawing':
      return h(
        'p',
        {},
        h(
          'span',
          { class: 'pm-image pm-drawing' },
          h('span', { class: 'pm-image-frame pf-media' }),
        ),
      );
    case 'embed':
      return h(
        'div',
        { class: 'pm-embed' },
        h('div', { class: 'pm-embed-head' }, h('span', { class: 'pm-embed-mark' })),
        h('div', { class: 'pm-embed-body pf-media' }),
      );
    case 'file':
      return h(
        'p',
        {},
        h(
          'span',
          { class: 'pm-attachment' },
          h(
            'span',
            { class: 'pm-attachment-chip' },
            h('span', { class: 'pm-attachment-badge' }),
            h('span', { class: 'pm-attachment-name' }, text(loremName(seed, 12))),
          ),
        ),
      );
    case 'hr':
      return h('hr', {});
    default:
      return h('p', {}, marks.caret ? h('span', { class: 'pf-caret', 'aria-hidden': 'true' }) : '');
  }
}

interface ListItem {
  readonly list: 'b' | 'n' | 't';
  readonly depth: number;
  readonly html: string;
}

/** A run of list items, nested by depth: bulleted, numbered or a checklist, as TipTap draws them. */
function lists(items: readonly ListItem[]): string {
  let i = 0;
  const level = (depth: number): string => {
    let out = '';
    while (i < items.length && items[i]!.depth >= depth) {
      const kind = items[i]!.list;
      let entries = '';
      while (
        i < items.length &&
        items[i]!.depth >= depth &&
        (items[i]!.depth > depth || items[i]!.list === kind)
      ) {
        if (items[i]!.depth > depth) {
          // Deeper than any item before it at this depth: nested under an empty item.
          entries += h('li', {}, level(depth + 1));
          continue;
        }
        const item = items[i++]!;
        const nested = i < items.length && items[i]!.depth > depth ? level(depth + 1) : '';
        entries +=
          kind === 't'
            ? h(
                'li',
                { 'data-checked': 'false' },
                h('label', {}, h('input', { type: 'checkbox', disabled: true, tabindex: -1 })),
                h('div', {}, h('p', {}, item.html), nested),
              )
            : h('li', {}, h('p', {}, item.html), nested);
      }
      out +=
        kind === 'n'
          ? h('ol', {}, entries)
          : kind === 't'
            ? h('ul', { 'data-type': 'taskList' }, entries)
            : h('ul', {}, entries);
    }
    return out;
  };
  return level(1);
}

/** The note's body: every block, in order, list items gathered into their lists. */
function noteBody(note: FrameNote): string {
  const blocks = note.blocks ?? [];
  const selection = note.selection;
  let remaining = selection ? selection.chars : 0;
  const marksOf = (i: number, length: number | null): Marks => {
    let selected = 0;
    if (selection && i >= selection.block && i < selection.block + selection.span) {
      selected = Math.min(remaining, length ?? 0);
      remaining -= selected;
    }
    return { caret: note.caret === i, selected };
  };
  let out = '';
  let run: ListItem[] = [];
  blocks.forEach((b, i) => {
    const marks = marksOf(i, b.length);
    const item = b.token.match(/^li\.([bnt])\.(\d)/);
    if (item) {
      run.push({
        list: item[1] as ListItem['list'],
        depth: Number(item[2]),
        html: blockText(b.seed, b.length, marks),
      });
      return;
    }
    if (run.length > 0) {
      out += lists(run);
      run = [];
    }
    out += block(b.token, b.seed, b.length, marks);
  });
  if (run.length > 0) out += lists(run);
  return out;
}

/** The note's words and characters, the lorem's. */
function counts(note: FrameNote): { words: number; characters: number } {
  let words = 0;
  let characters = 0;
  for (const b of note.blocks ?? []) {
    const body = loremOf(b.seed, b.length ?? 0);
    characters += b.length ?? 0;
    words += body.split(/\s+/).filter(Boolean).length;
  }
  return { words, characters };
}

const placeholderLines = () =>
  h(
    'div',
    { class: 'pf-placeholder', 'aria-hidden': 'true' },
    ...[92, 100, 86, 0, 100, 74, 96, 60, 0, 88, 100, 52].map((width) =>
      width === 0
        ? h('span', { class: 'pf-gap' })
        : h('span', { class: 'pf-line', 'data-pf-vars': vars({ '--pf-width': `${width}%` }) }),
    ),
  );

function noteScreen(draw: Draw, navInTitleBar: boolean, strip: boolean): string {
  const { frame } = draw;
  const note = frame.note;
  const known = note?.blocks !== null && note !== null;
  const title =
    known && note.title
      ? blockText(note.title.seed, note.title.length, {
          caret: note.caret === 'title',
          selected: 0,
        })
      : '';
  const panelOpen = frame.layout.panel === 'open';
  const folder = loremName('folder:1', 9);
  const top = strip
    ? ''
    : h(
        'header',
        { class: 'note-top' },
        navInTitleBar
          ? h('div', { class: 'note-top-lead' }, historyNav(draw), keepOnTop(draw))
          : '',
        h(
          'nav',
          { class: 'crumbs', 'aria-label': 'Breadcrumb' },
          h(
            'ol',
            {},
            h('li', {}, text(folder)),
            h('li', { 'aria-current': 'page' }, text(noteTitle(note))),
          ),
        ),
        noteBar(draw),
      );
  const tally = known ? counts(note) : null;
  const side = panelOpen
    ? h(
        'aside',
        { class: 'note-side', 'aria-label': 'Metadata' },
        h(
          'div',
          { class: 'note-side-head' },
          h('h2', {}, 'Metadata'),
          iconButton(draw, 'close', 'Close Panel'),
        ),
        h(
          'div',
          { class: 'note-tabpanel', role: 'tabpanel', 'data-tab': 'info' },
          h(
            'section',
            { class: 'note-info' },
            h('h3', { class: 'info-subheading' }, 'Details'),
            h(
              'dl',
              { class: 'info-list' },
              h('dt', {}, 'Folder'),
              h('dd', {}, text(folder)),
              h('dt', {}, 'Words'),
              h('dd', {}, tally ? String(tally.words) : '—'),
              h('dt', {}, 'Characters'),
              h('dd', {}, tally ? String(tally.characters) : '—'),
            ),
          ),
        ),
      ) + h('div', { role: 'separator', 'aria-label': 'Panel Width', class: 'pane-resizer' })
    : '';
  const rail = h(
    'aside',
    { class: 'note-rail', 'aria-label': 'Note Panel' },
    h(
      'div',
      { class: 'note-rail-icons', role: 'tablist', 'aria-label': 'Note panel' },
      ...draw.data.panelTabs.map((tab) =>
        h(
          'button',
          {
            type: 'button',
            role: 'tab',
            class: 'icon-btn note-rail-btn',
            'aria-label': tab.label,
            'aria-selected': String(panelOpen && tab.tab === 'info'),
            'data-tab': tab.tab,
            tabindex: -1,
          },
          icon(draw, tab.icon),
        ),
      ),
    ),
  );
  const body = known ? h('div', { class: 'ProseMirror' }, noteBody(note)) : placeholderLines();
  const status = draw.phone
    ? ''
    : h(
        'footer',
        { class: 'status-bar', 'aria-label': 'Note status' },
        h('span', { class: 'save-status-slot', 'data-state': 'saved' }),
        h(
          'span',
          { class: 'status-counts' },
          tally
            ? h('span', { 'data-field': 'words' }, `${tally.words.toLocaleString('en-GB')} words`) +
                h(
                  'span',
                  { 'data-field': 'characters' },
                  `${tally.characters.toLocaleString('en-GB')} characters`,
                )
            : '',
        ),
      );
  const format = draw.phone
    ? h(
        'div',
        { class: 'phone-format', role: 'toolbar', 'aria-label': 'Formatting' },
        ...PHONE_FORMAT_BUTTONS.map(({ command, icon: name }) =>
          iconButton(draw, name, displayName('command', command), {}, 20),
        ),
      )
    : '';
  return h(
    'article',
    {
      class: 'note',
      'data-ready': 'true',
      'data-width': frame.layout.fullWidth ? 'full' : undefined,
    },
    h(
      'header',
      { class: 'app-bar' },
      iconButton(draw, 'menu', 'Open Navigation'),
      h('p', { class: 'app-bar-title app-bar-path' }, h('span', {}, text(folder))),
      iconButton(draw, 'search', 'Search Notes'),
      h('div', { class: 'menu-anchor' }, iconButton(draw, 'moreV', 'Note Actions')),
    ),
    top,
    h(
      'div',
      {
        class: 'note-columns',
        'data-panel': panelOpen ? 'open' : 'closed',
        'data-tab': panelOpen ? 'info' : undefined,
        'data-pf-vars': vars({ '--pm-panel-width': '26rem' }),
      },
      h(
        'div',
        { class: 'note-scroll', 'data-pf-area': 'note' },
        h(
          'div',
          { class: 'doc' },
          known
            ? h('div', { class: 'doc-title pf-title' }, title)
            : h('div', { class: 'doc-title pf-title' }, h('span', { class: 'pf-bar' })),
          h('div', { class: 'note-body' }, body),
        ),
      ),
      side,
      rail,
    ),
    status,
    format,
  );
}

// ---------------------------------------------------------------------------------------------
// The other screens.

/** Any screen but a note or Settings: the app's empty state, titled with the screen's name. */
function emptyScreen(draw: Draw): string {
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

function settingsScreen(draw: Draw): string {
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
                class: 'privacy-nav-entry',
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
  const content = groups.map((group) =>
    [
      group.name
        ? h('div', { class: 'lf-sub' }, h('h3', { class: 'lf-sub-name' }, text(group.name)))
        : '',
      // Appearance's previews (the theme cards) as a block of their real height.
      page === 'appearance' && group.name === 'Theme'
        ? h('div', { class: 'pf-preview', 'aria-hidden': 'true' })
        : '',
      h(
        'div',
        { class: 'lf-group', role: 'group' },
        ...group.rows.map((row) =>
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
          ),
        ),
      ),
    ].join(''),
  );
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
            h('div', { class: 'lf-controls' }, ...content),
          ),
        ),
      ),
    ),
  );
}

// ---------------------------------------------------------------------------------------------
// Dialogs.

const field = (seed: string, chars: number | null, attrs: Readonly<Record<string, Attr>>) =>
  h(
    'span',
    { class: 'pf-field' },
    h('input', {
      type: 'text',
      value: chars ? loremOf(seed, chars) : '',
      tabindex: -1,
      readonly: true,
      ...attrs,
    }),
  );

const foot = (verb: string) =>
  h(
    'div',
    { class: 'dlg-foot', 'aria-hidden': 'true' },
    h('span', { class: 'keys' }, h('kbd', {}, '↑'), h('kbd', {}, '↓')),
    'Navigate',
    h('span', { class: 'keys' }, h('kbd', {}, '↵')),
    verb,
    h('span', { class: 'grow' }),
    h('span', { class: 'keys' }, h('kbd', {}, 'Esc')),
    'Close',
  );

/** A row of the picker's list. */
const option = (draw: Draw, seed: string, length: number, note: boolean, active: boolean) =>
  h(
    'div',
    {
      class: 'opt',
      role: 'option',
      'aria-selected': String(active),
      'data-kind': note ? 'note' : 'command',
    },
    h('span', { class: 'oic', 'aria-hidden': 'true' }, icon(draw, note ? 'file' : 'command', 14)),
    h('span', { class: 'ot' }, h('span', {}, text(loremName(seed, length)))),
    h('span', { class: 'os' }, note ? 'Note' : ''),
  );

function picker(draw: Draw, dialog: FrameDialog, depth: number): string {
  const label = displayName('dialog', dialog.name);
  const typed = (dialog.chars ?? 0) > 0;
  const rows = Array.from({ length: typed ? 4 : 7 }, (_, i) =>
    option(
      draw,
      `${dialog.name}:${depth}:${i}`,
      10 + ((i * 7) % 13),
      dialog.name !== 'palette' || i > 3,
      i === 0,
    ),
  );
  return h(
    'div',
    { class: 'overlay' },
    h(
      'div',
      { class: 'dialog palette', role: 'dialog', 'aria-label': label },
      h(
        'div',
        { class: 'dlg-search' },
        field(`input:${dialog.name}`, dialog.chars, { 'aria-label': label }),
        iconButton(draw, 'close', 'Close', { class: 'dlg-close' }),
      ),
      h(
        'div',
        { class: 'dlg-list', role: 'listbox' },
        ...(dialog.name === 'palette' && !typed
          ? [h('div', { class: 'grp-h', role: 'presentation' }, 'Commands')]
          : []),
        ...rows,
      ),
      foot(dialog.name === 'palette' ? 'Run' : 'Open'),
    ),
  );
}

/** Search, as SearchOverlay draws it: its filters, its status line and lorem hits. */
function searchDialog(draw: Draw, dialog: FrameDialog): string {
  const typed = (dialog.chars ?? 0) > 0;
  const hits = Array.from({ length: typed ? 4 : 5 }, (_, i) =>
    h(
      'div',
      { class: 'opt search-hit', role: 'option', 'aria-selected': String(i === 0) },
      h(
        'span',
        { class: 'search-hit-title' },
        text(loremName(`search:hit:${i}`, 12 + ((i * 5) % 11))),
      ),
      h(
        'span',
        { class: 'search-hit-meta' },
        h('span', { class: 'search-notebook' }, text(loremName('notebook', 8))),
      ),
      typed ? h('span', { class: 'search-snippet' }, text(loremOf(`search:snippet:${i}`, 70))) : '',
    ),
  );
  const select = (label: string) =>
    h(
      'div',
      { class: 'search-filter' },
      h(
        'select',
        { class: 'pm-select pm-select-sm', 'aria-label': label, tabindex: -1 },
        h('option', {}, text(label)),
      ),
    );
  return h(
    'div',
    { class: 'overlay' },
    h(
      'div',
      { class: 'dialog palette search', role: 'dialog', 'aria-label': 'Search' },
      h(
        'div',
        { class: 'dlg-search' },
        h('span', { class: 'search-icon', 'aria-hidden': 'true' }, icon(draw, 'search')),
        field('input:search', dialog.chars, { 'aria-label': 'Search notes' }),
        iconButton(draw, 'close', 'Close Search', { class: 'dlg-close' }),
      ),
      h(
        'div',
        { class: 'search-controls' },
        select('All Folders'),
        select('Any Tag'),
        select('Any Time'),
      ),
      h(
        'div',
        { class: 'search-status', role: 'status' },
        h('span', {}, typed ? 'Notes' : 'Recent Notes'),
      ),
      h(
        'div',
        { class: 'dlg-list search-results', role: 'listbox' },
        ...(typed ? [h('div', { class: 'grp-h', role: 'presentation' }, 'Notes')] : []),
        ...hits,
      ),
      foot('Open'),
    ),
  );
}

/** Confirmation: placeholder bars for its words, since they weren't recorded (dialog.confirm). */
function confirmDialog(dialog: FrameDialog): string {
  return (
    h('div', { class: 'pf-scrim', 'aria-hidden': 'true' }) +
    h(
      'dialog',
      { class: 'confirm pf-dialog', open: true },
      h(
        'form',
        { method: 'dialog' },
        h('h2', {}, h('span', { class: 'pf-bar pf-bar-title' })),
        h('p', {}, h('span', { class: 'pf-bar' }), h('span', { class: 'pf-bar pf-bar-short' })),
        dialog.chars !== null
          ? h('p', {}, field('input:confirm', dialog.chars, { class: 'input' }))
          : '',
        h(
          'div',
          { class: 'confirm-actions' },
          h(
            'button',
            { type: 'button', class: 'btn', tabindex: -1 },
            h('span', { class: 'pf-bar pf-bar-button' }),
          ),
          h(
            'button',
            { type: 'button', class: 'btn primary', tabindex: -1 },
            h('span', { class: 'pf-bar pf-bar-button' }),
          ),
        ),
      ),
    )
  );
}

/** Any other dialog: titled with its name, the shared ×, over lorem rows. */
function titledDialog(draw: Draw, dialog: FrameDialog, depth: number): string {
  const label = displayName('dialog', dialog.name);
  return h(
    'div',
    { class: 'overlay' },
    h(
      'div',
      { class: 'dialog', role: 'dialog', 'aria-label': label },
      h(
        'div',
        { class: 'dlg-title' },
        h('h2', {}, text(label)),
        iconButton(draw, 'close', 'Close', { class: 'dlg-close' }),
      ),
      dialog.chars !== null
        ? h(
            'div',
            { class: 'dlg-search' },
            field(`input:${dialog.name}`, dialog.chars, { 'aria-label': label }),
          )
        : '',
      h(
        'div',
        { class: 'dlg-list' },
        ...Array.from({ length: 5 }, (_, i) =>
          h(
            'div',
            { class: 'opt' },
            h(
              'span',
              { class: 'ot' },
              h(
                'span',
                {},
                text(loremName(`${dialog.name}:${depth}:row:${i}`, 14 + ((i * 9) % 17))),
              ),
            ),
          ),
        ),
      ),
    ),
  );
}

export function dialogMarkup(draw: Draw, dialog: FrameDialog, depth: number): string {
  if (dialog.name === 'search') return searchDialog(draw, dialog);
  if (PICKERS.has(dialog.name)) return picker(draw, dialog, depth);
  if (dialog.name === 'confirm') return confirmDialog(dialog);
  return titledDialog(draw, dialog, depth);
}

// ---------------------------------------------------------------------------------------------
// The whole window.

/** The frame's markup: the window as the app drew it at that moment. */
export function frameMarkup(frame: Frame, data: FrameData): string {
  const draw: Draw = {
    frame,
    data,
    phone: frame.window.width <= NARROW_PX,
    mac: frame.client === 'mac',
  };
  const dialogs = frame.dialogs
    .map((dialog, i) =>
      h('div', { class: 'pf-layer', 'data-dialog': dialog.name }, dialogMarkup(draw, dialog, i)),
    )
    .join('');
  if (frame.screen?.startsWith('settings')) return settingsScreen(draw) + dialogs;
  const onNote = isNoteScreen(frame.screen);
  const rail = frame.layout.sidebar === 'rail' && !draw.phone;
  const strip = draw.mac && !draw.phone;
  const navInTitleBar = rail && (onNote || strip);
  const drawerOpen = draw.phone && frame.layout.sidebar === 'shown';
  const hidden = !draw.phone && frame.layout.sidebar === 'hidden';
  const screen = onNote ? noteScreen(draw, navInTitleBar, strip) : emptyScreen(draw);
  return (
    h(
      'div',
      {
        class: hidden ? 'notes-app pf-no-sidebar' : 'notes-app',
        'data-drawer': drawerOpen ? 'open' : undefined,
        'data-sidebar': rail ? 'collapsed' : undefined,
        'data-pf-vars': vars({
          '--pm-sidebar-width': `${(frame.layout.sidebarWidth ?? 272) / 16}rem`,
        }),
      },
      sidebar(draw, navInTitleBar),
      drawerOpen ? h('div', { class: 'drawer-scrim', 'aria-hidden': 'true' }) : '',
      h(
        'main',
        { class: 'note-main' },
        strip ? tabStrip(draw, navInTitleBar) : '',
        h('div', { class: 'tab-panel', id: 'tab-panel' }, screen),
      ),
    ) + dialogs
  );
}

/** The theme a frame is drawn in: the recorded built-in one, or Penmoss. */
export function themeOf(frame: Frame) {
  return BUILT_IN_THEMES.find((theme) => theme.id === frame.theme) ?? PENMOSS;
}

/** Each scrolled area's element in the drawn frame. */
const AREAS: Readonly<Record<string, string>> = {
  note: '[data-pf-area="note"]',
  sidebar: '.sb-list',
  'sidebar.folders': '.sb-part[data-section="notebooks"] .sb-section-body',
  'sidebar.recent': '.sb-recent .sb-quick-list',
  'sidebar.tags': '.tag-pane',
  settings: '[data-pf-area="settings"]',
  'settings.nav': '[data-pf-area="settings.nav"]',
};

let drawn = '';

/** Draws `message`'s frame into `doc`: its theme, its markup, its custom properties, its scroll. */
export function drawFrame(doc: Document, message: FrameMessage, data: FrameData): void {
  const { frame, variant } = message;
  applyThemeTo(doc.documentElement, themeOf(frame), variant);
  const markup = frameMarkup(frame, data);
  const root = doc.getElementById('root') ?? doc.body;
  if (markup !== drawn || root.dataset['pfDrawn'] !== '1') {
    root.innerHTML = markup;
    root.dataset['pfDrawn'] = '1';
    drawn = markup;
    for (const element of root.querySelectorAll<HTMLElement>('[data-pf-vars]')) {
      for (const pair of (element.dataset['pfVars'] ?? '').split(';')) {
        const at = pair.indexOf(':');
        if (at > 0) element.style.setProperty(pair.slice(0, at), pair.slice(at + 1));
      }
    }
  }
  const narrow = frame.window.width <= NARROW_PX;
  for (const [area, selector] of Object.entries(AREAS)) {
    // On a narrow window Settings scrolls the window's own page (SettingsPage, PEN-175).
    const element =
      area === 'settings' && narrow
        ? (doc.scrollingElement as HTMLElement | null)
        : root.querySelector<HTMLElement>(selector);
    if (!element) continue;
    const position = frame.scroll[area] ?? 0;
    element.scrollTop = position * Math.max(0, element.scrollHeight - element.clientHeight);
  }
}
