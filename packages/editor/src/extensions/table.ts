/**
 * GFM tables (T11): TipTap's table nodes with core's model (inline-only
 * cells, A9), a row and column toolbar, Tab/Shift-Tab between cells
 * (TipTap's keymap: Tab in the last cell adds a row), a `| a | b |` + Enter
 * shortcut, and one header row, as GFM requires.
 */
import { Extension, InputRule, type Editor } from '@tiptap/core';
import { Table, TableRow } from '@tiptap/extension-table';
import type { Node as PMNode, Schema } from '@tiptap/pm/model';
import {
  Plugin,
  PluginKey,
  Selection,
  TextSelection,
  type Command,
  type EditorState,
  type Transaction,
} from '@tiptap/pm/state';
import { TableMap } from '@tiptap/pm/tables';
import { Decoration, DecorationSet, type NodeView, type ViewMutationRecord } from '@tiptap/pm/view';
import { changedNodes } from './changes';

/** `| Name | Status |` on its own line, then Enter. */
const TABLE_ROW = /^\s*\|((?:[^|\n]*\|)+)\s*\n$/;

/** The cells of a typed `| a | b |` row (escaped pipes are not split). */
export function splitRow(cells: string): string[] {
  return cells
    .split(/(?<!\\)\|/)
    .slice(0, -1)
    .map((cell) => cell.trim().replaceAll('\\|', '|'));
}

/** A table with `headers` as its header row and one empty body row. */
export function tableFromHeaders(schema: Schema, headers: readonly string[]): PMNode {
  const { table, tableRow, tableHeader, tableCell } = schema.nodes;
  const header = headers.map((text) => tableHeader!.create(null, text ? schema.text(text) : null));
  const body = headers.map(() => tableCell!.create());
  return table!.create(null, [tableRow!.create(null, header), tableRow!.create(null, body)]);
}

interface TableAction {
  readonly label: string;
  /** The icon's path data, on the app's 24-unit line grid (T39 pass 3, A906). */
  readonly icon: string;
  readonly run: (editor: Editor) => boolean;
}

// A row is a wide box and a column a tall one; + adds on the side it names, × deletes it.
const ROW_ABOVE = 'M4.5 11.5h15v7h-15zM12 3.5v5M9.5 6h5';
const ROW_BELOW = 'M4.5 5.5h15v7h-15zM12 15.5v5M9.5 18h5';
const ROW_DELETE = 'M3.5 8.5h17v7h-17zM10 10l4 4M14 10l-4 4';
const COLUMN_LEFT = 'M11.5 4.5h7v15h-7zM6 9.5v5M3.5 12h5';
const COLUMN_RIGHT = 'M5.5 4.5h7v15h-7zM18 9.5v5M15.5 12h5';
const COLUMN_DELETE = 'M8.5 3.5h7v17h-7zM10 10l4 4M14 10l-4 4';
// The app's Trash icon (packages/ui Icon `trash`).
const TABLE_DELETE =
  'M5 7h14M10 4h4M7 7l.8 12a1.5 1.5 0 0 0 1.5 1.4h5.4a1.5 1.5 0 0 0 1.5-1.4L17 7';

const ACTIONS: readonly (TableAction | 'separator')[] = [
  {
    label: 'Add Row Above',
    icon: ROW_ABOVE,
    run: (editor) => editor.chain().focus().addRowBefore().run(),
  },
  {
    label: 'Add Row Below',
    icon: ROW_BELOW,
    run: (editor) => editor.chain().focus().addRowAfter().run(),
  },
  {
    label: 'Delete Row',
    icon: ROW_DELETE,
    run: (editor) => editor.chain().focus().deleteRow().run(),
  },
  'separator',
  {
    label: 'Add Column Left',
    icon: COLUMN_LEFT,
    run: (editor) => editor.chain().focus().addColumnBefore().run(),
  },
  {
    label: 'Add Column Right',
    icon: COLUMN_RIGHT,
    run: (editor) => editor.chain().focus().addColumnAfter().run(),
  },
  {
    label: 'Delete Column',
    icon: COLUMN_DELETE,
    run: (editor) => editor.chain().focus().deleteColumn().run(),
  },
  'separator',
  {
    label: 'Delete Table',
    icon: TABLE_DELETE,
    run: (editor) => editor.chain().focus().deleteTable().run(),
  },
];

