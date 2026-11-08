/**
 * File names in a git notebook (T50, A823; #147's A743, the mirror's A201/A212/A217):
 *
 * - Every note and folder is named by the mirror's rules (`@penmoss/core/mirror`): sanitised for
 *   every filesystem, unique across the repository ignoring case, cut to fit a Windows clone.
 * - **Names are assigned once and stored** in the WorkspaceDoc (a note's `fileName`, a folder's
 *   `dirName`). A note keeps its stored name while its title's base is unchanged and nothing older
 *   holds it, so a committed file never moves because of a later note, an offline one included.
 * - **Claims ride only in commits that land** (G0's change to #147): a render writes its claims
 *   into a fork of the WorkspaceDoc, which joins the local doc once its commit is on the branch.
 *   Every claim is then made against the claims at head, so two never collide; the older-id rule
 *   stays as the tie-break of concurrent claims.
 * - Files Penmoss did not write keep their names: a `.md` is Penmoss's only when its frontmatter
 *   `id` is a note of this notebook (A217); anything else under `<dir>` reserves its name.
 */
import { effectiveParents } from '@penmoss/core/workspace';
import {
  assignFolders,
  folderDirs,
  nameKey,
  noteName,
  notePath,
  sanitizeName,
  uniqueName,
  type FolderName,
  type MirrorFolder,
} from '@penmoss/core/mirror';
import { isDeleted, readTitle } from '@penmoss/sync-client/note';
import { readWorkspace, WORKSPACE_FOLDERS, WORKSPACE_NOTES } from '@penmoss/sync-client/workspace';
import * as Y from '@y/y';
import { ATTACHMENTS_DIR, PENMOSS_DIR } from './layout';

/** A note's stored file name: `{ base, name }`, one value so a claim is atomic. */
export const NOTE_NAME_ATTR = 'fileName';
/** A folder's stored directory name (A212's `FolderName`), one value. */
export const FOLDER_NAME_ATTR = 'dirName';
/**
 * Where Penmoss last rendered a note, relative to `<dir>` (null: no file, as in Trash). Stored
 * with the names, so it lands with the commit that wrote the file: a `.md` carrying the note's id
 * anywhere else is a copy someone made, which Penmoss reports and leaves alone (A823).
 */
export const NOTE_PATH_ATTR = 'filePath';

export interface NoteName {
  /** `noteName(title)` when it was named: another base means the title changed. */
  readonly base: string;
  readonly name: string;
}

/** What `<dir>` holds that Penmoss did not write (A217), and which `.md` files are its own. */
export interface Foreign {
  /** `<dir>\0<name key>` for every directory and file name a foreign file uses. */
  readonly reserved: ReadonlySet<string>;
  /** Name keys of foreign `.md` files, anywhere: a note never takes one (names are repo-wide). */
  readonly noteKeys: ReadonlySet<string>;
  /** Penmoss's rendered files at head: path → note id. */
  readonly penmoss: ReadonlyMap<string, string>;
  /** The foreign files, relative to `<dir>` (Status lists them). */
  readonly paths: readonly string[];
  /** Copies of Penmoss's files (a note's id, not where Penmoss put it), relative to `<dir>`. */
  readonly copies: readonly string[];
}

const FRONTMATTER_ID = /^---\r?\nid: ([0-9A-Z]{26})\r?\n/;
const decoder = new TextDecoder();

/** The Penmoss id in a markdown file's frontmatter (`id:` is always its first key, A205). */
export function frontmatterId(bytes: Uint8Array | null | undefined): string | null {
  if (!bytes) return null;
  return FRONTMATTER_ID.exec(decoder.decode(bytes.subarray(0, 64)))?.[1] ?? null;
}

/**
 * Sorts the files under `root` (repository paths) into Penmoss's and foreign ones. `idOf` gives a
 * `.md` file's frontmatter id; `known` is every note id this notebook has (purged ones included,
 * so their files are recognised and removed).
 */
