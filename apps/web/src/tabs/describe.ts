/**
 * What a tab says about its page (PEN-140, A1502): its title, the notebook and folders of a
 * note, and its ⌘ number, for the strip, the All Tabs list and the narrow tab sheet.
 */
import { useMemo } from 'react';
import { folderTrail } from '../notes/crumbs';
import { parseRoute } from '../router';
import { useSourcesRegistry } from '../sources/hooks';
import { useEveryOpenNoteList } from '../sources/lists';
import type { Source } from '../sources/registry';
import { currentEntry, isBareHome, noteIdOfPath, type TabsState } from './state';

type PageKind =
  'note' | 'home' | 'graph' | 'trash' | 'tags' | 'time-machine' | 'settings' | 'other';

export interface TabFace {
  readonly id: string;
  readonly kind: PageKind;
  /** "Untitled" for a note with no title. */
  readonly title: string;
  /** The note's notebook (null for other pages, or while it is being read). */
  readonly source: Source | null;
  /** The note's folders, outermost first. */
  readonly folders: readonly string[];
  /** Its notebook's name after the title: two tabs that look alike otherwise (AC8). */
  readonly suffix: string | null;
  /** ⌘1–⌘8, or ⌘9 for the last; null past 8 (but the last). */
  readonly number: number | null;
  readonly pinned: boolean;
  readonly active: boolean;
}

const PAGE_TITLES: Readonly<Record<Exclude<PageKind, 'note'>, string>> = {
  home: 'Home',
  graph: 'Graph',
  trash: 'Trash',
  tags: 'Tags',
  'time-machine': 'Time Machine',
  settings: 'Settings',
  other: 'Not Found',
};

function kindOf(path: string): PageKind {
  const [pathname = ''] = path.split('?');
  const route = parseRoute(pathname);
  switch (route.name) {
    case 'note':
      return 'note';
    case 'home':
      return 'home';
    case 'graph':
      return 'graph';
    case 'trash':
      return 'trash';
    case 'tags':
      return 'tags';
    case 'time-machine':
      return 'time-machine';
    case 'settings':
      return 'settings';
    default:
      return 'other';
  }
}

/** What a page in a tab is called: a note's title ("Untitled" with none), else the page's name. */
export function pageTitle(path: string, titleOf: (noteId: string) => string | undefined): string {
  const kind = kindOf(path);
  const note = kind === 'note' ? noteIdOfPath(path) : null;
  return note === null
    ? PAGE_TITLES[kind === 'note' ? 'other' : kind]
    : titleOf(note) || 'Untitled';
}

/** The ⌘ number of the tab at `index` of `count` (⌘9 is always the last). */
export function tabNumber(index: number, count: number): number | null {
  if (index === count - 1 && count > 8) return 9;
  return index < 8 ? index + 1 : null;
}

/** What a note's notebook looks like on its badge, for telling look-alike tabs apart. */
export type BadgeLook = (source: Source) => string;

/**
 * The faces of every tab, in strip order. Two note tabs with the same title whose notebooks'
 * badges look the same (`look`) each name their notebook after the title.
 */
export function describeTabs(
  state: TabsState,
  context: {
    readonly sourceOf: (noteId: string) => Source | null;
    readonly titleOf: (noteId: string) => string | undefined;
    readonly look: BadgeLook;
  },
): TabFace[] {
  const faces = state.tabs.map((tab, index): TabFace => {
    const path = currentEntry(tab).path;
    const kind = kindOf(path);
    const note = kind === 'note' ? noteIdOfPath(path) : null;
    const source = note === null ? null : context.sourceOf(note);
    const title = pageTitle(path, context.titleOf);
    let folders: readonly string[] = [];
    if (note !== null && source) {
      const { snapshot } = source.workspace.getState();
      folders = folderTrail(
        snapshot.folders,
        snapshot.notes.find((entry) => entry.id === note)?.folderId ?? null,
      );
    }
    return {
      id: tab.id,
      kind,
      title,
      source,
      folders,
      suffix: null,
      number: tabNumber(index, state.tabs.length),
      pinned: tab.pinned,
      active: tab.id === state.active,
    };
  });
  return faces.map((face) => {
    if (face.kind !== 'note' || !face.source) return face;
    const look = context.look(face.source);
    const alike = faces.some(
      (other) =>
        other !== face &&
        other.kind === 'note' &&
        other.source !== null &&
        other.source.id !== face.source!.id &&
        other.title === face.title &&
        context.look(other.source) === look,
    );
    return alike ? { ...face, suffix: face.source.name } : face;
  });
}

/** The tooltip: the title, where the note is, and the tab's keys (AC8). */
export function tabTip(face: TabFace, apple: boolean): string {
  const where = face.source ? [face.source.name, ...face.folders].join(' › ') : '';
  const keys = face.number === null ? '' : ` (${apple ? '⌘' : 'Ctrl+'}${face.number})`;
  return `${face.title}${where ? ` · ${where}` : ''}${keys}`;
}

/** The notebook and folders of a note's tab, as the sheet's second line shows them. */
export const facePath = (face: TabFace): string =>
  face.source ? [face.source.name, ...face.folders].join(' › ') : '';

/**
 * The faces of the tabs the strip and the sheet show; they follow renames, moves and the badges.
 * None while the window has no note open (a bare Home, A1576).
 */
export function useTabFaces(state: TabsState | null, look: BadgeLook): TabFace[] {
  const registry = useSourcesRegistry();
  const list = useEveryOpenNoteList();
  return useMemo(() => {
    if (!state || isBareHome(state)) return [];
    const titles = new Map(list.map((entry) => [entry.id, entry.title]));
    return describeTabs(state, {
      sourceOf: (id) => registry.sourceOfNote(id),
      titleOf: (id) => titles.get(id),
      look,
    });
  }, [state, list, registry, look]);
}
