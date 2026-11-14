/**
 * The repository layout of a git notebook (T50, A821; #147's A741):
 *
 * ```
 * <dir>/                         the repository's top when no directory is set
 *   .penmoss/
 *     notebook.json              { id, name, format, renderVersion }
 *     actors/<writer>.json       { kind, label, clientIds }
 *     workspace/<writer>.yjs     this writer's part of the WorkspaceDoc (one Yjs update)
 *     notes/<noteId>/<writer>.yjs
 *   Work/Projects/Meeting.md     rendered markdown, never read back in v1
 *   attachments/<sha256>.<ext>
 * ```
 *
 * A writer is one install of one notebook (each device's app, each CLI clone). It writes only its
 * own files; the rendered markdown is a pure function of the merged state, so every writer writes
 * the same bytes there.
 */

/**
 * The newest layout this client knows: a client refuses a notebook whose format is newer.
 * 2: `notebook.json` may carry `salt` (T56, A1021). Only a notebook that carries one is written
 * as format 2, so a client from before refuses it instead of deriving other ids for its Journal;
 * every other notebook stays format 1.
 */
export const FORMAT = 2;
/**
 * How this client renders markdown (A823). The highest version in `notebook.json` wins: an older
 * client still writes its logs but renders nothing, so mixed versions never ping-pong files.
 */
// 2: name claims record the file they name, so a copy of a note's file is told apart (#165).
// Raised so a client from before it renders nothing, instead of suffixed duplicates.
// 3: names lose bidi and format characters, emoji sequences kept (#170 F11, #174 review).
// Raised so a client from before renders nothing, instead of renaming `Sha\u200elom notes.md`
// back and forth with a newer one on every sync.
export const RENDER_VERSION = 3;
/** Penmoss's own folder inside `<dir>`. */
export const PENMOSS_DIR = '.penmoss';
/** Attachments, as the mirror keeps them (A205). */
export const ATTACHMENTS_DIR = 'attachments';

/** What `.penmoss/notebook.json` holds: who the notebook is, wherever it is cloned. */
export interface NotebookInfo {
  /** A ULID; the salt of its derived ids (A820) and the key of its local database. */
  readonly id: string;
  readonly name: string;
  readonly format: number;
  readonly renderVersion: number;
  /**
   * The salt of its derived ids, when it is not the id (T56, A1021): `''` for the notebook
   * imported from the personal workspace, which keeps the workspace's own daily and weekly note
   * ids and Journal folder ids. Absent for every other notebook.
   */
  readonly salt?: string;
}

/** The salt of a notebook's derived ids (A820, A1021): its own, else its id. */
export function notebookSalt(info: Pick<NotebookInfo, 'id' | 'salt'>): string {
  return info.salt ?? info.id;
}

/** The format a notebook is written as: 2 only when it needs a client that reads `salt`. */
export function formatOf(info: Pick<NotebookInfo, 'salt'>): number {
  return info.salt === undefined ? 1 : 2;
}

export type LayoutPath =
  | { readonly kind: 'notebook' }
  | { readonly kind: 'actor'; readonly writer: string }
  | { readonly kind: 'workspace'; readonly writer: string }
  | { readonly kind: 'note'; readonly noteId: string; readonly writer: string };

/** Writer ids and note ids are ULIDs (or, for derived notes, ULID-shaped): nothing else is ours. */
const ID = /^[0-9A-Z]{26}$/;

export class Layout {
  /** `<dir>/.penmoss/`. */
  readonly base: string;

  /** `root` is `''` (the repository's top) or a directory ending in `/` (`docs/notes/`). */
  constructor(readonly root: string) {
    if (root !== '' && !root.endsWith('/')) throw new RangeError(`root must end in /: ${root}`);
    this.base = `${root}${PENMOSS_DIR}/`;
  }

  get notebook(): string {
    return `${this.base}notebook.json`;
  }

  actor(writer: string): string {
    return `${this.base}actors/${writer}.json`;
  }

