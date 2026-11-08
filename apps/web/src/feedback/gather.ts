/**
 * Reads the live app for Send feedback's context (T49, A791), as the form opens and before it
 * is drawn. Everything comes in through `GatherDeps`, so a test can stand in for the app. The
 * open note's text is read here for its counts and to drop errors that quote it; only the
 * counts are kept in what is returned (`private` is for redaction and never sent).
 */
import { readIdentity, isDeleted } from '@penmoss/sync-client/note';
import { defaultNotebookName, type WorkspaceSnapshot } from '@penmoss/sync-client/workspace';
import { docText, textStats } from '../notes/stats';
import type { LocalLinks, OpenNote } from '../notes/service';
import type { NoteListEntry } from '../notes/list';
import { localLinked } from '../notes/backlinks';
import { folderTrail } from '../notes/crumbs';
import { parseRoute } from '../router';
import { notebookOfNote } from '../workspace/notebooks';
import type { ContextFacts, NoteFacts, SyncFacts } from './context';
import type { RecentError } from './errors';

interface TextNode {
  readonly type: { readonly name: string };
  readonly content: { readonly size: number };
  textBetween(from: number, to: number, blockSeparator?: string): string;
  descendants(visit: (node: { readonly type: { readonly name: string } }) => boolean | void): void;
}

/** The parts of the app the context reads. */
export interface GatherDeps {
  readonly client: 'web' | 'mac';
  readonly version: string;
  /** `main`, `note window` or `capture` (Mac), or `browser tab`/`popup` on the web. */
  readonly window: string;
  readonly userAgent: string;
  readonly viewport: { readonly width: number; readonly height: number; readonly ratio: number };
  readonly locale: string;
  readonly timeZone: string;
  readonly theme: { readonly name: string; readonly variant: string; readonly mode: string };
  readonly mac: { readonly titleBar: string; readonly keepOnTop: boolean } | null;
  readonly pathname: string;
  readonly openedFrom: string;
  /** Panels and dialogs on screen (read from the page). */
  readonly panels: readonly string[];
  readonly sidebar: string;
  readonly selectedFolderId: string | null;
  readonly online: boolean;
  readonly sync: {
    readonly phase: string;
    readonly pending: number;
    readonly detail: string | null;
  };
  readonly lastSynced: number | null;
  readonly lastSyncError: string | null;
  readonly feedbackOutbox: number;
  readonly snapshot: WorkspaceSnapshot;
  readonly list: readonly NoteListEntry[];
  readonly links: readonly LocalLinks[];
  /** The open note's copies in this window (their keepers and replica). */
  readonly opened: (id: string) => readonly OpenNote[];
  /** The text of every note this window holds open (an error quoting one is dropped). */
  readonly openTexts: () => readonly string[];
  /** The note editor's document, when it shows the open note. */
  readonly editorDoc: TextNode | null;
  readonly windowsShowing: (id: string) => number;
  readonly errors: readonly RecentError[];
  /**
   * The open note is a git notebook's (A889): it is named by kind only, and its notebook's
   * titles and folder names ([gitNames]) are scrubbed from the errors as the personal ones are.
   */
  readonly gitNote?: boolean;
  readonly gitNames?: readonly string[];
}

/** `Chrome 142`, `Electron 39`, `Firefox 140`, `Safari 18`… from a user agent. */
export function browserOf(userAgent: string): string {
  const pick = (pattern: RegExp, name: string) => {
    const match = pattern.exec(userAgent);
    return match ? `${name} ${match[1]}` : null;
  };
  const electron = pick(/Electron\/([\d.]+)/, 'Electron');
  const chrome = pick(/(?:Chrome|CriOS)\/([\d.]+)/, 'Chrome');
  return (
    [electron, chrome].filter(Boolean).join(', ') ||
    pick(/Edg\/([\d.]+)/, 'Edge') ||
    pick(/Firefox\/([\d.]+)/, 'Firefox') ||
    pick(/Version\/([\d.]+).*Safari/, 'Safari') ||
    'unknown'
  );
}