const SVG = 'http://www.w3.org/2000/svg';

/** A line icon drawn as the app's are (`packages/ui` Icon): decorative, its button is named. */
function tableIcon(path: string): SVGSVGElement {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('class', 'i');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '18');
  svg.setAttribute('height', '18');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.5');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const shape = document.createElementNS(SVG, 'path');
  shape.setAttribute('d', path);
  svg.append(shape);
  return svg;
}

/**
 * The table's DOM: a toolbar (shown while the selection is in the table) and
 * a scrolling `<table>`. The buttons act on the cell holding the selection.
 */
export class TableView implements NodeView {
  readonly dom: HTMLElement;
  readonly contentDOM: HTMLElement;
  private node: PMNode;

  constructor(node: PMNode, editor: Editor) {
    this.node = node;
    this.dom = document.createElement('div');
    this.dom.className = 'pm-table';

    const toolbar = document.createElement('div');
    toolbar.className = 'pm-table-toolbar';
    toolbar.contentEditable = 'false';
    toolbar.setAttribute('role', 'toolbar');
    toolbar.setAttribute('aria-label', 'Table');
    for (const action of ACTIONS) {
      if (action === 'separator') {
        const separator = document.createElement('span');
        separator.className = 'pm-table-separator';
        separator.setAttribute('role', 'separator');
        toolbar.append(separator);
        continue;
      }
      const button = document.createElement('button');
      button.type = 'button';
      // An icon with its name as the label and the tooltip (T39 pass 3, A906): seven words
      // were wider than a phone and wrapped.
      button.append(tableIcon(action.icon));
      button.setAttribute('aria-label', action.label);
      button.dataset.tip = action.label;
      // Keep the editor's selection (the current cell) while clicking.
      button.addEventListener('mousedown', (event) => event.preventDefault());
      button.addEventListener('click', () => action.run(editor));
      toolbar.append(button);
    }

    const scroll = document.createElement('div');
    scroll.className = 'pm-table-scroll';
    const table = document.createElement('table');
    this.contentDOM = document.createElement('tbody');
    table.append(this.contentDOM);
    scroll.append(table);
    this.dom.append(toolbar, scroll);
  }

  update(node: PMNode): boolean {
    if (node.type !== this.node.type) return false;
    this.node = node;
    return true;
  }

  stopEvent(event: Event): boolean {
    const target = event.target;
    return target instanceof Node && !this.contentDOM.contains(target) && this.dom.contains(target);
  }

  ignoreMutation(mutation: ViewMutationRecord): boolean {
    if (mutation.type === 'selection') return false;
    return !this.contentDOM.contains(mutation.target);
  }
}

/** The table holding the selection, if any. */
function selectedTable(state: EditorState): { pos: number; node: PMNode } | null {
  const { $from } = state.selection;
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    const node = $from.node(depth);
    if (node.type.name === 'table') return { pos: $from.before(depth), node };
  }
  return null;
}

/**
 * GFM tables have exactly one header row: the first. Adding a row above the
 * header, or deleting it, would otherwise leave header cells in the body or
 * none at the top. Local edits only; the collab guard skips binding renders.
 */
function headerRowFixes(
  transactions: readonly Transaction[],
  state: EditorState,
): Transaction | null {
  if (!transactions.some((tr) => tr.docChanged)) return null;
  const { tableHeader, tableCell } = state.schema.nodes;
  if (!tableHeader || !tableCell) return null;
  const tr = state.tr;
  const tables = changedNodes(state.doc, transactions, (node) => node.type.name === 'table');
  for (const [pos, table] of tables) {
    table.forEach((row, rowOffset, rowIndex) => {
      const wanted = rowIndex === 0 ? tableHeader : tableCell;
      row.forEach((cell, cellOffset) => {
        if (cell.type !== wanted) {
          tr.setNodeMarkup(pos + 1 + rowOffset + 1 + cellOffset, wanted, cell.attrs);
        }
      });
    });
  }
  return tr.docChanged ? tr : null;
}

const isCell = (node: PMNode) => {
  const role = node.type.spec.tableRole as string | undefined;
  return role === 'cell' || role === 'header_cell';
};