  workspace(writer: string): string {
    return `${this.base}workspace/${writer}.yjs`;
  }

  note(noteId: string, writer: string): string {
    return `${this.base}notes/${noteId}/${writer}.yjs`;
  }

  noteDir(noteId: string): string {
    return `${this.base}notes/${noteId}/`;
  }

  attachment(file: string): string {
    return `${this.root}${ATTACHMENTS_DIR}/${file}`;
  }

  /** What a path is in the layout, or null for anything else (rendered files, foreign files). */
  parse(path: string): LayoutPath | null {
    if (!path.startsWith(this.base)) return null;
    const rest = path.slice(this.base.length).split('/');
    if (rest.length === 1 && rest[0] === 'notebook.json') return { kind: 'notebook' };
    if (rest.length === 2 && rest[0] === 'actors' && rest[1]!.endsWith('.json')) {
      const writer = rest[1]!.slice(0, -5);
      return ID.test(writer) ? { kind: 'actor', writer } : null;
    }
    if (rest.length === 2 && rest[0] === 'workspace' && rest[1]!.endsWith('.yjs')) {
      const writer = rest[1]!.slice(0, -4);
      return ID.test(writer) ? { kind: 'workspace', writer } : null;
    }
    if (rest.length === 3 && rest[0] === 'notes' && rest[2]!.endsWith('.yjs')) {
      const noteId = rest[1]!;
      const writer = rest[2]!.slice(0, -4);
      return ID.test(noteId) && ID.test(writer) ? { kind: 'note', noteId, writer } : null;
    }
    return null;
  }

  /** Inside `<dir>` (every path Penmoss may ever write is). */
  contains(path: string): boolean {
    return path.startsWith(this.root) && !path.includes('\0');
  }
}

/** A directory target as a layout root: `docs/notes` → `docs/notes/`, '' or `/` → ''. */
export function rootOf(dir: string | null | undefined): string {
  const clean = (dir ?? '')
    .split('/')
    .filter((part) => part !== '' && part !== '.')
    .join('/');
  if (clean.split('/').some((part) => part === '..'))
    throw new RangeError(`Not a directory: ${dir}`);
  return clean ? `${clean}/` : '';
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function encodeJson(value: unknown): Uint8Array {
  return encoder.encode(`${JSON.stringify(value, null, 2)}\n`);
}

/** How long a notebook's name may be (the sidebar shows it; the Mac's and Android's add forms cut it there). */
export const NOTEBOOK_NAME_MAX = 80;

/**
 * A notebook's name as Rename writes it to `notebook.json` (Ryan's review of PR #192): one line,
 * its spaces collapsed, no control characters, at most `NOTEBOOK_NAME_MAX` characters. Null when
 * nothing is left.
 */
export function cleanNotebookName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const clean = value
    .replace(/\p{Cc}/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, NOTEBOOK_NAME_MAX)
    .trim();
  return clean || null;
}

/** `notebook.json`, or null when it is unreadable (never thrown: a broken file is reported). */
export function parseNotebookInfo(bytes: Uint8Array): NotebookInfo | null {
  try {
    const value = JSON.parse(decoder.decode(bytes)) as Partial<NotebookInfo>;
    if (typeof value.id !== 'string' || !ID.test(value.id)) return null;
    return {
      id: value.id,
      name: typeof value.name === 'string' && value.name.trim() ? value.name.trim() : 'Notebook',
      format: typeof value.format === 'number' ? value.format : 1,
      renderVersion: typeof value.renderVersion === 'number' ? value.renderVersion : 1,
      ...(typeof value.salt === 'string' ? { salt: value.salt } : {}),
    };
  } catch {
    return null;
  }
}

export function encodeNotebookInfo(info: NotebookInfo): Uint8Array {
  return encodeJson({
    id: info.id,
    name: info.name,
    format: info.format,
    renderVersion: info.renderVersion,
    ...(info.salt !== undefined ? { salt: info.salt } : {}),
  });
}
