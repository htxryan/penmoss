/**
 * The log scrubber (PEN-137, Local logs, AC14 and AC22): every canary of the canary notebook
 * (`test/fixtures/canary-notebook/canaries.json`) fed through it in the shapes a log line holds
 * them, and none survives, whether exact, in another case or URL-encoded. Then the cases Kotlin's
 * `ErrorScrub` replays, pinned in `apps/android/contract/scrub-v1.json`.
 *
 * After changing the scrubber, write the contract again:
 * `PENMOSS_WRITE_CONTRACTS=1 pnpm --filter @penmoss/core exec vitest run test/analytics-scrub`,
 * then `pnpm exec prettier --write apps/android/contract/scrub-v1.json`.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  createScrubber,
  MIN_KNOWN_NAME,
  PATH_SPACE_WORDS,
  scrubLogLine,
  type ScrubKnown,
} from '../src/analytics/scrub';

interface Canaries {
  readonly pattern: string;
  readonly notebook: string;
  readonly repository: string;
  readonly repositoryUrl: string;
  readonly branch: string;
  readonly login: string;
  readonly email: string;
  readonly token: string;
  readonly search: string;
  readonly notes: ReadonlyArray<{ readonly path: string; readonly title: string }>;
  readonly folders: readonly string[];
  readonly tags: readonly string[];
  readonly attachments: readonly string[];
  readonly links: readonly string[];
  readonly body: readonly string[];
  readonly strings: readonly string[];
}

const CANARIES = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../../../test/fixtures/canary-notebook/canaries.json', import.meta.url)),
    'utf8',
  ),
) as Canaries;

const c = CANARIES;
const [owner, repoName] = c.repository.split('/') as [string, string];

/** What scrub #1 knows when it writes a line: the login, the notebooks, their repositories. */
const KNOWN_1: ScrubKnown = {
  login: c.login,
  notebooks: [c.notebook],
  repositories: [c.repositoryUrl],
  branches: [c.branch, 'main'],
};

/** Scrub #2 adds the open notebooks' note titles and folder, tag and attachment names. */
const KNOWN_2: ScrubKnown = {
  ...KNOWN_1,
  names: [
    ...c.notes.map((note) => note.title),
    ...c.folders,
    ...c.tags,
    ...c.attachments,
    ...c.links,
  ],
};

/** Log lines that hold a canary scrub #1 must catch by its shape or because it knows it. */
const SHAPED_LINES: readonly string[] = [
  `2026-11-19T11:54:16.525Z info git push with ${c.token} failed`,
  `2026-11-19T11:54:16.525Z warn Authorization: Bearer ${c.token}`,
  `2026-11-19T11:54:16.525Z warn authorization=Bearer ${c.token.toLowerCase()}`,
  `2026-11-19T11:54:16.525Z warn header Bearer pangolincanaryBEARERvalue0123`,
  `fetch https://x-access-token:${c.token}@github.com/${c.repository}.git`,
  `token=${c.token} password=pangolincanary api_key: "slothcanary"`,
  `github_pat_11CANARY0000000000_pangolincanary000000000000 rejected`,
  `mail sent to ${c.email} and ${c.email.toUpperCase()}`,
  `clone ${c.repositoryUrl}`,
  `clone https://github.com/${c.repository}`,
  `clone https://GitHub.com/${owner.toUpperCase()}/${repoName}/tree/${c.branch}`,
  `clone git@github.com:${c.repository}.git (ssh)`,
  `clone git@github.com:${c.repository}`,
  `clone ssh://git@github.com/${c.repository}.git`,
  `clone git://example.org/${c.repository}.git`,
  `clone https://git.example.org/${c.repository}.git`,
  `pull from ${c.repository} on ${c.branch}`,
  `remote origin ${repoName}`,
  `signed in as ${c.login} (${c.login.toUpperCase()})`,
  `https://github.com/${c.login}`,
  `notebook ${c.notebook} synced; ${c.notebook.toLowerCase()} again`,
  `open /Users/${c.login}/Notes/${encodeURIComponent(c.notes[0]!.title)}.md`,
  `open /Users/someone/Notes/Okapicanary-Folder/pangolincanary.md`,
  `open ~/Documents/zebracanary.md`,
  `open $HOME/slothcanary/x.md and %USERPROFILE%\\slothcanary\\y.md`,
  `open C:\\Users\\slothcanary\\Notes\\x.md`,
  `open file:///Users/x/pangolincanary.md`,
  `wrote /private/var/folders/xy/pangolincanary/T/a.tmp`,
  `wrote /home/slothcanary/.penmoss/analytics.json`,
  `wrote /Volumes/External/pangolincanary`,
  `note "${c.notes[0]!.title}" saved`,
  `note “${c.notes[1]!.title}” saved`,
  `note ‘${c.folders[0]}’ moved and 'pangolincanary' too and \`slothcanary\``,
  `search https://penmoss.app/search?q=${c.search}&page=2`,
  `search https://penmoss.app/?q=${encodeURIComponent(c.notebook)}#${c.search}`,
  `search https://penmoss.app#pangolincanary`,
  `docs https://penmoss.app/docs/pangolincanary/page`,
  `id 01JB7Q3V6M8K2T9RZ4XN5C1HPD and 01jb7q3v6m8k2t9rz4xn5c1hpd`,
  `id 5c0e8f6a-1b2c-4d3e-8f90-a1b2c3d4e5f6 and 5C0E8F6A-1B2C-4D3E-8F90-A1B2C3D4E5F6`,
  `id 5c0e8f6a12b4c6d8e0f2a4b6c8d0e27a96 commit 3f9a2c1d7e8b`,
  `-----BEGIN CANARY BLOCK-----\npangolincanary\n-----END CANARY BLOCK-----`,
];

