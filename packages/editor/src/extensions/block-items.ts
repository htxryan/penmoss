/**
 * The blocks a note can insert (T14): the slash menu's catalogue, its filter,
 * and the commands behind it and the selection toolbar's "Turn into" menu.
 * Every insert is one TipTap chain, so one transaction and one undo step.
 */
import type { ChainedCommands, Editor, Range } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { NodeSelection, TextSelection, type Transaction } from '@tiptap/pm/state';
import { insertFiles, type FileServices } from './attachment';
import { CALLOUT_TYPES } from './callout';
import { IMAGE_TYPES, insertImageFiles, type ImageServices } from './image';
import { drawingServicesOf, insertDrawing } from './drawing';
import { canHaveSymbols, openSymbolPicker } from './line-symbols';
import { editFormulaAt } from './math';
import { tableFromHeaders } from './table';
import type { LinkServices } from './wikilink';

export interface BlockContext {
  readonly editor: Editor;
  /** The typed `/query` to remove; empty for the toolbar. */
  readonly range: Range;
  readonly images?: ImageServices | undefined;
  readonly links?: LinkServices | undefined;
  readonly files?: FileServices | undefined;
  /** Lift the selected blocks out of lists, quotes and callouts first ("Turn into"). */
  readonly lift?: boolean;
}

export interface BlockItem {
  readonly id: string;
  readonly label: string;
  /** Extra words the filter matches. */
  readonly keywords: readonly string[];
  /** A short glyph shown before the label. */
  readonly icon: string;
  /** The markdown shortcut that makes the same block, shown as a hint. */
  readonly hint?: string;
  /** Listed only when the query matches it (one entry per callout type). */
  readonly searchOnly?: boolean;
  /** Inline content, so it can go into a table cell. */
  readonly inline?: boolean;
  /** Needs image storage (the slash menu hides it without). */
  readonly needsImages?: boolean;
  /** Needs the note registry (the slash menu hides it without). */
  readonly needsLinks?: boolean;
  /** Needs file storage (T13; the slash menu hides it without). */
  readonly needsFiles?: boolean;
  /** Needs the drawing editor (PEN-28; the slash menu hides it without). */
  readonly needsDrawings?: boolean;
  /** Offered by the selection toolbar's "Turn into" menu. */
  readonly turnInto?: boolean;
  /** Whether the selection's block is already this kind (for "Turn into"). */
  readonly isActive?: (editor: Editor) => boolean;
  /** Inserts the block in place of the typed query; false when it cannot go here. */
  readonly insert: (context: BlockContext) => boolean;
}

/**
 * The chain every insert starts from: the editor focused, and the typed
 * `/query` dropped. Focus is taken now rather than with TipTap's `focus()`,
 * which refocuses a frame later and would pull focus back out of a field the
 * insert opens (a formula's LaTeX, a toggle's title).
 */
const start = ({ editor, range, lift }: BlockContext): ChainedCommands => {
  if (!editor.view.hasFocus()) editor.view.focus();
  const chain = editor.chain();
  if (lift) chain.clearNodes();
  return range.to > range.from ? chain.deleteRange(range) : chain;
};

/**
 * Puts `node` where the caret's empty paragraph is, or after the caret's
 * block when that has text, and selects it (`select`) or the first text
 * position inside it.
 */
function placeBlock(tr: Transaction, node: PMNode, select: 'node' | 'inside'): number {
  const { $from } = tr.selection;
  const textblock = $from.parent;
  let pos: number;
  if (textblock.type.name === 'paragraph' && textblock.content.size === 0 && $from.depth > 0) {
    pos = $from.before();
    tr.replaceWith(pos, $from.after(), node);
  } else {
    pos = $from.depth > 0 ? $from.after() : $from.pos;
    tr.insert(pos, node);
  }
  tr.setSelection(
    select === 'node'
      ? NodeSelection.create(tr.doc, pos)
      : TextSelection.near(tr.doc.resolve(pos + 1)),
  );
  tr.scrollIntoView();
  return pos;
}

