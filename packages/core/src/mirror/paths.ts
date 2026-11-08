/**
 * Paths in the git mirror (T27, A10, A201, A212). Pure functions, so the rules
 * are unit-tested and the same everywhere:
 *
 * - A note is `<folder path>/<name>.md`. Its name is its title, sanitised for
 *   every filesystem Obsidian runs on and for wikilinks, cut to
 *   `MAX_NOTE_NAME_CHARS`, and unique across the whole repository,
 *   case-insensitively: a title another note's file (or a file added by hand)
 *   already has gets the end of the note's id, `Meeting (7KQ2MXH)`. A note
 *   keeps its name until its title changes (assigned once and stored), so
 *   moving it never renames it, and every wikilink can name a file alone
 *   (`[[name]]`), which Obsidian resolves anywhere in the vault.
 * - A folder is its folder names from the top, each sanitised the same way and
 *   assigned once too (`assignFolders`, stored by the mirror): sibling folders
 *   that collide take a suffix from their id, the one named first keeping the
 *   plain name; the top-level `attachments` folder is the mirror's own.
 * - Every path fits a Windows clone (`MAX_PATH_CHARS`): folder names are cut
 *   to `MAX_FOLDER_NAME_CHARS` and a folder path to `MAX_DIR_CHARS`, a cut
 *   name ending in `~` and a hash of the folder's id.
 */

import { stripInvisible } from '../invisible';

/** Longest name, in UTF-8 bytes, before a suffix and `.md` (filesystems allow 255). */
export const MAX_NAME_BYTES = 150;
/**
 * Longest path in the repository, in UTF-16 units as Windows counts them:
 * Windows' 260 less room for the clone's own folder
 * (`C:\\Users\\someone\\Documents\\penmoss-notes\\` is 41).
 */
export const MAX_PATH_CHARS = 200;
/** Longest note name before a suffix (the suffix adds at most 29, `.md` 3). */
export const MAX_NOTE_NAME_CHARS = 80;
/** Longest folder name, room left for an id suffix (at most 29). */
export const MAX_FOLDER_NAME_CHARS = 56;
/** Longest suffix `uniqueName` adds: ` (` + a 26-character id + `)`. */
const MAX_SUFFIX_CHARS = 29;
/** Longest folder path: whatever a note with the longest name leaves. */
export const MAX_DIR_CHARS = MAX_PATH_CHARS - 1 - (MAX_NOTE_NAME_CHARS + MAX_SUFFIX_CHARS + 3);
/** A cut folder name ends in `~` and 6 characters of a hash of its id. */
const CUT_MARK_CHARS = 7;
/** Where attachments go, at the top of the repository. */
export const ATTACHMENTS_DIR = 'attachments';

/**
 * Characters no name may hold: Windows forbids `\ / : * ? " < > |`; wikilinks
 * use `# ^ [ ] |`; control characters are never wanted.
 */
