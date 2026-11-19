/**
 * The log scrubber (PEN-137, Local logs): every line the app logs is scrubbed when it is written
 * (scrub #1) and again before it leaves in a bug report or a shared file (scrub #2, which also
 * knows the open notebooks' note titles and folder, tag and attachment names). Values are
 * replaced, not trimmed:
 *
 * - tokens, bearer values, keys → ‹token›; emails → ‹email›;
 * - repository URLs → ‹repo-N›; any other URL keeps its scheme and host, never its path, query
 *   or fragment;
 * - the GitHub login → ‹login›; notebook names → ‹notebook-N›; names known to scrub #2 → ‹name›;
 * - absolute and home paths → ‹path›;
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
const KEY_VALUE =
  /\b(password|passwd|secret|token|access_token|refresh_token|api[_-]?key|authorization|private[_-]?key)(["']?\s*[:=]\s*["']?)[^\s"',;&]+/gi;
const PEM = /-----BEGIN [A-Z ]+-----[\s\S]*?(?:-----END [A-Z ]+-----|$)/g;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
/** git@host:owner/repo(.git) and ssh://… */
const SSH_REPO = /\b(?:ssh:\/\/)?[A-Za-z0-9_.-]+@[A-Za-z0-9.-]+[:/][A-Za-z0-9_.~/-]+?(?:\.git)?\b/g;
/** Any http(s) or git URL. */
const URL = /\b(https?|git|file):\/\/[^\s"'<>()[\]{}]+/g;
const QUOTED = /"[^"\n]{1,400}"|“[^”\n]{1,400}”|‘[^’\n]{1,400}’|'[^'\n]{1,400}'|`[^`\n]{1,400}`/g;
/** Absolute paths (Unix, home, Windows); a path runs to whitespace or a closing delimiter. */
const PATH =
  /(?:~|\$HOME|%USERPROFILE%)(?:[/\\][^\s"'<>|:;,)\]}]*)?|(?<![\w.:/])\/(?:Users|home|private|var|tmp|Volumes|opt|data|storage|sdcard|mnt|etc|root|Library|Applications|System|usr)(?:\/[^\s"'<>|:;,)\]}]*)*|\b[A-Za-z]:\\[^\s"'<>|:;,)\]}]*/g;
const ULID = /\b[0-7][0-9A-HJKMNP-TV-Z]{25}\b/g;
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
    out = out.replace(PATH, '‹path›');
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