const heading = (level: 1 | 2 | 3, keywords: string[]): BlockItem => ({
  id: `heading${level}`,
  label: `Heading ${level}`,
  keywords: [`h${level}`, ...keywords],
  icon: `H${level}`,
  hint: `${'#'.repeat(level)} `,
  turnInto: true,
  isActive: (editor) => editor.isActive('heading', { level }),
  insert: (context) => start(context).setNode('heading', { level }).run(),
});

/** A list kind: applied to the caret's block, or left alone when it already is one. */
const list = (
  id: string,
  type: 'bulletList' | 'orderedList' | 'taskList',
  toggle: (chain: ChainedCommands) => ChainedCommands,
  rest: Pick<BlockItem, 'label' | 'keywords' | 'icon' | 'hint'>,
): BlockItem => ({
  id,
  ...rest,
  turnInto: true,
  isActive: (editor) => editor.isActive(type),
  insert: (context) => {
    const chain = start(context);
    return (context.editor.isActive(type) ? chain : toggle(chain)).run();
  },
});

const callout = (type: string, searchOnly: boolean): BlockItem => {
  const name = type.charAt(0).toUpperCase() + type.slice(1);
  return {
    id: searchOnly ? `callout-${type}` : 'callout',
    label: searchOnly ? `${name} Callout` : 'Callout',
    keywords: searchOnly ? ['callout', 'admonition'] : ['admonition', 'note', 'info', 'aside'],
    icon: '!',
    hint: `> [!${type}] `,
    searchOnly,
    turnInto: !searchOnly,
    isActive: (editor) => editor.isActive('callout', { foldable: false }),
    insert: (context) =>
      start(context)
        .wrapIn('callout', { type, title: '', foldable: false, collapsed: false })
        .run(),
  };
};

/** Focuses the title field of the toggle holding the selection, so its summary is typed first. */
function focusToggleTitle(editor: Editor) {
  const { $from } = editor.state.selection;
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    if ($from.node(depth).type.name !== 'callout') continue;
    const dom = editor.view.nodeDOM($from.before(depth));
    if (dom instanceof HTMLElement)
      dom.querySelector<HTMLInputElement>('.pm-callout-title')?.focus();
    return;
  }
}

/** How long after the window gets focus back a picker that sent no `change` counts as closed. */
const PICKER_SETTLE_MS = 1000;

/**
 * Opens the browser's file picker (`accept`: image types, or anything), then
 * hands what was chosen to `insert` with the place the item was picked. The
 * point is mapped through every edit made while the picker is open, and the
 * insert maps it through those made during the upload, so a selection the
 * user makes meanwhile is never replaced.
 */
function pickFiles(
  editor: Editor,
  at: number,
  accept: string | null,
  insert: (files: File[], at: number) => void,
) {
  const doc = editor.view.dom.ownerDocument;
  const win = doc.defaultView;
  const input = doc.createElement('input');
  input.type = 'file';
  if (accept) input.accept = accept;
  input.multiple = true;
  input.hidden = true;
  let point = at;
  let settle: ReturnType<typeof setTimeout> | null = null;
  const follow = ({ transaction }: { transaction: Transaction }) => {
    point = transaction.mapping.map(point);
  };
  const done = () => {
    if (settle !== null) clearTimeout(settle);
    win?.removeEventListener('focus', onFocus);
    editor.off('transaction', follow);
    editor.off('destroy', done);
    input.remove();
  };
  // Not every browser sends `cancel`: once the window has focus again, the dialog is gone.
  const onFocus = () => {
    settle ??= setTimeout(done, PICKER_SETTLE_MS);
  };
  input.addEventListener('change', () => {
    const files = [...(input.files ?? [])];
    const target = point;
    done();
    if (files.length && !editor.isDestroyed) insert(files, target);
  });
  input.addEventListener('cancel', done);
  editor.on('transaction', follow);
  editor.on('destroy', done);
  win?.addEventListener('focus', onFocus);
  doc.body.append(input);
  input.click();
}

