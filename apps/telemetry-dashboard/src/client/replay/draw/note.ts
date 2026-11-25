/** The replay frame's note (PEN-178): NoteView, its blocks drawn as lorem of recorded lengths. */
import { PHONE_FORMAT_BUTTONS } from '@penmoss/web/src/notes/phone-format-buttons';
import { displayName, fullNumber } from '../../names';
import { loremOf } from '../lorem';
import type { FrameNote } from '../state';
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
  noteTitle,
} from './markup';
import { noteBar } from './bars';

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

export function noteScreen(draw: Draw, navInTitleBar: boolean, strip: boolean): string {
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
            ? h('span', { 'data-field': 'words' }, `${fullNumber(tally.words)} words`) +
                h(
                  'span',
                  { 'data-field': 'characters' },
                  `${fullNumber(tally.characters)} characters`,
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