/** Lines only scrub #2 can clean: names it is told of. */
const NAMED_LINES: readonly string[] = [
  `opened ${c.notes[0]!.title}`,
  `linked to ${c.links[0]} from ${c.notes[2]!.title.toUpperCase()}`,
  `moved into ${c.folders[0]}`,
  `tagged #${c.tags[0]}`,
  `attached ${c.attachments[0]}`,
];

/** The canary words: each canary's own word(s) with `canary` in them. */
const WORDS = [
  ...new Set(
    c.strings.flatMap((value) =>
      value.split(/[^A-Za-z0-9_-]+/).filter((word) => word.toLowerCase().includes(c.pattern)),
    ),
  ),
];

function leaks(text: string): string[] {
  const lower = text.toLowerCase();
  const decoded = (() => {
    try {
      return decodeURIComponent(text).toLowerCase();
    } catch {
      return lower;
    }
  })();
  const found = c.strings.filter((value) => {
    const want = value.toLowerCase();
    return (
      lower.includes(want) ||
      decoded.includes(want) ||
      lower.includes(encodeURIComponent(value).toLowerCase())
    );
  });
  // Any word of a canary at all, which covers every encoding that keeps letters.
  if (lower.includes(c.pattern)) found.push(`…${c.pattern}… in ${text}`);
  return found;
}

describe('the canary notebook', () => {
  it('lists every canary it uses, each with the canary word', () => {
    expect(c.strings.every((value) => value.toLowerCase().includes(c.pattern))).toBe(true);
    const fields = [
      c.notebook,
      c.repository,
      c.branch,
      c.login,
      c.email,
      c.token,
      c.search,
      ...c.notes.map((note) => note.title),
      ...c.folders,
      ...c.tags,
      ...c.attachments,
      ...c.links,
      ...c.body,
    ];
    expect(fields.filter((value) => !c.strings.includes(value))).toEqual([]);
    expect(WORDS.length).toBeGreaterThan(10);
  });
});

