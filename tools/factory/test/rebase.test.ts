import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { nodeExec } from '../src/exec.ts';
import { formatDecisions, numberText } from '../src/decisions.ts';
import {
  addedLines,
  applyRowChanges,
  branchNumbering,
  numberingOf,
  newRows,
  rebaseOntoMain,
  renumberingOf,
  resolveAppendConflicts,
  unpadRow,
} from '../src/rebase.ts';
import type { RunSandbox } from '../src/run.ts';

// Real git in a temp repository: main and a factory branch that both add decisions (F6).
const env: Record<string, string> = {
  PATH: process.env['PATH'] ?? '/usr/bin:/bin',
  HOME: tmpdir(),
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_TERMINAL_PROMPT: '0',
  GIT_AUTHOR_NAME: 'factory',
  GIT_AUTHOR_EMAIL: 'factory@example.com',
  GIT_COMMITTER_NAME: 'factory',
  GIT_COMMITTER_EMAIL: 'factory@example.com',
};

async function git(dir: string, ...args: string[]): Promise<string> {
  const r = await nodeExec('git', ['-C', dir, ...args], { env });
  if (r.code !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

const row = (n: number, text: string) => `| A${n} | ${text} |`;
const decisions = (rows: readonly string[]) =>
  [
    '# Decisions',
    '',
    '## Architecture decisions',
    '',
    '| ID    | Decision |',
    '| ----- | -------- |',
    ...rows,
    '',
    '## Working agreements',
    '',
    '| ID  | Agreement |',
    '| --- | --------- |',
    '| W1  | Autonomy. |',
    '',
  ].join('\n');
const BASE_ROWS = [row(1223, 'Proof in R2.'), row(1224, 'check:changed checks the change.')];
const BRANCH = 'factory/42-add-a-decision';

// Real git in temp repos: dozens of git processes per test, which a loaded Mac (W12) can stretch past vitest's 5 s default.
describe('rebaseOntoMain (F6)', { timeout: 30_000 }, () => {
  let repo: string;
  let reserved: string;
  let sandbox: RunSandbox;

  const write = (path: string, text: string) => {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), text);
  };
  const read = (path: string) => readFileSync(join(repo, path), 'utf8');
  const commit = async (message: string, files: Record<string, string>) => {
    for (const [path, text] of Object.entries(files)) write(path, text);
    await git(repo, 'add', '-A');
    await git(repo, 'commit', '-q', '-m', message);
  };
  /** main moves on: a commit on main, which the clone's origin/main then points at. */
  const mainMoves = async (message: string, files: Record<string, string>) => {
    await git(repo, 'checkout', '-q', 'main');
    await commit(message, files);
    await git(repo, 'update-ref', 'refs/remotes/origin/main', 'main');
    await git(repo, 'checkout', '-q', BRANCH);
  };

  beforeEach(async () => {
    const root = mkdtempSync(join(tmpdir(), 'factory-rebase-'));
    repo = join(root, 'repo');
    reserved = join(root, 'decision-numbers');
    await git(root, 'init', '-q', '-b', 'main', repo);
    await commit('base', {
      'docs/decisions.md': decisions(BASE_ROWS),
      'README.md': 'Penmoss\n',
      'tools/factory/src/a.ts': 'export const a = 1;\n',
    });
    await git(repo, 'update-ref', 'refs/remotes/origin/main', 'main');
    await git(repo, 'checkout', '-q', '-b', BRANCH);
    sandbox = {
      worktreePath: repo,
      exec: async (command) => {
        const r = await nodeExec('sh', ['-c', command], { cwd: repo, env });
        return { exitCode: r.code, stdout: r.stdout, stderr: r.stderr };
      },
      close: () => Promise.resolve(),
    };
  });

  const onMain = () =>
    git(repo, 'merge-base', '--is-ancestor', 'origin/main', BRANCH).then(
      () => true,
      () => false,
    );

  it("keeps both PRs' new decision rows, main's first, when both appended to the table", async () => {
    await commit('the agent', {
      'docs/decisions.md': decisions([...BASE_ROWS, row(1226, 'The branch decides.')]),
      'tools/factory/src/a.ts': 'export const a = 2; // A1226\n',
    });
    await commit('a second decision', {
      'docs/decisions.md': decisions([
        ...BASE_ROWS,
        row(1226, 'The branch decides.'),
        row(1227, 'And once more.'),
      ]),
    });
    await mainMoves('the first PR merges', {
      'docs/decisions.md': decisions([...BASE_ROWS, row(1225, 'Main decided first.')]),
    });

    const outcome = await rebaseOntoMain(sandbox, reserved);

    expect(outcome).toEqual({ kind: 'rebased', resolved: ['docs/decisions.md'], renumbered: {} });
    expect(read('docs/decisions.md')).toBe(
      decisions([
        ...BASE_ROWS,
        row(1225, 'Main decided first.'),
        row(1226, 'The branch decides.'),
        row(1227, 'And once more.'),
      ]),
    );
    expect(read('tools/factory/src/a.ts')).toBe('export const a = 2; // A1226\n');
    expect(await onMain()).toBe(true);
    expect(await git(repo, 'status', '--porcelain')).toBe('');
    expect(await git(repo, 'rev-list', '--count', `origin/main..${BRANCH}`)).toBe('2');
  });

  it('merges a table the branch re-padded for A-NEW-1, then formats it (PEN-70, A1250)', async () => {
    const base = await formatDecisions(decisions(BASE_ROWS));
    await mainMoves('formatted', { 'docs/decisions.md': base });
    await git(repo, 'checkout', '-q', BRANCH);
    await git(repo, 'reset', '-q', '--hard', 'main');
    // The agent's Prettier pads every row to fit the placeholder.
    const branch = await formatDecisions(decisions([...BASE_ROWS, '| A-NEW-1 | Tooltips wait. |']));
    expect(branch.split('\n').filter((l) => l.startsWith('| A1223 '))[0]).toContain('| A1223   |');
    await commit('the agent', { 'docs/decisions.md': branch });
    await mainMoves('main decides', {
      'docs/decisions.md': await formatDecisions(
        decisions([...BASE_ROWS, row(1225, 'Main decided meanwhile.')]),
      ),
    });

    const outcome = await rebaseOntoMain(sandbox, reserved);

    expect(outcome).toMatchObject({ kind: 'rebased', resolved: ['docs/decisions.md'] });
    expect(read('docs/decisions.md')).toBe(
      await formatDecisions(
        decisions([
          ...BASE_ROWS,
          row(1225, 'Main decided meanwhile.'),
          '| A-NEW-1 | Tooltips wait. |',
        ]),
      ),
    );
    expect(await onMain()).toBe(true);
    expect(await git(repo, 'status', '--porcelain')).toBe('');
  });

  it("replays the factory's own numbering commit onto rows main added meanwhile (PEN-71)", async () => {
    const base = await formatDecisions(decisions(BASE_ROWS));
    await mainMoves('formatted', { 'docs/decisions.md': base });
    await git(repo, 'checkout', '-q', BRANCH);
    await git(repo, 'reset', '-q', '--hard', 'main');
    // The agent's row, re-padded for the placeholder, and a line elsewhere that names it.
    await commit('the agent', {
      'docs/decisions.md': await formatDecisions(
        decisions([...BASE_ROWS, '| A-NEW-1 | Tooltips wait (see A-NEW-1). |']),
      ),
    });
    // The gate numbered it, and formatted the narrower table.
    await commit('Number the new decisions: A-NEW-1 is A1226', {
      'docs/decisions.md': await formatDecisions(
        decisions([...BASE_ROWS, row(1226, 'Tooltips wait (see A1226).')]),
      ),
    });
    // Meanwhile main took A1225, right where the branch's row is.
    await mainMoves('main decides', {
      'docs/decisions.md': await formatDecisions(
        decisions([...BASE_ROWS, row(1225, 'Main decided meanwhile.')]),
      ),
    });

    const outcome = await rebaseOntoMain(sandbox, reserved);

    expect(outcome).toMatchObject({ kind: 'rebased', resolved: ['docs/decisions.md'] });
    expect(read('docs/decisions.md')).toBe(
      await formatDecisions(
        decisions([
          ...BASE_ROWS,
          row(1225, 'Main decided meanwhile.'),
          row(1226, 'Tooltips wait (see A1226).'),
        ]),
      ),
    );
    expect(await onMain()).toBe(true);
    expect(await git(repo, 'status', '--porcelain')).toBe('');
  });

  it('applies a later edit of the numbered row, re-padded or not, row by row (PEN-121)', async () => {
    const base = await formatDecisions(decisions(BASE_ROWS));
    await mainMoves('formatted', { 'docs/decisions.md': base });
    await git(repo, 'checkout', '-q', BRANCH);
    await git(repo, 'reset', '-q', '--hard', 'main');
    // The agent's row, with every row re-padded for the placeholder.
    await commit('the agent', {
      'docs/decisions.md': await formatDecisions(
        decisions([...BASE_ROWS, '| A-NEW-1 | Tooltips wait. |']),
      ),
    });
    await commit('Number the new decisions: A-NEW-1 is A1226', {
      'docs/decisions.md': await formatDecisions(
        decisions([...BASE_ROWS, row(1226, 'Tooltips wait.')]),
      ),
    });
    // A later round edits the numbered row; its text is the widest, so every row is re-padded.
    const edited = row(1226, 'Tooltips wait half a second, then show, and stay while hovered.');
    await commit('the agent, round 2', {
      'docs/decisions.md': await formatDecisions(decisions([...BASE_ROWS, edited])),
    });
    // And edits it once more, at the same width.
    const again = row(1226, 'Tooltips wait half a second, then show, and stay while focused.');
    await commit('the agent, round 3', {
      'docs/decisions.md': await formatDecisions(decisions([...BASE_ROWS, again])),
    });
    // Meanwhile main took A1225, right where the branch's row is.
    await mainMoves('main decides', {
      'docs/decisions.md': await formatDecisions(
        decisions([...BASE_ROWS, row(1225, 'Main decided meanwhile.')]),
      ),
    });

    const outcome = await rebaseOntoMain(sandbox, reserved);

    expect(outcome).toEqual({ kind: 'rebased', resolved: ['docs/decisions.md'], renumbered: {} });
    expect(read('docs/decisions.md')).toBe(
      await formatDecisions(decisions([...BASE_ROWS, row(1225, 'Main decided meanwhile.'), again])),
    );
    expect(await onMain()).toBe(true);
    expect(await git(repo, 'status', '--porcelain')).toBe('');
    expect(await git(repo, 'rev-list', '--count', `origin/main..${BRANCH}`)).toBe('4');
  });

  it('renumbers a replayed row when main took its number meanwhile', async () => {
    const base = await formatDecisions(decisions(BASE_ROWS));
    await mainMoves('formatted', { 'docs/decisions.md': base });
    await git(repo, 'checkout', '-q', BRANCH);
    await git(repo, 'reset', '-q', '--hard', 'main');
    await commit('the agent', {
      'docs/decisions.md': await formatDecisions(
        decisions([...BASE_ROWS, '| A-NEW-1 | Tooltips wait (see A-NEW-1). |']),
      ),
    });
    await commit('Number the new decisions: A-NEW-1 is A1226', {
      'docs/decisions.md': await formatDecisions(
        decisions([...BASE_ROWS, row(1226, 'Tooltips wait (see A1226).')]),
      ),
    });
    await mainMoves('main decides', {
      'docs/decisions.md': await formatDecisions(
        decisions([...BASE_ROWS, row(1226, 'Main took this number.')]),
      ),
    });

    const outcome = await rebaseOntoMain(sandbox, reserved);

    expect(outcome).toMatchObject({ kind: 'rebased', renumbered: { A1226: 'A1227' } });
    expect(read('docs/decisions.md')).toBe(
      await formatDecisions(
        decisions([
          ...BASE_ROWS,
          row(1226, 'Main took this number.'),
          row(1227, 'Tooltips wait (see A1227).'),
        ]),
      ),
    );
  });

  it('still leaves an edit of the same row to the agent when the padding differs', async () => {
    await commit('the agent edits A1224', {
      'docs/decisions.md': decisions([row(1223, 'Proof in R2.'), row(1224, 'The branch says.')]),
    });
    await mainMoves('main edits A1224', {
      'docs/decisions.md': decisions([row(1223, 'Proof in R2.'), row(1224, 'Main says.')]),
    });
    const outcome = await rebaseOntoMain(sandbox, reserved);
    expect(outcome).toMatchObject({ kind: 'conflict', files: ['docs/decisions.md'] });
    expect(await git(repo, 'status', '--porcelain')).toBe('');
  });

  it("renumbers the branch's row, and its references, when main gave that number away", async () => {
    writeFileSync(reserved, '1225\n');
    await commit('the agent', {
      'docs/decisions.md': decisions([...BASE_ROWS, row(1225, 'The branch decides (A1225).')]),
      'tools/factory/src/a.ts': 'export const a = 2; // A1225, not A1224\n',
    });
    await mainMoves('Ryan merges a decision by hand', {
      'docs/decisions.md': decisions([...BASE_ROWS, row(1225, 'Ryan decided.')]),
      'README.md': 'Penmoss (A1225)\n',
    });

    const outcome = await rebaseOntoMain(sandbox, reserved);

    expect(outcome).toEqual({
      kind: 'rebased',
      resolved: ['docs/decisions.md'],
      renumbered: { A1225: 'A1226' },
    });
    expect(read('docs/decisions.md')).toBe(
      decisions([
        ...BASE_ROWS,
        row(1225, 'Ryan decided.'),
        row(1226, 'The branch decides (A1226).'),
      ]),
    );
    // Only what the branch wrote moves; main's mention of its own A1225 stays.
    expect(read('tools/factory/src/a.ts')).toBe('export const a = 2; // A1226, not A1224\n');
    expect(read('README.md')).toBe('Penmoss (A1225)\n');
    expect(readFileSync(reserved, 'utf8')).toBe('1226\n');
    expect(await git(repo, 'log', '-1', '--format=%s')).toBe(
      'Renumber the decisions main already has: A1225 is now A1226',
    );
    expect(await git(repo, 'status', '--porcelain')).toBe('');
  });

  it('keeps the number of a row the branch only edited', async () => {
    await commit('the agent amends a decision', {
      'docs/decisions.md': decisions([row(1223, 'Proof in R2, amended.'), BASE_ROWS[1]!]),
    });
    await mainMoves('main adds one', {
      'docs/decisions.md': decisions([...BASE_ROWS, row(1225, 'Main decided.')]),
    });
    expect(await rebaseOntoMain(sandbox, reserved)).toEqual({
      kind: 'rebased',
      resolved: [],
      renumbered: {},
    });
    expect(read('docs/decisions.md')).toBe(
      decisions([row(1223, 'Proof in R2, amended.'), BASE_ROWS[1]!, row(1225, 'Main decided.')]),
    );
  });

  it('aborts on a conflict in any other file and names it, leaving the branch as it was', async () => {
    await commit('the agent', {
      'docs/decisions.md': decisions([...BASE_ROWS, row(1226, 'The branch decides.')]),
      'README.md': 'Penmoss, the branch\n',
    });
    const before = await git(repo, 'rev-parse', BRANCH);
    await mainMoves('main edits the same line', {
      'docs/decisions.md': decisions([...BASE_ROWS, row(1225, 'Main decided first.')]),
      'README.md': 'Penmoss, main\n',
    });

    const outcome = await rebaseOntoMain(sandbox, reserved);

    expect(outcome.kind).toBe('conflict');
    if (outcome.kind !== 'conflict') return;
    expect(outcome.files).toEqual(['README.md', 'docs/decisions.md']);
    expect(outcome.output).toContain('CONFLICT (content): Merge conflict in README.md');
    expect(await git(repo, 'rev-parse', BRANCH)).toBe(before);
    expect(existsSync(join(repo, '.git', 'rebase-merge'))).toBe(false);
    expect(await git(repo, 'status', '--porcelain')).toBe('');
  });

  it('leaves an edit of the same decision row to the agent', async () => {
    await commit('the agent', {
      'docs/decisions.md': decisions([BASE_ROWS[0]!, row(1224, 'The branch says so.')]),
    });
    await mainMoves('main says otherwise', {
      'docs/decisions.md': decisions([BASE_ROWS[0]!, row(1224, 'Main says otherwise.')]),
    });
    const outcome = await rebaseOntoMain(sandbox, reserved);
    expect(outcome).toMatchObject({ kind: 'conflict', files: ['docs/decisions.md'] });
    expect(read('docs/decisions.md')).toBe(
      decisions([BASE_ROWS[0]!, row(1224, 'The branch says so.')]),
    );
  });

  it('is a plain rebase when nothing conflicts', async () => {
    await commit('the agent', { 'tools/factory/src/a.ts': 'export const a = 3;\n' });
    await mainMoves('main', { 'README.md': 'Penmoss 2\n' });
    expect(await rebaseOntoMain(sandbox, reserved)).toEqual({
      kind: 'rebased',
      resolved: [],
      renumbered: {},
    });
    expect(await onMain()).toBe(true);
  });
});