function pickImages(editor: Editor, services: ImageServices, at: number) {
  pickFiles(editor, at, IMAGE_TYPES, (files, target) => {
    void insertImageFiles(editor.view, services, files, target);
  });
}

/** Every block, in the menu's order. */
export const BLOCK_ITEMS: readonly BlockItem[] = [
  {
    id: 'paragraph',
    label: 'Text',
    keywords: ['paragraph', 'plain'],
    icon: 'T',
    turnInto: true,
    isActive: (editor) =>
      editor.isActive('paragraph') &&
      !['bulletList', 'orderedList', 'taskList', 'blockquote', 'callout'].some((name) =>
        editor.isActive(name),
      ),
    insert: (context) => start(context).setParagraph().run(),
  },
  heading(1, ['title', 'big']),
  heading(2, ['section']),
  heading(3, ['subsection']),
  list('bulletList', 'bulletList', (chain) => chain.toggleBulletList(), {
    label: 'Bulleted List',
    keywords: ['bullet', 'unordered', 'ul'],
    icon: '•',
    hint: '- ',
  }),
  list('orderedList', 'orderedList', (chain) => chain.toggleOrderedList(), {
    label: 'Numbered List',
    keywords: ['ordered', 'number', 'ol'],
    icon: '1.',
    hint: '1. ',
  }),
  list('taskList', 'taskList', (chain) => chain.toggleTaskList(), {
    label: 'Checklist',
    keywords: ['todo', 'task', 'checkbox'],
    icon: '☐',
    hint: '- [ ] ',
  }),
  {
    id: 'blockquote',
    label: 'Quote',
    keywords: ['blockquote', 'citation'],
    icon: '❝',
    hint: '> ',
    turnInto: true,
    isActive: (editor) => editor.isActive('blockquote'),
    insert: (context) => start(context).setBlockquote().run(),
  },
  {
    id: 'horizontalRule',
    label: 'Divider',
    keywords: ['rule', 'hr', 'line', 'separator'],
    icon: '—',
    hint: '---',
    insert: (context) => start(context).setHorizontalRule().run(),
  },
  {
    id: 'codeBlock',
    label: 'Code Block',
    keywords: ['snippet', 'fence', 'pre'],
    icon: '{}',
    hint: '```',
    turnInto: true,
    isActive: (editor) =>
      editor.isActive('codeBlock') && !editor.isActive('codeBlock', { language: 'mermaid' }),
    insert: (context) => start(context).setNode('codeBlock', { language: null }).run(),
  },
  {
    id: 'table',
    label: 'Table',
    keywords: ['grid', 'columns', 'rows'],
    icon: '▦',
    hint: '| a | b |',
    insert: (context) =>
      start(context)
        .command(({ tr, state }) => {
          const table = tableFromHeaders(state.schema, ['', '']);
          placeBlock(tr, table, 'inside');
          return true;
        })
        .run(),
  },
  callout('note', false),
  ...CALLOUT_TYPES.map((type) => callout(type, true)),
  {
    id: 'toggle',
    label: 'Toggle',
    keywords: ['collapse', 'fold', 'details', 'expand'],
    icon: '▸',
    hint: '> [!note]- ',
    turnInto: true,
    isActive: (editor) => editor.isActive('callout', { foldable: true }),
    insert: (context) => {
      const ok = start(context)
        .wrapIn('callout', { type: 'note', title: '', foldable: true, collapsed: true })
        .run();
      if (ok) focusToggleTitle(context.editor);
      return ok;
    },
  },
  {
    id: 'mermaid',
    label: 'Mermaid Diagram',
    keywords: ['diagram', 'flowchart', 'chart', 'graph', 'sequence'],
    icon: '⧉',
    hint: '```mermaid',
    insert: (context) => start(context).setNode('codeBlock', { language: 'mermaid' }).run(),
  },
  {
    id: 'blockMath',
    label: 'Math Block',
    keywords: ['equation', 'formula', 'latex', 'katex', 'display'],
    icon: '∑',
    hint: '$$',
    insert: (context) =>
      start(context)
        .command(({ tr, state }) => {
          // An empty, selected formula opens its LaTeX field (MathView).
          placeBlock(tr, state.schema.nodes['blockMath']!.create({ latex: '' }), 'node');
          return true;
        })
        .run(),
  },
  {
    id: 'inlineMath',
    label: 'Inline Math',
    keywords: ['equation', 'formula', 'latex', 'katex'],
    icon: '√',
    hint: '$x$',
    inline: true,
    insert: (context) => {
      let at = -1;
      const ok = start(context)
        .command(({ tr, state }) => {
          at = tr.selection.from;
          tr.replaceSelectionWith(state.schema.nodes['inlineMath']!.create({ latex: '' }), false);
          tr.setSelection(NodeSelection.create(tr.doc, at));
          return true;
        })
        .run();
      if (ok && at >= 0) editFormulaAt(context.editor.view, at);
      return ok;
    },
  },
  {
    id: 'wikilink',
    label: 'Link to Note',
    keywords: ['wikilink', 'reference', 'backlink', 'note', '[['],
    icon: '↗',
    hint: '[[',
    inline: true,
    needsLinks: true,
    // Types `[[`, which opens note completion where the item was picked.
    insert: (context) => start(context).insertContent('[[').run(),
  },
  {
    id: 'embed',
    label: 'Embed Note',
    keywords: ['transclude', 'include', 'section', 'note', '![['],
    icon: '⧉',
    hint: '![[',
    needsLinks: true,
    // Types `![[`, which opens note completion for an embed where the item was picked.
    insert: (context) => start(context).insertContent('![[').run(),
  },
  {
    id: 'image',
    label: 'Image',
    keywords: ['picture', 'photo', 'upload', 'screenshot'],
    icon: '▣',
    inline: true,
    needsImages: true,
    insert: (context) => {
      if (!context.images) return false;
      const ok = start(context).run();
      // The image goes where the menu was, wherever the selection is when it arrives.
      if (ok) pickImages(context.editor, context.images, context.editor.state.selection.from);
      return ok;
    },
  },
  {
    id: 'file',
    label: 'File',
    keywords: ['attachment', 'attach', 'pdf', 'document', 'upload'],
    icon: '⎘',
    inline: true,
    needsFiles: true,
    insert: (context) => {
      const files = context.files;
      if (!files) return false;
      const ok = start(context).run();
      const { editor } = context;
      if (ok) {
        pickFiles(editor, editor.state.selection.from, null, (chosen, target) => {
          void insertFiles(editor.view, files, chosen, target);
        });
      }
      return ok;
    },
  },
  {
    // PEN-28: a new drawing, in the drawing editor at once; it goes in the note on Done.
    id: 'drawing',
    label: 'Drawing',
    keywords: ['excalidraw', 'sketch', 'whiteboard', 'diagram', 'draw', 'canvas'],
    icon: '✎',
    needsDrawings: true,
    insert: (context) => {
      const { editor } = context;
      if (!drawingServicesOf(editor)) return false;
      const ok = start(context).run();
      if (ok) void insertDrawing(editor, editor.state.selection.from);
      return ok;
    },
  },
  {
    // T44 (A746): the symbol picker for this line; the symbols are text at its start.
    id: 'symbol',
    label: 'Symbol',
    keywords: ['signifier', 'important', 'question', 'follow-up', 'idea', 'next', 'star', 'mark'],
    icon: '★',
    // Offered in a table cell too: a cell's symbols are its text's leading glyphs (T52 item 2).
    inline: true,
    insert: (context) => {
      if (!canHaveSymbols(context.editor.state)) return false;
      const ok = start(context).run();
      return ok && openSymbolPicker(context.editor);
    },
  },
];