describe('scrub #1 (written to the log)', () => {
  it('leaves no canary in any line, in any case or encoding', () => {
    const scrub = createScrubber(KNOWN_1);
    const out = SHAPED_LINES.map((line) => scrub.line(line));
    expect(out.flatMap(leaks)).toEqual([]);
  });

  it('replaces values and keeps the line readable', () => {
    expect(scrubLogLine(`git push with ${c.token} failed`)).toBe('git push with ‹token› failed');
    expect(scrubLogLine(`mail sent to ${c.email}`)).toBe('mail sent to ‹email›');
    expect(scrubLogLine('Authorization: Bearer abcdefgh12345678')).toBe(
      'Authorization: Bearer ‹token›',
    );
    expect(scrubLogLine('open ~/Documents/a.md now')).toBe('open ‹path› now');
    expect(scrubLogLine('open /Users/x/Notes/a.md now')).toBe('open ‹path› now');
    expect(scrubLogLine('note "My Plans" saved')).toBe('note ‹text› saved');
    expect(scrubLogLine('see https://penmoss.app/docs/x?y=1#z')).toBe(
      'see https://penmoss.app/‹path›',
    );
    expect(scrubLogLine('see https://penmoss.app?y=1')).toBe('see https://penmoss.app');
    expect(scrubLogLine('status 503 after 10 s')).toBe('status 503 after 10 s');
  });

  it('numbers repositories and ids stably within one scrubber', () => {
    const scrub = createScrubber(KNOWN_1);
    const lines = [
      `clone ${c.repositoryUrl}`,
      'clone https://github.com/other-owner/other-repo',
      `fetch git@github.com:${c.repository}.git`,
      `push https://github.com/${c.repository}`,
      'note 01JB7Q3V6M8K2T9RZ4XN5C1HPD',
      'note 01JB7Q3V6M8K2T9RZ4XN5C1HPE',
      'again 01JB7Q3V6M8K2T9RZ4XN5C1HPD',
    ].map((line) => scrub.line(line));
    expect(lines).toEqual([
      'clone ‹repo-1›',
      'clone ‹repo-2›',
      'fetch ‹repo-1›',
      'push ‹repo-1›',
      'note ‹id-1›',
      'note ‹id-2›',
      'again ‹id-1›',
    ]);
    // A fresh scrubber starts again at 1.
    expect(scrubLogLine('clone https://github.com/other-owner/other-repo')).toBe('clone ‹repo-1›');
  });

  it('replaces ids in either case, and paths in a list', () => {
    expect(scrubLogLine('id 01JB7Q3V6M8K2T9RZ4XN5C1HPD and 01jb7q3v6m8k2t9rz4xn5c1hpd')).toBe(
      'id ‹id-1› and ‹id-1›',
    );
    expect(scrubLogLine('PATH /usr/local/bin:/opt/homebrew/bin')).toBe('PATH ‹path›:‹path›');
  });

  it('takes the spaces in a path’s folder and file names, and leaves the words after it', () => {
    expect(scrubLogLine('/Users/a/b c.md')).toBe('‹path›');
    expect(scrubLogLine('open /Users/a/My Notes/b c.md failed')).toBe('open ‹path› failed');
    expect(scrubLogLine('cd /Users/a/Library/Application Support/Penmoss/logs now')).toBe(
      'cd ‹path› now',
    );
    expect(scrubLogLine('C:\\Users\\a\\My Notes\\b c.txt done')).toBe('‹path› done');
    expect(scrubLogLine('~/My Notes/x y.md ok')).toBe('‹path› ok');
    // A path that ends in an extension ends there; words with no / and no extension stay.
    expect(scrubLogLine('/Users/a/b.md and c.txt')).toBe('‹path› and c.txt');
    expect(scrubLogLine('wrote /Users/a/x.json in 3 ms')).toBe('wrote ‹path› in 3 ms');
    expect(scrubLogLine('/Users/a/b c')).toBe('‹path› c');
    // Two paths are never joined, and a delimiter or more than PATH_SPACE_WORDS words stop it.
    expect(scrubLogLine('/Users/a/x copied to /Users/b/y')).toBe('‹path› copied to ‹path›');
    expect(scrubLogLine('/Users/a/dir not found, see log.txt')).toBe(
      '‹path› not found, see log.txt',
    );
    expect(PATH_SPACE_WORDS).toBe(3);
    expect(scrubLogLine('read /Users/a/notes dir failed to open file.md')).toBe(
      'read ‹path› dir failed to open file.md',
    );
  });

  it('numbers notebooks by the order it was told them', () => {
    const scrub = createScrubber({ notebooks: ['Work Notes', 'Home'] });
    expect(scrub.line('synced Home and Work Notes, then work notes')).toBe(
      'synced ‹notebook-2› and ‹notebook-1›, then ‹notebook-1›',
    );
  });

  it('ignores known names shorter than the minimum, which would eat ordinary words', () => {
    expect(MIN_KNOWN_NAME).toBe(3);
    expect(scrubLogLine('an ok line', { login: 'ok', notebooks: ['an'] })).toBe('an ok line');
  });

  it('replaces branches it knows, but never main or master', () => {
    expect(scrubLogLine('pull main then dev-x', { branches: ['main', 'dev-x', 'master'] })).toBe(
      'pull main then ‹branch›',
    );
  });

  it('matches known names as whole words only', () => {
    expect(scrubLogLine('home homework', { notebooks: ['home'] })).toBe('‹notebook-1› homework');
  });

  it('makes one line of a value that holds a line break', () => {
    expect(scrubLogLine('first\nsecond\r\nthird')).toBe('first second third');
    expect(createScrubber().text('first "a"\nsecond "b"')).toBe('first ‹text›\nsecond ‹text›');
  });
});

