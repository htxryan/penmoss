/**
 * The log scrubber (PEN-137, Local logs): every line the app logs is scrubbed when it is written
 * (scrub #1) and again before it leaves in a bug report or a shared file (scrub #2, which also
 * knows the open notebooks' note titles and folder, tag and attachment names). Values are
 * replaced, not trimmed:
 *
 * - tokens, bearer values, keys → ‹token›; emails → ‹email›;
 * - repository URLs → ‹repo-N›; any other URL keeps its scheme and host, never its path, query
 *   or fragment;
 * - the GitHub login → ‹login›; notebook names → ‹notebook-N›; their branches → ‹branch›; names
 *   known to scrub #2 → ‹name›;
 * - absolute and home paths → ‹path›, with the spaces in a folder's or a file's name (below);
 * - quoted text → ‹text›;
 * - ULIDs, UUIDs and long hex ids → ‹id-N›.
 *
 * N is stable within one scrubber, so a log still shows that two lines name the same repository.
 * Kotlin's `ErrorScrub` follows the same cases (`apps/android/contract/scrub-v1.json`).
 */

export interface ScrubKnown {
  /** The GitHub login signed in. */
  readonly login?: string | null | undefined;
  /** The notebooks' names. */
  readonly notebooks?: readonly string[] | undefined;
  /** Their repositories' URLs or `owner/name`s. */
  readonly repositories?: readonly string[] | undefined;
  /** Their branches' names (a default `main` or `master` is left alone). */
  readonly branches?: readonly string[] | undefined;
  /** Scrub #2: note titles, folder, tag and attachment names in the open notebooks. */
  readonly names?: readonly string[] | undefined;
}

const TOKENS: readonly RegExp[] = [
  /\b(?:gh[pousr]_[A-Za-z0-9]{8,}|github_pat_[A-Za-z0-9_]{20,})\b/g,
  /\bpm_[A-Za-z0-9_-]{16,}\b/g,
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
];
const BEARER = /\b(Bearer|Basic|token)\s+[A-Za-z0-9._~+/=-]{8,}/gi;
/** A secret's key and its value; a value already replaced, or a scheme BEARER handles, is left. */
const KEY_VALUE =
  /\b(password|passwd|secret|token|access_token|refresh_token|api[_-]?key|authorization|private[_-]?key)(["']?\s*[:=]\s*["']?)(?!‹|(?:Bearer|Basic|token)\s)[^\s"',;&]+/gi;
const PEM = /-----BEGIN [A-Z ]+-----[\s\S]*?(?:-----END [A-Z ]+-----|$)/g;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
/** git@host:owner/repo(.git) and ssh://… */
const SSH_REPO =
  /\b(?:ssh:\/\/)?[A-Za-z0-9_.-]+@[A-Za-z0-9.-]+[:/][A-Za-z0-9_.~/-]*[A-Za-z0-9_~/-]/g;
/** Any http(s) or git URL. */
const URL = /\b(https?|git|file):\/\/[^\s"'<>()[\]{}]+/g;
const QUOTED = /"[^"\n]{1,400}"|“[^”\n]{1,400}”|‘[^’\n]{1,400}’|'[^'\n]{1,400}'|`[^`\n]{1,400}`/g;
/** Absolute paths (Unix, home, Windows); a path runs to whitespace or a closing delimiter. */
const PATH =
  /(?:~|\$HOME|%USERPROFILE%)(?:[/\\][^\s"'<>|:;,)\]}]*)?|(?<![\w./])\/(?:Users|home|private|var|tmp|Volumes|opt|data|storage|sdcard|mnt|etc|root|Library|Applications|System|usr)(?:\/[^\s"'<>|:;,)\]}]*)*|\b[A-Za-z]:\\[^\s"'<>|:;,)\]}]*/g;