/**
 * ArrowUp/ArrowDown from the first or last line of a cell: to the cell above
 * or below, or out of the table. prosemirror-tables does this only for cells
 * holding paragraphs; GFM cells hold inline content directly (core schema),
 * and the browser's own vertical movement can land the caret between cells.
 */
export function moveVertically(dir: 1 | -1): Command {
  return (state, dispatch, view) => {
    const { selection } = state;
    if (!(selection instanceof TextSelection) || !selection.empty) return false;
    const { $head } = selection;
    if (!isCell($head.parent) || $head.depth < 3) return false;
    if (view && !view.endOfTextblock(dir > 0 ? 'down' : 'up')) return false;
    const table = $head.node(-2);
    const tableStart = $head.start(-2);
    const map = TableMap.get(table);
    const rect = map.findCell($head.before() - tableStart);
    const row = dir > 0 ? rect.bottom : rect.top - 1;
    const tr = state.tr;
    if (row >= 0 && row < map.height) {
      const target = tableStart + map.map[row * map.width + rect.left]!;
      const cell = tr.doc.nodeAt(target)!;
      tr.setSelection(
        TextSelection.create(tr.doc, dir > 0 ? target + 1 : target + cell.nodeSize - 1),
      );
    } else {
      const edge = dir > 0 ? $head.after(-2) : $head.before(-2);
      const next = Selection.findFrom(tr.doc.resolve(edge), dir, true);
      if (next) {
        tr.setSelection(next);
      } else {
        // Nothing to move to: open a paragraph there, as leaving a code block does.
        tr.insert(edge, state.schema.nodes['paragraph']!.create());
        tr.setSelection(TextSelection.create(tr.doc, edge + 1));
      }
    }
    dispatch?.(tr.scrollIntoView());
    return true;
  };
}

const activeTableKey = new PluginKey('penmossActiveTable');

/** Marks the table holding the selection, which shows its toolbar. */
const activeTable = new Plugin({
  key: activeTableKey,
  props: {
    decorations(state) {
      const table = selectedTable(state);
      if (!table) return DecorationSet.empty;
      return DecorationSet.create(state.doc, [
        Decoration.node(table.pos, table.pos + table.node.nodeSize, {
          class: 'pm-table-active',
        }),
      ]);
    },
  },
});

/**
 * GFM cells hold inline content, so each cell is a textblock, and the gap
 * cursor would treat the space between two cells as a place to type (a new
 * cell). Rows never take a gap cursor.
 */
export const PenmossTableRow = TableRow.extend({ allowGapCursor: false });

/** TipTap's table with Penmoss's view and header rule (cells come from core: inline only). */
export const PenmossTable = Table.extend({
  addNodeView() {
    return ({ node, editor }) => new TableView(node, editor);
  },
});

/** The `| a | b |` + Enter shortcut, vertical arrows, the toolbar highlight and the header-row rule. */
export const TableShortcuts = Extension.create({
  name: 'tableShortcuts',

  addKeyboardShortcuts() {
    const run = (dir: 1 | -1) => () =>
      moveVertically(dir)(this.editor.state, this.editor.view.dispatch, this.editor.view);
    return { ArrowDown: run(1), ArrowUp: run(-1) };
  },

  addInputRules() {
    return [
      new InputRule({
        find: TABLE_ROW,
        handler: ({ state, match }) => {
          const { $from } = state.selection;
          if ($from.parent.type.name !== 'paragraph' || !match[1]) return null;
          const headers = splitRow(match[1]);
          if (headers.length === 0 || selectedTable(state)) return null;
          const table = tableFromHeaders(state.schema, headers);
          const start = $from.before();
          state.tr.replaceWith(start, $from.after(), table);
          // The first body cell: past the table, the header row, and the first cell's open tag.
          const headerRow = table.firstChild!;
          const firstBodyCell = start + 1 + headerRow.nodeSize + 1 + 1;
          state.tr.setSelection(TextSelection.create(state.tr.doc, firstBodyCell));
          return undefined;
        },
      }),
    ];
  },

  addProseMirrorPlugins() {
    return [
      activeTable,
      new Plugin({
        key: new PluginKey('penmossTableHeaderRow'),
        appendTransaction: (transactions, _old, state) => headerRowFixes(transactions, state),
      }),
    ];
  },
});