describe('scrub #2 (before a report or a shared file leaves)', () => {
  it('also replaces the open notebooks’ names', () => {
    const scrub = createScrubber(KNOWN_2);
    const out = [...SHAPED_LINES, ...NAMED_LINES].map((line) => scrub.line(line));
    expect(out.flatMap(leaks)).toEqual([]);
    expect(scrub.line(`opened ${c.notes[0]!.title}`)).toBe('opened ‹name›');
  });

  it('is idempotent: scrubbing a scrubbed line changes nothing', () => {
    const once = createScrubber(KNOWN_2);
    const twice = createScrubber(KNOWN_2);
    for (const line of [...SHAPED_LINES, ...NAMED_LINES]) {
      const first = once.line(line);
      expect(twice.line(first)).toBe(first);
    }
  });
});

// The contract Kotlin's ErrorScrub replays.

const CONTRACT = fileURLToPath(
  new URL('../../../apps/android/contract/scrub-v1.json', import.meta.url),
);

interface ScrubCase {
  readonly name: string;
  readonly known: ScrubKnown;
  /** Lines fed to one scrubber in order (numbering carries from one to the next). */
  readonly input: readonly string[];
  readonly expected: readonly string[];
}

interface ScrubContract {
  readonly $comment: string;
  readonly version: 1;
  readonly minKnownName: number;
  readonly cases: readonly ScrubCase[];
}