/**
 * A path with spaces (`/Users/a/My Notes/b c.md`): PATH stops at the first space, so the words
 * after it are read on, a few at a time, while the path so far has no file extension. Of the next
 * PATH_SPACE_WORDS words (each one space, then no space or delimiter), the first that holds a
 * `/` or `\` (`Notes/b`) or ends in an extension (`c.md`) ends the stretch taken, with every word
 * before it; then it looks again. A word that starts another path (`/`, `\`, `~`, `$HOME`,
 * `%USERPROFILE%`, `C:\`) stops it: two paths are never joined. Words that hold neither are left
 * (`/Users/a/b c` keeps ` c`), so a path's ordinary following words stay.
 */
export const PATH_SPACE_WORDS = 3;
const PATH_WORDS = new RegExp(`^(?: [^\\s"'<>|:;,)\\]}]+){1,${PATH_SPACE_WORDS}}`);
const PATH_START = /^(?:[/\\~]|\$HOME|%USERPROFILE%|[A-Za-z]:\\)/;
const EXTENSION = /\.[A-Za-z][A-Za-z0-9]{0,7}$/;
const SEPARATOR = /[/\\]/;

/** Where the path PATH found at `start`…`end` really ends, its spaced words read on. */
function pathEnd(text: string, start: number, end: number): number {
  let at = end;
  while (!EXTENSION.test(text.slice(start, at))) {
    const words = PATH_WORDS.exec(text.slice(at))?.[0].slice(1).split(' ') ?? [];
    let taken = -1;
    for (const [index, word] of words.entries()) {
      if (PATH_START.test(word)) break;
      if (SEPARATOR.test(word) || EXTENSION.test(word)) {
        taken = index;
        break;
      }
    }
    if (taken < 0) break;
    at += words.slice(0, taken + 1).reduce((length, word) => length + 1 + word.length, 0);
  }
  return at;
}

/** Every path in `text` → ‹path›, with its spaced words (pathEnd). */
function replacePaths(text: string): string {
  let out = '';
  let from = 0;
  for (const match of text.matchAll(PATH)) {
    const start = match.index;
    if (start < from) continue;
    out += `${text.slice(from, start)}‹path›`;
    from = pathEnd(text, start, start + match[0].length);
  }
  return out + text.slice(from);
}