/** `macOS 10.15.7`, `Windows 10`, `Android 16`, `iOS 18.1`, `Linux`… from a user agent. */
export function osOf(userAgent: string): string {
  const mac = /Mac OS X ([\d_.]+)/.exec(userAgent);
  if (/iPhone|iPad/.test(userAgent)) {
    return `iOS ${(/OS ([\d_]+)/.exec(userAgent)?.[1] ?? '').replace(/_/g, '.')}`.trim();
  }
  if (mac) return `macOS ${mac[1]!.replace(/_/g, '.')}`;
  const windows = /Windows NT ([\d.]+)/.exec(userAgent);
  if (windows) return `Windows NT ${windows[1]}`;
  const android = /Android ([\d.]+)/.exec(userAgent);
  if (android) return `Android ${android[1]}`;
  if (/CrOS/.test(userAgent)) return 'ChromeOS';
  if (/Linux/.test(userAgent)) return 'Linux';
  return 'unknown';
}

/**
 * The path as the context names it: a Penmoss page's own path (ids kept, no query), or
 * `(not a Penmoss page)` for any other, which may hold whatever was typed or linked.
 */
export function routeOf(pathname: string): string {
  return parseRoute(pathname).name === 'not-found' ? '(not a Penmoss page)' : pathname;
}

/** What the route shows, in words; the path is kept as it is (ids, no query). */
function screenOf(pathname: string): string {
  const route = parseRoute(pathname);
  switch (route.name) {
    case 'settings':
      return `settings (${route.section})`;
    case 'window':
      return 'note (in its own window)';
    default:
      return route.name;
  }
}

function noteIdOf(pathname: string): string | null {
  const route = parseRoute(pathname);
  return route.name === 'note' || route.name === 'window' ? route.id : null;
}

/** The folder path of a folder id, outermost first ("Projects / Penmoss"). */
function folderPath(snapshot: WorkspaceSnapshot, folderId: string | null): string {
  return folderTrail(snapshot.folders, folderId).join(' / ');
}

function countAttachments(doc: TextNode): number {
  let count = 0;
  doc.descendants((node) => {
    if (node.type.name === 'image' || node.type.name === 'attachment') count++;
  });
  return count;
}

function noteFacts(deps: GatherDeps, id: string): { facts: NoteFacts; text: string } {
  const entry = deps.list.find((item) => item.id === id);
  const registry = deps.snapshot.notes.find((item) => item.id === id);
  const copies = deps.opened(id);
  const copy = copies.find((note) => note.isLoaded) ?? copies[0] ?? null;
  const doc = copy?.isLoaded ? copy.replica.doc : null;
  const identity = doc ? readIdentity(doc) : {};
  const editor = deps.editorDoc;
  const text = editor ? docText(editor) : '';
  const stats = editor ? textStats(text) : null;
  const own = deps.links.find((note) => note.id === id);
  return {
    text,
    facts: {
      id,
      title: entry?.title ?? '',
      folder: folderPath(deps.snapshot, registry?.folderId ?? null),
      notebook: notebookOfNote(deps.snapshot, id)?.name ?? defaultNotebookName(deps.snapshot),
      tags: entry?.tags ?? [],
      created: identity.created ?? null,
      updated: entry?.updatedAt || null,
      kind: identity.kind ?? null,
      words: stats?.words ?? null,
      characters: stats?.characters ?? null,
      attachments: editor ? countAttachments(editor) : null,
      // The UTF-8 size of the note's text, as Android measures it.
      bytes: editor ? new TextEncoder().encode(text).byteLength : null,
      engine: copy?.replica.engine ?? null,
      epoch: copy?.keeper.currentEpoch ?? null,
      unsynced: copy?.keeper.unsynced ?? entry?.unsynced ?? false,
      inTrash: doc ? isDeleted(doc) : false,
      backlinks: localLinked(deps.links, id).length,
      outgoingLinks: own?.links.length ?? 0,
      windows: Math.max(1, deps.windowsShowing(id)),
    },
  };
}