describe('resolveAppendConflicts', () => {
  const hunk = (ours: string[], base: string[], theirs: string[]) => [
    '<<<<<<< HEAD',
    ...ours,
    '||||||| parent of 1234abc (the agent)',
    ...base,
    '=======',
    ...theirs,
    '>>>>>>> 1234abc (the agent)',
  ];

  it('keeps main’s rows, then the branch’s, in every hunk', () => {
    const text = [
      '| A1 | a |',
      ...hunk(['| A2 | main |'], [], ['| A2 | branch |', '| A3 | branch |']),
      '',
      '| W1 | w |',
      ...hunk(['| W2 | main |'], [], ['| W3 | branch |']),
      '',
    ].join('\n');
    expect(resolveAppendConflicts(text)).toBe(
      [
        '| A1 | a |',
        '| A2 | main |',
        '| A2 | branch |',
        '| A3 | branch |',
        '',
        '| W1 | w |',
        '| W2 | main |',
        '| W3 | branch |',
        '',
      ].join('\n'),
    );
  });

  it('refuses an edit (a non-empty base), prose, a missing base or no conflict at all', () => {
    expect(
      resolveAppendConflicts(hunk(['| A2 | x |'], ['| A2 | old |'], ['| A2 | y |']).join('\n')),
    ).toBeNull();
    expect(resolveAppendConflicts(hunk(['| A2 | x |'], [], ['Some prose.']).join('\n'))).toBeNull();
    expect(resolveAppendConflicts(hunk([], [], ['| A2 | y |']).join('\n'))).toBeNull();
    expect(
      resolveAppendConflicts(
        ['<<<<<<< HEAD', '| A2 | x |', '=======', '| A3 | y |', '>>>>>>> b'].join('\n'),
      ),
    ).toBeNull();
    expect(resolveAppendConflicts('| A1 | a |\n')).toBeNull();
    expect(resolveAppendConflicts(['<<<<<<< HEAD', '| A2 | x |'].join('\n'))).toBeNull();
  });
});