// eslint-disable-next-line no-control-regex -- control characters are exactly what it removes
const FORBIDDEN = /[\\/:*?"<>|#^[\]\u0000-\u001f\u007f]/g;
/**
 * The naming rules' version (A930): 2 since names lost their bidi and format characters (#170
 * F11). A mirror that named its files under an older one renames them once, in a commit of its
 * own, before anything else is written.
 */
export const NAMING_VERSION = 2;
const WINDOWS_DEVICE = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;
const encoder = new TextEncoder();

/** A title or folder name as a file or folder name: never empty, hidden or reserved. */
export function sanitizeName(raw: string): string {
  // Bidi and format characters out, emoji sequences kept whole (#170 F11, #174 review).
  let name = stripInvisible(raw.normalize('NFC')).replace(FORBIDDEN, ' ').replace(/\s+/g, ' ');
  name = trimEdges(name);
  name = trimEdges(cutToBytes(name, MAX_NAME_BYTES));
  if (!name) return 'Untitled';
  const dot = name.indexOf('.');
  const stem = dot < 0 ? name : name.slice(0, dot);
  if (WINDOWS_DEVICE.test(stem)) name = `${stem}_${name.slice(stem.length)}`;
  return name;
}

/** Leading dots (hidden files) and spaces; trailing dots and spaces (Windows drops them). */
function trimEdges(name: string): string {
  return name.replace(/^[.\s]+/, '').replace(/[.\s]+$/, '');
}

/** A note's file name for `title`, before any suffix: sanitised and cut to MAX_NOTE_NAME_CHARS. */
export function noteName(title: string): string {
  return trimEdges(cutToChars(sanitizeName(title), MAX_NOTE_NAME_CHARS)) || 'Untitled';
}

/** At most `max` UTF-16 units, never splitting a character. */
function cutToChars(text: string, max: number): string {
  if (text.length <= max) return text;
  let out = '';
  for (const char of text) {
    if (out.length + char.length > max) break;
    out += char;
  }
  return out;
}

function cutToBytes(text: string, max: number): string {
  if (encoder.encode(text).byteLength <= max) return text;
  let out = '';
  let bytes = 0;
  for (const char of text) {
    const size = encoder.encode(char).byteLength;
    if (bytes + size > max) break;
    out += char;
    bytes += size;
  }
  return out;
}

/**
 * What two names collide on: case-insensitive, as on macOS and Windows. Upper
 * then lower case folds more than lower case alone (final sigma, `ǰ`), and
 * NFC on both sides makes composed and decomposed forms one key. It may fold
 * a little more than a filesystem does (`ß`, `ss`), which only costs a suffix.
 */
export function nameKey(name: string): string {
  return name.normalize('NFC').toUpperCase().toLowerCase().normalize('NFC');
}

/** The suffixes a colliding name tries, shortest first: the id's end, more of it, all of it. */
function suffixes(id: string): string[] {
  return [...new Set([id.slice(-7), id.slice(-13), id])];
}

/** `base`, or `base (<end of id>)` when `taken` says the name is in use. */
export function uniqueName(base: string, id: string, taken: (key: string) => boolean): string {
  if (!taken(nameKey(base))) return base;
  for (const suffix of suffixes(id)) {
    const name = `${base} (${suffix})`;
    if (!taken(nameKey(name))) return name;
  }
  // Two notes cannot share an id, so the full id is free unless something is wrong.
  return `${base} (${id}-${Math.random().toString(36).slice(2, 8)})`;
}

export interface MirrorFolder {
  readonly id: string;
  readonly name: string;
  /** The parent the tree shows (core `effectiveParents`: cycles broken); null at the top. */
  readonly parentId: string | null;
}

/** A folder's stored name (A212): kept until its own name or its parent changes. */
export interface FolderName {
  /** The parent in the tree (null at the top) when it was named. */
  readonly parentId: string | null;
  /** Its sanitised name when it was named; another base means it was renamed. */
  readonly base: string;
  /** Its directory's name. */
  readonly name: string;
  /** True when its parent's path left no room, so it was placed at the top. */
  readonly top: boolean;
}

/** Whether a name is taken in a directory by something the mirror does not name (a file added by hand). */
export type Reserved = (dir: string, key: string) => boolean;

/** A folder's name before collisions and cuts: sanitised, never `*.md`. */
function folderBase(raw: string): string {
  let base = sanitizeName(raw);
  // A note file `<name>.md` beside it would collide with a folder of that name.
  if (nameKey(base).endsWith('.md')) base = `${base}_`;
  return base;
}

/** `base` cut to `max` characters, ending in `~` and a hash of the id (another attempt, another hash). */
function cutName(base: string, id: string, max: number, attempt = 0): string {
  const head = trimEdges(cutToChars(base, Math.max(1, max - CUT_MARK_CHARS)));
  return `${head}~${shortHash(attempt === 0 ? id : `${id}#${attempt}`)}`;
}

/** FNV-1a, 6 base-36 characters: tells cut names apart, nothing more. */
function shortHash(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36).padStart(7, '0').slice(-6);
}

/**
 * Names every folder (A201, A212), keeping each name in `previous` while the
 * folder's own name and parent are unchanged, its name still fits and nothing
 * else has taken it. New, renamed and moved folders are named after the kept
 * ones, by id: a suffix from the id when a sibling (or `reserved`) has the
 * name, a cut name when its path would pass MAX_DIR_CHARS, and the top level
 * when its parent's path leaves no room at all.
 */