const CASE_INPUTS: ReadonlyArray<Omit<ScrubCase, 'expected'>> = [
  { name: 'canaries, scrub #1', known: KNOWN_1, input: SHAPED_LINES },
  { name: 'canaries, scrub #2', known: KNOWN_2, input: [...SHAPED_LINES, ...NAMED_LINES] },
  {
    name: 'tokens',
    known: {},
    input: [
      'ghp_abcdefgh12345678 gho_abcdefgh12345678 ghs_abcdefgh12345678',
      'github_pat_11ABCDEFG0123456789_abcdefghij',
      'pm_abcdefghijklmnop1234 sk-abcdefghijklmnop1234',
      'xoxb-1234567890-abcdef AKIAAAAAAAAAAAAAAAAA',
      'jwt eyJhbGciOiJI.eyJzdWIiOiIx.SflKxwRJSMeK',
      'Basic dXNlcjpwYXNzd29yZA== and token abcdefgh12345678',
      'password: hunter22 secret=abc refresh_token="xyz" private-key=k1',
      'ghp_short stays',
    ],
  },
  {
    name: 'urls',
    known: {},
    input: [
      'https://github.com/owner/repo/pull/12',
      'https://github.com/owner',
      'https://gitlab.com/group/project.git',
      'https://user:pass@example.com/a/b?c=d#e',
      'http://localhost:8787/v1/batch',
      'https://example.com',
      'https://example.com?q=x',
      'git://host/owner/repo',
      'file:///etc/hosts',
      'git@bitbucket.org:team/repo.git',
      'ssh://git@host:22/owner/repo.git',
    ],
  },
  {
    name: 'paths',
    known: {},
    input: [
      '/Users/a/b c.md',
      '~/x/y and ~ alone',
      '/tmp/a:/opt/b',
      'C:\\Users\\a\\b.txt',
      'not/a/path and /api/v1 stays',
      '(/var/log/x.log)',
    ],
  },
  {
    name: 'paths with spaces',
    known: {},
    input: [
      'open /Users/a/My Notes/b c.md failed',
      '/Users/a/Work Notes/Plans for Q3.md saved',
      'cd /Users/a/Library/Application Support/Penmoss/logs now',
      'C:\\Users\\a\\My Notes\\b c.txt done',
      '~/My Notes/x y.md ok',
      '/Users/a/b c',
      '/Users/a/b.md and c.txt',
      '/Users/a/x copied to /Users/b/y',
      'read /Users/a/notes dir failed to open file.md',
      '/Users/a/dir not found, see log.txt',
      'wrote /Users/a/x.json in 3 ms',
    ],
  },
  {
    name: 'quoted text',
    known: {},
    input: ['"double" “curly” ‘single’ \'plain\' `code`', 'it’s fine', 'an "unclosed quote'],
  },
  {
    name: 'ids',
    known: {},
    input: [
      '01JB7Q3V6M8K2T9RZ4XN5C1HPD 01JB7Q3V6M8K2T9RZ4XN5C1HPD',
      '5c0e8f6a-1b2c-4d3e-8f90-a1b2c3d4e5f6',
      'abcdef123456 and 123456789012 and abcdefabcdef',
      'sha 3f9a2c1d7e8b4a6c',
    ],
  },
  {
    name: 'known names',
    known: {
      login: 'octo-cat',
      notebooks: ['Work', 'Work Notes'],
      repositories: ['https://github.com/octo-cat/notes.git', 'acme/handbook'],
      branches: ['main', 'release-q3'],
      names: ['Q3 Plan', 'ab'],
    },
    input: [
      'octo-cat pushed to octo-cat/notes and acme/handbook',
      'Work Notes and Work synced',
      'opened Q3 Plan, not ab',
      'the handbook repo and acme',
      'pushed release-q3, then main',
    ],
  },
];

const CONTRACT_COMMENT =
  'Kotlin’s ErrorScrub follows core’s scrubLogLine (packages/core/src/analytics/scrub.ts, PEN-137): for each case, one scrubber made with `known` turns each line of `input` into the same line of `expected` (numbering carries from line to line). Known names shorter than `minKnownName` are ignored. Written and checked by packages/core/test/analytics-scrub.test.ts.';

function contract(): ScrubContract {
  return {
    $comment: CONTRACT_COMMENT,
    version: 1,
    minKnownName: MIN_KNOWN_NAME,
    cases: CASE_INPUTS.map((each) => {
      const scrub = createScrubber(each.known);
      return { ...each, expected: each.input.map((line) => scrub.line(line)) };
    }),
  };
}

if (process.env['PENMOSS_WRITE_CONTRACTS'] === '1') {
  writeFileSync(CONTRACT, `${JSON.stringify(contract(), null, 2)}\n`);
}

describe('apps/android/contract/scrub-v1.json', () => {
  const stored = JSON.parse(readFileSync(CONTRACT, 'utf8')) as ScrubContract;

  it('holds what the scrubber does today', () => {
    expect(stored).toEqual(contract());
  });

  it('leaves no canary in any expected line', () => {
    const canaryCases = stored.cases.filter((each) => each.name.startsWith('canaries'));
    expect(canaryCases).toHaveLength(2);
    expect(canaryCases.flatMap((each) => each.expected.flatMap(leaks))).toEqual([]);
  });
});