/**
 * Items whose words match `query`, best first. Each word of the query must
 * start a word of the item's label or keywords, or (from three letters)
 * appear inside its label; ties
 * keep the catalogue's order. Without a query, every item that is not
 * search-only, in order.
 */
export function filterBlockItems(items: readonly BlockItem[], query: string): readonly BlockItem[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return items.filter((item) => !item.searchOnly);
  const scored: { item: BlockItem; score: number; index: number }[] = [];
  items.forEach((item, index) => {
    const label = item.label.toLowerCase();
    const labelWords = label.split(/\s+/);
    const keywords = item.keywords.map((keyword) => keyword.toLowerCase());
    let score = 0;
    for (const word of words) {
      if (labelWords[0]!.startsWith(word)) score += 0;
      else if (labelWords.some((part) => part.startsWith(word))) score += 1;
      else if (keywords.some((keyword) => keyword.startsWith(word))) score += 2;
      else if (word.length >= 3 && label.replaceAll(' ', '').includes(word)) score += 3;
      else return;
    }
    // Search-only entries (callout types) rank after the general ones they refine.
    if (item.searchOnly) score += 0.5;
    scored.push({ item, score, index });
  });
  scored.sort((a, b) => a.score - b.score || a.index - b.index);
  return scored.map((entry) => entry.item);
}