const ULID = /\b[0-7][0-9A-HJKMNP-TV-Z]{25}\b/gi;
const UUID = /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g;
const HEX_ID = /\b(?=[0-9a-f]*[a-f])(?=[0-9a-f]*\d)[0-9a-f]{12,}\b/gi;
/** A git notebook's repository as `owner/name`, when it is known. */
const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function wholeWord(name: string): RegExp {
  return new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRegExp(name)}(?![\\p{L}\\p{N}_])`, 'giu');
}

/** The shortest name scrubbed as a known name; shorter ones would eat ordinary words. */
export const MIN_KNOWN_NAME = 3;

export interface Scrubber {
  /** One line, scrubbed. */
  line(text: string): string;
  /** Many lines (a whole report), scrubbed. */
  text(text: string): string;
}

function repoKey(value: string): string {
  return value
    .toLowerCase()
    .replace(/^(?:https?|git|ssh):\/\/(?:[^@/]+@)?/, '')
    .replace(/^[^@]+@/, '')
    .replace(/:/, '/')
    .replace(/\.git$/, '')
    .replace(/\/+$/, '');
}

/** A scrubber that numbers what it replaces consistently. */
export function createScrubber(known: ScrubKnown = {}): Scrubber {
  const repos = new Map<string, number>();
  const ids = new Map<string, number>();
  const repoLabel = (value: string): string => {
    const key = repoKey(value);
    let n = repos.get(key);
    if (n === undefined) {
      n = repos.size + 1;
      repos.set(key, n);
    }
    return `‹repo-${n}›`;
  };
  const idLabel = (value: string): string => {
    const key = value.toLowerCase();
    let n = ids.get(key);
    if (n === undefined) {
      n = ids.size + 1;
      ids.set(key, n);
    }
    return `‹id-${n}›`;
  };
  const usable = (values: readonly (string | null | undefined)[] | undefined): string[] =>
    [...new Set((values ?? []).map((value) => (value ?? '').trim()))]
      .filter((value) => value.length >= MIN_KNOWN_NAME)
      .sort((a, b) => b.length - a.length);
  const repositories = usable(known.repositories);
  // owner/name of each repository, matched as text too.
  const repoNames = repositories.map((repo) => repoKey(repo).split('/').slice(-2).join('/'));
  const repoOwners = repositories
    .map((repo) => repoKey(repo).split('/').slice(-2)[0] ?? '')
    .filter((owner) => owner.length >= MIN_KNOWN_NAME);
  const repoBare = repositories
    .map((repo) => repoKey(repo).split('/').slice(-1)[0] ?? '')
    .filter((name) => name.length >= MIN_KNOWN_NAME);
  const notebooks = usable(known.notebooks);
  const branches = usable(known.branches).filter(
    (name) => !['main', 'master'].includes(name.toLowerCase()),
  );
  const login = usable([known.login]);
  const names = usable(known.names);
  const notebookNumber = new Map(notebooks.map((name, index) => [name.toLowerCase(), index + 1]));
  const known_patterns: ReadonlyArray<readonly [RegExp, (match: string) => string]> = [
    ...[...new Set(repoNames)]
      .filter((name) => name.includes('/'))
      .map((name) => [wholeWord(name), (match: string) => repoLabel(match)] as const),
    ...notebooks.map(
      (name) =>
        [
          wholeWord(name),
          (match: string) => `‹notebook-${notebookNumber.get(match.toLowerCase()) ?? 0}›`,
        ] as const,
    ),
    ...login.map((name) => [wholeWord(name), () => '‹login›'] as const),
    ...[...new Set([...repoOwners, ...repoBare])].map(
      (name) => [wholeWord(name), () => '‹repo›'] as const,
    ),
    ...branches.map((name) => [wholeWord(name), () => '‹branch›'] as const),
    ...names.map((name) => [wholeWord(name), () => '‹name›'] as const),
  ];

  const line = (text: string): string => {
    let out = text.replace(/[\r\n]+/g, ' ');
    out = out.replace(PEM, '‹token›');
    for (const pattern of TOKENS) out = out.replace(pattern, '‹token›');
    out = out.replace(BEARER, (_match, scheme: string) => `${scheme} ‹token›`);
    out = out.replace(KEY_VALUE, (_match, key: string, sep: string) => `${key}${sep}‹token›`);
    out = out.replace(URL, (match, scheme: string) => {
      const rest = match.slice(scheme.length + 3);
      if (scheme === 'file') return '‹path›';
      const hostEnd = rest.search(/[/?#]/);
      const authority = hostEnd === -1 ? rest : rest.slice(0, hostEnd);
      const host = authority.replace(/^[^@]*@/, '');
      const path = hostEnd === -1 ? '' : rest.slice(hostEnd);
      const segments = path.split(/[?#]/)[0]!.split('/').filter(Boolean);
      // A repository's URL: a code host, or any URL ending .git.
      const codeHost = /(^|\.)(github\.com|gitlab\.com|bitbucket\.org|codeberg\.org)$/i.test(host);
      if (
        scheme === 'git' ||
        /\.git$/i.test(segments.at(-1) ?? '') ||
        (codeHost && segments.length >= 2)
      ) {
        return repoLabel(`${host}/${segments.slice(0, 2).join('/')}`);
      }
      return segments.length > 0 ? `${scheme}://${host}/‹path›` : `${scheme}://${host}`;
    });
    out = out.replace(SSH_REPO, (match) => (match.includes('@') ? repoLabel(match) : match));
    out = out.replace(EMAIL, '‹email›');
    for (const [pattern, replace] of known_patterns) out = out.replace(pattern, replace);
    out = replacePaths(out);
    out = out.replace(QUOTED, '‹text›');
    out = out.replace(UUID, idLabel);
    out = out.replace(ULID, idLabel);
    out = out.replace(HEX_ID, idLabel);
    return out;
  };
  return {
    line,
    text: (text) => text.split(/\r?\n/).map(line).join('\n'),
  };
}

/** One line scrubbed (a fresh scrubber, so numbering starts at 1). */
export function scrubLogLine(text: string, known: ScrubKnown = {}): string {
  return createScrubber(known).line(text);
}
