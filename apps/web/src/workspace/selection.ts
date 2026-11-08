/**
 * Selecting notes in the sidebar tree for its context menu (T42, #104 item 1, A570).
 *
 * Shift-click selects the notes between the last one chosen and this one (folders in between
 * are skipped); the toggle modifier adds or removes one: ⌘ on a Mac, where Ctrl-click is a
 * right-click, and Ctrl elsewhere. A plain click opens a note and leaves one selected. Right-
 * clicking a selected note acts on the whole selection; any other row, on that row alone.
 */
import type { Row } from './model';

/** The modifier that adds a note to the selection or takes it out. */
export function isToggleClick(
  event: Pick<MouseEvent, 'metaKey' | 'ctrlKey'>,
  apple: boolean,
): boolean {
  return apple ? event.metaKey : event.ctrlKey;
}

/** The notes from `fromId` to `toId` in the tree's visible order, inclusive (either way round). */
export function noteRange(rows: readonly Row[], fromId: string | null, toId: string): string[] {
  const notes = rows.filter((row) => row.kind === 'note');
  const to = notes.findIndex((row) => row.id === toId);
  if (to < 0) return [];
  const from = fromId === null ? -1 : notes.findIndex((row) => row.id === fromId);
  if (from < 0) return [toId];
  const [start, end] = from <= to ? [from, to] : [to, from];
  return notes.slice(start, end + 1).map((row) => row.id);
}

/**
 * Shift-click with a folder at either end (T68, #230): every row from `fromKey` to `toKey` in
 * the visible order, inclusive, notes and folders alike, as row keys. Just `toKey` when the
 * start is not shown.
 */
export function rowRange(rows: readonly Row[], fromKey: string | null, toKey: string): Row[] {
  const to = rows.findIndex((row) => row.key === toKey);
  if (to < 0) return [];
  const from = fromKey === null ? -1 : rows.findIndex((row) => row.key === fromKey);
  if (from < 0) return [rows[to]!];
  const [start, end] = from <= to ? [from, to] : [to, from];
  return rows.slice(start, end + 1);
}

/** The folders picked with Shift- or ⌘-click (T68) kept to those still shown, in tree order. */
export function visibleFolders(rows: readonly Row[], picked: readonly string[]): string[] {
  if (picked.length === 0) return [];
  const wanted = new Set(picked);
  return rows.filter((row) => row.kind === 'folder' && wanted.has(row.id)).map((row) => row.id);
}

/** `selected` with `id` added, or taken out when it was in. */
export function toggled(selected: readonly string[], id: string): string[] {
  return selected.includes(id) ? selected.filter((each) => each !== id) : [...selected, id];
}

/** The notes a context menu on note `id` acts on: the selection when `id` is in it. */
export function menuTargets(selected: readonly string[], id: string): string[] {
  return selected.includes(id) ? [...selected] : [id];
}

/** The selection kept to notes still shown in the tree, in tree order. */
export function visibleSelection(rows: readonly Row[], selected: readonly string[]): string[] {
  if (selected.length === 0) return [];
  const wanted = new Set(selected);
  return rows.filter((row) => row.kind === 'note' && wanted.has(row.id)).map((row) => row.id);
}

/** How many titles a menu names before "and N more". */
const NAMED = 3;

/** “A”, “B” and “C”; past three, “A”, “B”, “C” and 2 more. */
export function notesNamed(titles: readonly string[]): string {
  const quoted = titles.slice(0, NAMED).map((title) => `“${title.trim() || 'Untitled'}”`);
  const more = titles.length - quoted.length;
  if (more > 0) return `${quoted.join(', ')} and ${more} more`;
  if (quoted.length < 2) return quoted.join('');
  return `${quoted.slice(0, -1).join(', ')} and ${quoted.at(-1)!}`;
}

/**
 * The context menu's name: “Garden plan”, or "3 notes: “A”, “B” and “C”". A Move or Trash
 * from it can reach notes scrolled out of sight, so it names them (review S1).
 */
export function notesLabel(titles: readonly string[]): string {
  if (titles.length === 1) return notesNamed(titles);
  return `${titles.length} notes: ${notesNamed(titles)}`;
}

/**
 * The selection once `openId` is opened: a click in the tree has just made it that one note,
 * which stays; a note opened any other way (search, a link, the palette, Enter on a row)
 * starts afresh, so an old selection never lingers out of sight for the next Move or Trash
 * (review S1).
 */
export function selectionAfterOpen(selected: readonly string[], openId: string | null): string[] {
  return openId !== null && selected.length === 1 && selected[0] === openId ? [openId] : [];
}

/**
 * What a Move of one or several notes says (A570, review N4): where they went, and when some
 * could not move, how many of how many and why. Notes already there count as neither.
 */
export function moveSummary(result: {
  readonly asked: number;
  readonly moved: number;
  readonly refused: number;
  readonly problem: string | null;
  readonly where: string;
}): { readonly text: string; readonly ok: boolean } {
  const { asked, moved, refused, problem, where } = result;
  if (moved === 0) return { text: problem ?? `Already in ${where}`, ok: false };
  if (asked === 1) return { text: `Moved to ${where}`, ok: true };
  if (refused === 0) return { text: `Moved ${moved} notes to ${where}`, ok: true };
  const reason = problem ? `: ${problem.replace(/\.$/u, '')}` : '';
  return {
    text: `Moved ${moved} of ${asked} notes to ${where}; ${refused} could not move${reason}`,
    ok: false,
  };
}