export function assignFolders(
  folders: readonly MirrorFolder[],
  previous: ReadonlyMap<string, FolderName>,
  reserved: Reserved = () => false,
): Map<string, FolderName> {
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  const children = new Map<string | null, MirrorFolder[]>();
  for (const folder of folders) {
    const parent = folder.parentId !== null && byId.has(folder.parentId) ? folder.parentId : null;
    children.set(parent, [...(children.get(parent) ?? []), folder]);
  }
  const out = new Map<string, FolderName>();
  // Names taken per directory ('' is the top), by key.
  const taken = new Map<string, Set<string>>([['', new Set([nameKey(ATTACHMENTS_DIR)])]]);
  const takenIn = (dir: string) => {
    let set = taken.get(dir);
    if (!set) taken.set(dir, (set = new Set()));
    return set;
  };
  const isTaken = (dir: string, name: string) =>
    takenIn(dir).has(nameKey(name)) || reserved(dir, nameKey(name));
  const fits = (dir: string, name: string) =>
    (dir ? dir.length + 1 : 0) + name.length <= MAX_DIR_CHARS;
  // Folders still to place: [folder, its tree parent, the parent's directory].
  let level: Array<[MirrorFolder, string | null, string]> = (children.get(null) ?? []).map(
    (folder) => [folder, null, ''],
  );
  const dirs = new Map<string, string>();
  for (let depth = 0; level.length > 0 && depth <= 64; depth++) {
    const sorted = [...level].sort((a, b) => (a[0].id < b[0].id ? -1 : 1));
    const later: typeof sorted = [];
    // Kept names first, so a newcomer never takes a name from a folder that had it.
    for (const item of sorted) {
      const [folder, parentId, parentDir] = item;
      const base = folderBase(folder.name);
      const old = previous.get(folder.id);
      const roomy = fits(parentDir, 'x'.repeat(CUT_MARK_CHARS + 1));
      const dir = old?.top ? '' : parentDir;
      if (
        old &&
        old.base === base &&
        old.parentId === parentId &&
        old.top === (parentDir !== '' && !roomy) &&
        fits(dir, old.name) &&
        !isTaken(dir, old.name)
      ) {
        takenIn(dir).add(nameKey(old.name));
        out.set(folder.id, old);
        dirs.set(folder.id, dir ? `${dir}/${old.name}` : old.name);
      } else {
        later.push(item);
      }
    }
    for (const [folder, parentId, parentDir] of later) {
      const base = folderBase(folder.name);
      const top = parentDir !== '' && !fits(parentDir, 'x'.repeat(CUT_MARK_CHARS + 1));
      const dir = top ? '' : parentDir;
      let name: string;
      if (top) {
        name = cutName(base, folder.id, MAX_FOLDER_NAME_CHARS);
        for (let attempt = 1; isTaken(dir, name); attempt++) {
          name = cutName(base, folder.id, MAX_FOLDER_NAME_CHARS, attempt);
        }
      } else {
        const plain =
          base.length > MAX_FOLDER_NAME_CHARS
            ? cutName(base, folder.id, MAX_FOLDER_NAME_CHARS)
            : base;
        name = uniqueName(plain, folder.id, (key) => takenIn(dir).has(key) || reserved(dir, key));
        if (!fits(dir, name)) {
          const max = MAX_DIR_CHARS - (dir ? dir.length + 1 : 0);
          name = cutName(base, folder.id, max);
          for (let attempt = 1; isTaken(dir, name); attempt++) {
            name = cutName(base, folder.id, max, attempt);
          }
        }
      }
      takenIn(dir).add(nameKey(name));
      out.set(folder.id, { parentId, base, name, top });
      dirs.set(folder.id, dir ? `${dir}/${name}` : name);
    }
    level = sorted.flatMap(([folder]) =>
      (children.get(folder.id) ?? []).map((child): [MirrorFolder, string | null, string] => [
        child,
        folder.id,
        dirs.get(folder.id)!,
      ]),
    );
  }
  return out;
}

/**
 * Each folder's path from the top of the repository (`Projects/Q3`), from
 * the names `assignFolders` gave (named afresh when none are given).
 */
export function folderDirs(
  folders: readonly MirrorFolder[],
  assigned: ReadonlyMap<string, FolderName> = assignFolders(folders, new Map()),
): Map<string, string> {
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  const dirs = new Map<string, string>();
  const dirOf = (id: string, depth: number): string | null => {
    const known = dirs.get(id);
    if (known !== undefined) return known;
    const name = assigned.get(id);
    const folder = byId.get(id);
    // A cycle the caller did not break, or folders this deep, are not real.
    if (!name || !folder || depth > 64) return null;
    const parent =
      name.top || folder.parentId === null || !byId.has(folder.parentId)
        ? ''
        : dirOf(folder.parentId, depth + 1);
    if (parent === null) return null;
    const dir = parent ? `${parent}/${name.name}` : name.name;
    dirs.set(id, dir);
    return dir;
  };
  for (const folder of folders) dirOf(folder.id, 0);
  return dirs;
}

/** A note's file: `<dir>/<name>.md`, or `<name>.md` at the top. */
export function notePath(dir: string, name: string): string {
  return dir ? `${dir}/${name}.md` : `${name}.md`;
}

/** What a note at `path` puts before `attachments/…` to reach the top-level folder. */
export function assetPrefix(path: string): string {
  return '../'.repeat(path.split('/').length - 1);
}