describe('applyRowChanges (PEN-121)', () => {
  const table = (...rows: string[]) =>
    [
      '# D',
      '',
      '| ID | Decision |',
      '| --- | --- |',
      ...rows,
      '',
      '| ID | Agreement |',
      '| --- | --- |',
      '| W1 | w |',
      '',
    ].join('\n');
  const parent = table('| A1 | one |', '| A2 | two |');

  it("replaces an edited row by key, whatever either side's padding", () => {
    expect(
      applyRowChanges(
        table('| A1    | one   |', '| A2    | two   |', '| A3    | main  |'),
        parent,
        table('| A1      | one         |', '| A2      | two, edited |'),
      ),
    ).toBe(table('| A1    | one   |', '| A2      | two, edited |', '| A3    | main  |'));
  });

  it("adds rows after the commit's row before them, behind main's rows there", () => {
    const head = table('| A1 | one |', '| A2 | two |', '| A3 | main |');
    expect(
      applyRowChanges(
        head,
        parent,
        table('| A1 | one |', '| A2 | two |', '| A-NEW-1 | x |', '| A-NEW-2 | y |'),
      ),
    ).toBe(
      table('| A1 | one |', '| A2 | two |', '| A3 | main |', '| A-NEW-1 | x |', '| A-NEW-2 | y |'),
    );
    // A table's new first row goes before the row after it.
    expect(
      applyRowChanges(head, parent, table('| A0 | zero |', '| A1 | one |', '| A2 | two |')),
    ).toBe(table('| A0 | zero |', '| A1 | one |', '| A2 | two |', '| A3 | main |'));
  });

  it('drops a row the commit removed, and renames one by key', () => {
    const head = table('| A1 | one |', '| A-NEW-1 | x |', '| A2 | main |');
    expect(
      applyRowChanges(
        head,
        table('| A1 | one |', '| A-NEW-1 | x |'),
        table('| A1 | one |', '| A3 | x |'),
      ),
    ).toBe(table('| A1 | one |', '| A2 | main |', '| A3 | x |'));
  });

  it('refuses a row both sides changed, prose the commit changed, or a key used twice', () => {
    const head = table('| A1 | one |', '| A2 | main says |');
    expect(applyRowChanges(head, parent, table('| A1 | one |', '| A2 | branch says |'))).toBeNull();
    expect(applyRowChanges(head, parent, table('| A1 | one |'))).toBeNull();
    expect(applyRowChanges(head, parent, `${parent}More prose.\n`)).toBeNull();
    expect(applyRowChanges(head, parent, table('| A1 | one |', '| A1 | two |'))).toBeNull();
    // main removed the row the commit edits
    expect(
      applyRowChanges(table('| A1 | one |'), parent, table('| A1 | one |', '| A2 | 2 |')),
    ).toBeNull();
  });
});