/** Whether the caret is where only inline content goes (a table cell). */
export function inlineOnly(editor: Editor): boolean {
  const { $from } = editor.state.selection;
  const role = $from.parent.type.spec.tableRole as string | undefined;
  return role === 'cell' || role === 'header_cell';
}

/**
 * Whether "Turn into" may act on the selection: not when it touches a table.
 * Cells hold inline content, and the block commands would rewrite the cells
 * themselves (`setNodeMarkup` turns body cells into header cells and drops
 * their alignment and widths).
 */
export function canTurnInto(editor: Editor): boolean {
  const { selection, doc } = editor.state;
  let table = false;
  doc.nodesBetween(selection.from, selection.to, (node) => {
    if (node.type.spec.tableRole) table = true;
    return !table;
  });
  // A caret or selection inside one cell has the cell (and the table) as ancestors.
  const { $from, $to } = selection;
  for (const $pos of [$from, $to]) {
    for (let depth = $pos.depth; depth > 0; depth -= 1) {
      if ($pos.node(depth).type.spec.tableRole) table = true;
    }
  }
  return !table;
}

/** The items to offer for the caret's position and the editor's services. */
export function availableBlockItems(
  editor: Editor,
  images?: ImageServices,
  links?: LinkServices,
  files?: FileServices,
): readonly BlockItem[] {
  const cell = inlineOnly(editor);
  const embeds = links !== undefined && editor.schema.nodes['embed'] !== undefined;
  return BLOCK_ITEMS.filter(
    (item) =>
      (!item.needsImages || images !== undefined) &&
      (!item.needsLinks || links !== undefined) &&
      (!item.needsFiles || files !== undefined) &&
      (!item.needsDrawings || drawingServicesOf(editor) !== undefined) &&
      (item.id !== 'embed' || embeds) &&
      (!cell || item.inline),
  );
}

/** Items for the selection toolbar's "Turn into" menu. */
export const TURN_INTO_ITEMS: readonly BlockItem[] = BLOCK_ITEMS.filter((item) => item.turnInto);

/**
 * Turns the selected blocks into `item`: as is when the block allows it, or
 * after lifting them out of lists, quotes and callouts (a list item cannot
 * start with a heading). "Text" always lifts them out.
 */
export function turnInto(editor: Editor, item: BlockItem): boolean {
  if (!canTurnInto(editor)) return false;
  const lift = item.id === 'paragraph' || !canInsertDirectly(editor.can().chain(), item);
  return item.insert({ editor, range: { from: 0, to: 0 }, lift });
}

function canInsertDirectly(chain: ChainedCommands, item: BlockItem): boolean {
  switch (item.id) {
    case 'heading1':
    case 'heading2':
    case 'heading3':
      return chain.setNode('heading', { level: Number(item.id.slice(-1)) }).run();
    case 'codeBlock':
      return chain.setNode('codeBlock', { language: null }).run();
    default:
      return true;
  }
}