/** A git notebook's note as the context keeps it (A889): counts and states, nothing that names it. */
function gitNoteFacts(facts: NoteFacts): NoteFacts {
  return {
    ...facts,
    source: 'git',
    id: '',
    title: '',
    folder: '',
    notebook: '',
    tags: [],
    created: null,
    updated: null,
    kind: null,
    epoch: null,
  };
}

/** Everything the context holds, read now. */
export function gatherContext(deps: GatherDeps): ContextFacts {
  // The path only: never a query string or a fragment (search text, headings).
  const path = deps.pathname.split(/[?#]/)[0] || '/';
  const noteId = noteIdOf(path);
  const git = deps.gitNote === true && noteId !== null;
  const read = noteId ? noteFacts(deps, noteId) : null;
  const note = read && git ? { ...read, facts: gitNoteFacts(read.facts) } : read;
  const sync: SyncFacts = {
    online: deps.online,
    state: deps.sync.phase,
    lastSynced: deps.lastSynced,
    unsyncedNotes: deps.sync.pending,
    feedbackOutbox: deps.feedbackOutbox,
    lastError: deps.lastSyncError,
  };
  const names = [
    ...deps.list.map((item) => item.title),
    ...deps.snapshot.folders.map((folder) => folder.name),
    ...(deps.gitNames ?? []),
  ];
  const selected =
    !git && deps.selectedFolderId ? folderPath(deps.snapshot, deps.selectedFolderId) || null : null;
  return {
    app: {
      client: deps.client,
      version: deps.version,
      os: osOf(deps.userAgent),
      browser: browserOf(deps.userAgent),
      window: deps.window,
      viewport: `${deps.viewport.width}×${deps.viewport.height}`,
      pixelRatio: deps.viewport.ratio,
      theme: `${deps.theme.name} (${deps.theme.variant})`,
      appearance: deps.theme.mode,
      locale: deps.locale,
      timeZone: deps.timeZone,
      ...(deps.mac ? { titleBar: deps.mac.titleBar, keepOnTop: deps.mac.keepOnTop } : {}),
    },
    where: {
      route: git ? `/${screenOf(path)}` : routeOf(path),
      screen: screenOf(path),
      panels: deps.panels,
      openedFrom: deps.openedFrom,
      sidebar: deps.sidebar,
      selectedFolder: selected,
      ...(git ? { git: true } : {}),
    },
    sync,
    note: note?.facts ?? null,
    errors: deps.errors,
    private: {
      names,
      noteTexts: [...(note?.text ? [note.text] : []), ...deps.openTexts()].filter(Boolean),
    },
  };
}

/** The panels and dialogs the page shows now, read from its markup. */
export function panelsOn(doc: Pick<Document, 'querySelector'>): string[] {
  const panels: string[] = [];
  const shows = (selector: string) => doc.querySelector(selector) !== null;
  if (shows('[data-testid="note-info"]')) panels.push('Info');
  if (shows('[data-testid="history-panel"]')) panels.push('Version history');
  if (shows('.note-source')) panels.push('Markdown source');
  if (shows('[data-testid="capture-dialog"]')) panels.push('Quick capture');
  if (shows('.folder-picker, [data-testid="folder-picker"]')) panels.push('Folder picker');
  return panels;
}

/** The sidebar as the page shows it: expanded, an icon rail, or the phone's drawer. */
export function sidebarOn(doc: Pick<Document, 'querySelector'>): string {
  const shell = doc.querySelector('.notes-app');
  if (!shell) return 'none on this screen';
  if (shell.getAttribute('data-drawer') === 'open') return 'drawer open';
  if (shell.getAttribute('data-sidebar') === 'collapsed') return 'collapsed (icon rail)';
  return 'expanded';
}

/** The folder row selected in the tree (`folder:<id>`), or null. */
export function selectedFolderOn(doc: Pick<Document, 'querySelector'>): string | null {
  const row = doc.querySelector('.folder-row[aria-selected="true"]');
  const key = row?.getAttribute('data-key') ?? '';
  return key.startsWith('folder:') ? key.slice('folder:'.length) : null;
}