describe('unpadRow', () => {
  it('takes the padding out of cells and separators, and leaves other lines alone', () => {
    expect(unpadRow('| A1223   | Proof in R2.      |')).toBe('| A1223 | Proof in R2. |');
    expect(unpadRow('| ------- | :---------------: |')).toBe('| --- | :---: |');
    expect(unpadRow('| A1 | a \\| b |')).toBe('| A1 | a \\| b |');
    expect(unpadRow('Prose | with a pipe')).toBe('Prose | with a pipe');
  });
});

describe('addedLines', () => {
  it('reads the new-file line ranges of each file from git diff -U0', () => {
    const diff = [
      'diff --git a/docs/decisions.md b/docs/decisions.md',
      '--- a/docs/decisions.md',
      '+++ b/docs/decisions.md',
      '@@ -8,0 +9,2 @@ x',
      '+| A1 | a |',
      '+| A2 | b |',
      'diff --git a/a.ts b/a.ts',
      '--- a/a.ts',
      '+++ b/a.ts',
      '@@ -1 +1 @@',
      '-x',
      '+y',
      '@@ -5,2 +4,0 @@',
      'diff --git a/gone.ts b/gone.ts',
      '--- a/gone.ts',
      '+++ /dev/null',
      '@@ -1 +0,0 @@',
    ].join('\n');
    expect(addedLines(diff)).toEqual(
      new Map([
        ['docs/decisions.md', new Set([9, 10])],
        ['a.ts', new Set([1])],
      ]),
    );
  });
});