export function foreignOf(
  files: Iterable<string>,
  idOf: (path: string) => string | null,
  root: string,
  known: ReadonlySet<string>,
  /** Whether Penmoss put the file at `rel` for note `id` (default: every file with a known id). */
  owns: (rel: string, id: string) => boolean = () => true,
): Foreign {
  const reserved = new Set<string>();
  const noteKeys = new Set<string>();
  const penmoss = new Map<string, string>();
  const paths: string[] = [];
  const copies: string[] = [];
  for (const path of files) {
    if (!path.startsWith(root)) continue;
    const rel = path.slice(root.length);
    if (rel.startsWith(`${PENMOSS_DIR}/`) || rel.startsWith(`${ATTACHMENTS_DIR}/`)) continue;
    if (rel.endsWith('.md')) {
      const id = idOf(path);
      if (id && known.has(id)) {
        if (owns(rel, id)) {
          penmoss.set(path, id);
          continue;
        }
        // A copy keeps its name like any file Penmoss did not write, and is reported.
        copies.push(rel);
      }
    }
    paths.push(rel);
    const parts = rel.split('/');
    for (let i = 0; i < parts.length; i++) {
      reserved.add(`${parts.slice(0, i).join('/')}\0${nameKey(parts[i]!)}`);
    }
    const last = parts.at(-1)!;
    if (last.endsWith('.md')) noteKeys.add(nameKey(last.slice(0, -3)));
  }
  return { reserved, noteKeys, penmoss, paths: paths.sort(), copies: copies.sort() };
}