describe('newRows (A1271)', () => {
  it("leaves out rows the agent's Prettier only re-padded, so their text isn't numbered", () => {
    // PEN-81 and PEN-82: the new row widened the table, every row read as added, and the
    // numbering rewrote `A-NEW-1` in A1248's text.
    const main = [
      '| ID    | Decision                         |',
      '| ----- | -------------------------------- |',
      '| A1248 | `A-NEW-1` is wider than the ID   |',
    ].join('\n');
    const branch = [
      '| ID      | Decision                         |',
      '| ------- | -------------------------------- |',
      '| A1248   | `A-NEW-1` is wider than the ID   |',
      '| A-NEW-1 | A new decision                   |',
    ].join('\n');
    expect([...newRows(branch, new Set([1, 2, 3, 4]), main)]).toEqual([4]);
  });
});

describe("the factory's numbering commit", () => {
  it('reads the numbers from its subject, and nothing from any other', () => {
    expect(numberingOf('Number the new decisions: A-NEW-1 is A1290, A-NEW-2 is A1291')).toEqual({
      'A-NEW-1': 'A1290',
      'A-NEW-2': 'A1291',
    });
    expect(numberingOf('Search: Folder lists every notebook')).toBeNull();
    expect(numberingOf('Number the new decisions: whatever')).toBeNull();
  });
});

describe('what the PR body calls each new decision', () => {
  it("follows the branch's numbering commits, then any renumbering after a later rebase", () => {
    expect(renumberingOf('Renumber the decisions main already has: A1301 is now A1303')).toEqual({
      A1301: 'A1303',
    });
    expect(renumberingOf('Number the new decisions: A-NEW-1 is A1301')).toBeNull();
    expect(
      branchNumbering([
        'Site: one DownloadButton',
        'Number the new decisions: A-NEW-1 is A1301, A-NEW-2 is A1302',
        'Renumber the decisions main already has: A1301 is now A1303',
        '',
      ]),
    ).toEqual({ 'A-NEW-1': 'A1303', 'A-NEW-2': 'A1302' });
    expect(branchNumbering(['Fix the typo'])).toEqual({});
  });

  it('replaces whole placeholders only', () => {
    const assigned = { 'A-NEW-1': 'A1303' };
    expect(numberText('A-NEW-1 amends A1220; A-NEW-10 and A-NEW-2 stay (A-NEW-1).', assigned)).toBe(
      'A1303 amends A1220; A-NEW-10 and A-NEW-2 stay (A1303).',
    );
  });
});