function stored(node: unknown, attr: string): Record<string, unknown> | null {
  if (!(node instanceof Y.Node)) return null;
  const value: unknown = node.getAttr(attr);
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Longest name a claim may hold: a note name, a suffix and room to spare. */
const MAX_CLAIM_CHARS = 160;

/**
 * A stored name is used only when Penmoss could have made it (A823): a claim is data from any
 * writer, so one that would leave its directory (`sub/README`, `..`) or that the mirror's rules
 * would change is ignored, and the note or folder is named afresh.
 */
export function validName(name: unknown): name is string {
  return (
    typeof name === 'string' &&
    name.length > 0 &&
    name.length <= MAX_CLAIM_CHARS &&
    name !== '.' &&
    name !== '..' &&
    !name.includes('/') &&
    !name.includes('\\') &&
    sanitizeName(name) === name
  );
}

/** A note's stored name, when it is a valid one. */
export function storedNoteName(node: unknown): NoteName | null {
  const value = stored(node, NOTE_NAME_ATTR);
  if (!value || typeof value['base'] !== 'string' || !validName(value['name'])) return null;
  return { base: value['base'], name: value['name'] };
}

/** A folder's stored directory name, when it is a valid one. */
export function storedFolderName(node: unknown): FolderName | null {
  const value = stored(node, FOLDER_NAME_ATTR);
  if (
    !value ||
    typeof value['base'] !== 'string' ||
    !validName(value['name']) ||
    typeof value['top'] !== 'boolean' ||
    !(value['parentId'] === null || typeof value['parentId'] === 'string')
  ) {
    return null;
  }
  return {
    base: value['base'],
    name: value['name'],
    top: value['top'],
    parentId: value['parentId'],
  };
}

/**
 * Where Penmoss last put a note's file, relative to `<dir>`: a path, null for none (in Trash),
 * or undefined when no render stored one (notebooks from before the record: every file with the
 * note's id counts as Penmoss's).
 */
export function storedNotePath(workspace: Y.Doc, noteId: string): string | null | undefined {
  const node: unknown = workspace.get(WORKSPACE_NOTES).getAttr(noteId);
  if (!(node instanceof Y.Node) || !node.hasAttr(NOTE_PATH_ATTR)) return undefined;
  const value: unknown = node.getAttr(NOTE_PATH_ATTR);
  return typeof value === 'string' ? value : null;
}

export interface Named {
  /** Every folder's name (claimed or kept). */
  readonly folders: ReadonlyMap<string, FolderName>;
  /** Every folder's directory relative to `<dir>`. */
  readonly dirs: ReadonlyMap<string, string>;
  /** Every registered note's name, Trash included. */
  readonly names: ReadonlyMap<string, NoteName & { readonly title: string }>;
  /** Every live note's file (a repository path); notes in Trash have none. */
  readonly paths: ReadonlyMap<string, string>;
}

/**
 * Names and paths for every folder and live note. A note keeps its stored claim while its title's
 * base is unchanged and no older note (or a foreign file) holds the name; every other note is
 * named afresh, in id order, so the older id wins a clash between concurrent claims.
 */
export function assignNames(input: {
  readonly workspace: Y.Doc;
  readonly notes: ReadonlyMap<string, Y.Doc>;
  readonly purged: ReadonlySet<string>;
  readonly foreign: Foreign;
  readonly root: string;
}): Named {
  const { workspace, notes, purged, foreign, root } = input;
  const snapshot = readWorkspace(workspace);
  const parents = effectiveParents(snapshot.folders);
  const folderNodes = workspace.get(WORKSPACE_FOLDERS);
  const mirrorFolders: MirrorFolder[] = snapshot.folders.map((folder) => ({
    id: folder.id,
    name: folder.name,
    parentId: parents.get(folder.id) ?? null,
  }));
  const previous = new Map<string, FolderName>();
  for (const folder of snapshot.folders) {
    const name = storedFolderName(folderNodes.getAttr(folder.id));
    if (name) previous.set(folder.id, name);
  }
  const folders = assignFolders(mirrorFolders, previous, (dir, key) =>
    foreign.reserved.has(`${dir}\0${key}`),
  );
  const dirs = folderDirs(mirrorFolders, folders);

  const registry = workspace.get(WORKSPACE_NOTES);
  // Notes in Trash keep their names (a restore puts the file back where it was), but no file.
  const live = snapshot.notes
    .filter((entry) => notes.has(entry.id) && !purged.has(entry.id))
    .sort((a, b) => (a.id < b.id ? -1 : 1));
  const taken = new Set(foreign.noteKeys);
  const names = new Map<string, NoteName & { title: string }>();
  const later: Array<[string, string, string]> = [];
  for (const entry of live) {
    const title = readTitle(notes.get(entry.id)!);
    const base = noteName(title);
    const claim = storedNoteName(registry.getAttr(entry.id));
    const key = claim ? nameKey(claim.name) : null;
    if (claim && claim.base === base && key !== null && !taken.has(key)) {
      taken.add(key);
      names.set(entry.id, { base, name: claim.name, title });
    } else {
      later.push([entry.id, base, title]);
    }
  }
  for (const [id, base, title] of later) {
    const name = uniqueName(base, id, (key) => taken.has(key));
    taken.add(nameKey(name));
    names.set(id, { base, name, title });
  }
  const paths = new Map<string, string>();
  for (const entry of live) {
    if (isDeleted(notes.get(entry.id)!)) continue;
    const dir = entry.folderId === null ? '' : (dirs.get(entry.folderId) ?? '');
    paths.set(entry.id, `${root}${notePath(dir, names.get(entry.id)!.name)}`);
  }
  return { folders, dirs, names, paths };
}

/**
 * Writes the names a render used as claims into `doc` (a fork of the WorkspaceDoc, A823), only
 * where they differ from what it holds, so unchanged names never ping-pong. Returns how many.
 */
export function storeClaims(named: Named, doc: Y.Doc, origin: unknown, root: string = ''): number {
  const folders = doc.get(WORKSPACE_FOLDERS);
  const registry = doc.get(WORKSPACE_NOTES);
  const writes: Array<[Y.Node, string, unknown]> = [];
  // Key order never counts: a value read back is the same claim.
  const canon = (value: unknown) =>
    JSON.stringify(value, (_key, v: unknown) =>
      v && typeof v === 'object' && !Array.isArray(v)
        ? Object.fromEntries(Object.entries(v).sort(([x], [y]) => (x < y ? -1 : 1)))
        : v,
    );
  const same = (a: unknown, b: unknown) => canon(a) === canon(b);
  for (const [id, name] of named.folders) {
    const node: unknown = folders.getAttr(id);
    if (!(node instanceof Y.Node)) continue;
    if (!same(stored(node, FOLDER_NAME_ATTR), name)) {
      writes.push([node, FOLDER_NAME_ATTR, { ...name }]);
    }
  }
  for (const [id, name] of named.names) {
    const node: unknown = registry.getAttr(id);
    if (!(node instanceof Y.Node)) continue;
    const value: NoteName = { base: name.base, name: name.name };
    if (!same(stored(node, NOTE_NAME_ATTR), value)) writes.push([node, NOTE_NAME_ATTR, value]);
    const path = named.paths.get(id);
    const rel = path === undefined ? null : path.slice(root.length);
    const current: unknown = node.hasAttr(NOTE_PATH_ATTR)
      ? node.getAttr(NOTE_PATH_ATTR)
      : undefined;
    if (current !== rel) writes.push([node, NOTE_PATH_ATTR, rel]);
  }
  if (writes.length > 0) {
    doc.transact(() => {
      for (const [node, attr, value] of writes) node.setAttr(attr, value);
    }, origin);
  }
  return writes.length;
}
