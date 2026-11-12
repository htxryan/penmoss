import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  carriedOver,
  diffPrint,
  findProven,
  parseProven,
  PROVEN,
  provenRuns,
  validationKey,
  type Proven,
  type Wanted,
} from '../src/carry.ts';
import { nodeExec } from '../src/exec.ts';
import { hostDeps } from '../src/host.ts';
import { rebaseOntoMain } from '../src/rebase.ts';
import type { RunSandbox } from '../src/run.ts';
import { testConfig } from './helpers.ts';

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

const decisions = (rows: readonly string[]) =>
  [
    '# Decisions',
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
const BASE = ['| A1305 | Proof in R2. |'];
const BRANCH = 'factory/63-whats-new';

// Real git in temp repos: dozens of git processes per test, which a loaded Mac (W12) can stretch past vitest's 5 s default.
describe("the print of the branch's own diff (PEN-63)", { timeout: 30_000 }, () => {
  let repo: string;
  let sandbox: RunSandbox;

  const commit = async (message: string, files: Record<string, string>) => {
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(repo, path)), { recursive: true });
      writeFileSync(join(repo, path), text);
    }
    await git(repo, 'add', '-A');
    await git(repo, 'commit', '-q', '-m', message);
  };
  const mainMoves = async (message: string, files: Record<string, string>) => {
    await git(repo, 'checkout', '-q', 'main');
    await commit(message, files);
    await git(repo, 'update-ref', 'refs/remotes/origin/main', 'main');
    await git(repo, 'checkout', '-q', BRANCH);
  };
  const rebased = async () => {
    const out = await rebaseOntoMain(sandbox, join(dirname(repo), 'decision-numbers'));
    expect(out.kind).toBe('rebased');
  };

  beforeEach(async () => {
    const root = mkdtempSync(join(tmpdir(), 'factory-carry-'));
    repo = join(root, 'repo');
    await git(root, 'init', '-q', '-b', 'main', repo);
    await commit('base', {
      'docs/decisions.md': decisions(BASE),
      'apps/web/src/a.ts': 'export const a = 1;\n\nexport const keep = true;\n',
      'apps/web/src/b.ts': 'export const b = 1;\n',
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
    await commit("What's new after an update", {
      'apps/web/src/a.ts': 'export const a = 2;\n\nexport const keep = true;\n',
      'apps/web/src/c.ts': 'export const c = 1;\n',
      'docs/decisions.md': decisions([...BASE, "| A1309 | What's new once. |"]),
    });
  });

  it("is the same after a rebase that brought main's decision row and other files", async () => {
    // PEN-63: another PR's row landed beside the branch's own; the rebase resolved it, and the
    // branch's own changes outside docs/decisions.md were byte for byte what had been proved.
    const before = await diffPrint(sandbox);
    expect(before).toMatch(/^[0-9a-f]{64}$/);
    await mainMoves('Another PR', {
      'docs/decisions.md': decisions([...BASE, '| A1308 | Retry apt. |']),
      'apps/web/src/b.ts': 'export const b = 2;\n',
      'apps/web/src/d.ts': 'export const d = 1;\n',
    });
    await rebased();
    expect(await git(repo, 'show', 'HEAD:docs/decisions.md')).toContain('| A1308 |');
    expect(await diffPrint(sandbox)).toBe(before);
  });

  it('is the same when the branch changed only docs/decisions.md since', async () => {
    const before = await diffPrint(sandbox);
    await commit('Number the new decisions', {
      'docs/decisions.md': decisions([...BASE, "| A1310 | What's new once. |"]),
    });
    expect(await diffPrint(sandbox)).toBe(before);
  });

  it('changes when the branch changes anything else', async () => {
    const before = await diffPrint(sandbox);
    await commit('A fix round', { 'apps/web/src/c.ts': 'export const c = 2;\n' });
    expect(await diffPrint(sandbox)).not.toBe(before);
  });

  it('changes when a file is only renamed or its mode changes', async () => {
    const before = await diffPrint(sandbox);
    await git(repo, 'mv', 'apps/web/src/c.ts', 'apps/web/src/e.ts');
    await git(repo, 'commit', '-q', '-m', 'Rename');
    const renamed = await diffPrint(sandbox);
    expect(renamed).not.toBe(before);
    await git(repo, 'update-index', '--chmod=+x', 'apps/web/src/e.ts');
    await git(repo, 'commit', '-q', '-m', 'Executable');
    expect(await diffPrint(sandbox)).not.toBe(renamed);
  });

  it('changes when main changed a file the branch changes too, even elsewhere in it', async () => {
    // The file the proof ran on is not the one now on the branch: prove again.
    const before = await diffPrint(sandbox);
    await mainMoves('Another PR', {
      'apps/web/src/a.ts': 'export const a = 1;\n\nexport const keep = false;\n',
    });
    await rebased();
    expect(await diffPrint(sandbox)).not.toBe(before);
  });

  it('is nothing for a branch that changes only docs/decisions.md, or when git fails', async () => {
    await git(repo, 'checkout', '-q', '-b', 'decisions-only', 'main');
    await commit('A decision', { 'docs/decisions.md': decisions([...BASE, '| A1311 | x |']) });
    expect(await diffPrint(sandbox)).toBeUndefined();
    await git(repo, 'update-ref', '-d', 'refs/remotes/origin/main');
    expect(await diffPrint(sandbox)).toBeUndefined();
  });
});

const PRINT = 'a'.repeat(64);
const proven = (over: Partial<Proven> = {}): Proven => ({
  run: '63-old',
  diff: PRINT,
  specs: { web: ['whats-new.spec.ts'], android: ['WhatsNewTest'] },
  proof: [
    {
      label: 'web: shows it',
      phase: 'after',
      source: 'harness',
      image: 'web-1.png',
      video: 'web-1.mp4',
    },
    { label: 'android: shows it', phase: 'after', source: 'harness', image: 'android-1.png' },
  ],
  validation: {
    key: validationKey({ plan: 'AC1', builder: [], platforms: ['web', 'android'] }),
    rows: [
      {
        criterion: 'AC1 the snackbar says so once',
        verdict: 'match',
        note: '',
        mockup: 'fidelity-ac1-mockup.png',
        screenshot: 'fidelity-ac1.png',
      },
    ],
  },
  ...over,
});
/** A record of proof alone: no validation ran. */
const unvalidated = (p: Proven): Proven => ({
  run: p.run,
  diff: p.diff,
  specs: p.specs,
  proof: p.proof,
});
const wanted = (over: Partial<Wanted> = {}): Wanted => ({
  diff: PRINT,
  specs: { web: ['whats-new.spec.ts'], android: ['WhatsNewTest'] },
  validation: {
    key: validationKey({ plan: 'AC1', builder: [], platforms: ['android', 'web'] }),
    final: false,
  },
  ...over,
});

describe('carriedOver', () => {
  it('takes a record with the same print, platforms, specs and validation', () => {
    expect(carriedOver(proven(), wanted())).toEqual(proven());
    // Proof alone, when no validation is due.
    const noValidation: Wanted = { diff: PRINT, specs: wanted().specs };
    expect(carriedOver(unvalidated(proven()), noValidation)).toBeDefined();
  });

  it('refuses anything that differs, or is missing', () => {
    expect(carriedOver(undefined, wanted())).toBeUndefined();
    expect(carriedOver(proven(), wanted({ diff: 'b'.repeat(64) }))).toBeUndefined();
    expect(
      carriedOver(proven(), wanted({ specs: { web: ['whats-new.spec.ts'] } })),
    ).toBeUndefined();
    expect(
      carriedOver(
        proven(),
        wanted({ specs: { web: ['other.spec.ts'], android: ['WhatsNewTest'] } }),
      ),
    ).toBeUndefined();
    expect(
      carriedOver(proven({ proof: [] }), wanted({ specs: { web: ['whats-new.spec.ts'] } })),
    ).toBeUndefined();
    // Validation due, but the earlier run had none, or validated another plan.
    expect(carriedOver(unvalidated(proven()), wanted())).toBeUndefined();
    expect(
      carriedOver(
        proven(),
        wanted({
          validation: {
            key: validationKey({ plan: 'AC1 changed', builder: [], platforms: ['web'] }),
            final: false,
          },
        }),
      ),
    ).toBeUndefined();
  });

  it('takes a mismatch only on the last round, as a fresh validation there would be', () => {
    const mismatch = proven({
      validation: {
        key: wanted().validation!.key,
        rows: [{ criterion: 'AC1', verdict: 'mismatch', note: 'Still red' }],
      },
    });
    expect(carriedOver(mismatch, wanted())).toBeUndefined();
    expect(
      carriedOver(mismatch, wanted({ validation: { key: wanted().validation!.key, final: true } })),
    ).toBe(mismatch);
  });
});

describe('parseProven', () => {
  it('reads what the gate keeps', () => {
    expect(parseProven(JSON.stringify(proven()))).toEqual(proven());
  });

  it('refuses a record that is off in any way', () => {
    const bad = (over: Record<string, unknown>) => JSON.stringify({ ...proven(), ...over });
    expect(parseProven('{')).toBeUndefined();
    expect(parseProven(bad({ run: '../63' }))).toBeUndefined();
    expect(parseProven(bad({ diff: 'short' }))).toBeUndefined();
    expect(parseProven(bad({ specs: { ios: ['x'] } }))).toBeUndefined();
    expect(
      parseProven(
        bad({ proof: [{ label: 'x', phase: 'after', source: 'harness', image: '../x.png' }] }),
      ),
    ).toBeUndefined();
    expect(
      parseProven(
        bad({ validation: { key: 'k', rows: [{ criterion: 'x', verdict: 'maybe', note: '' }] } }),
      ),
    ).toBeUndefined();
  });
});

describe('provenRuns and findProven', () => {
  const recorded = (run: string, diff = PRINT) =>
    JSON.stringify({ at: 'x', run, event: 'proof-recorded', files: 2, diff });

  it("lists the card's runs that recorded proof with this print, newest first", () => {
    const ledger = [
      recorded('63-a'),
      recorded('64-b'),
      recorded('63-c', 'b'.repeat(64)),
      JSON.stringify({ at: 'x', run: '63-d', event: 'proof-recorded', files: 2 }),
      recorded('63-e'),
      '{"torn',
    ].join('\n');
    expect(provenRuns(ledger, 63, PRINT)).toEqual(['63-e', '63-a']);
    expect(provenRuns(ledger, 63, PRINT, '63-e')).toEqual(['63-a']);
  });

  it('finds the newest record whose files are all still in its run folder', () => {
    const state = mkdtempSync(join(tmpdir(), 'factory-proven-'));
    const keep = (p: Proven, files: readonly string[]) => {
      const dir = join(state, 'runs', p.run, 'proof');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(state, 'runs', p.run, PROVEN), JSON.stringify(p));
      for (const f of files) writeFileSync(join(dir, f), 'x');
    };
    const all = ['web-1.png', 'web-1.mp4', 'android-1.png', 'fidelity-ac1-mockup.png'];
    keep(proven({ run: '63-a' }), [...all, 'fidelity-ac1.png']);
    // The newest is missing a screenshot (and has a link instead of one): not used.
    keep(proven({ run: '63-b' }), all);
    symlinkSync('/etc/hosts', join(state, 'runs', '63-b', 'proof', 'fidelity-ac1.png'));
    // A record whose print isn't the one the ledger names: not used.
    keep(proven({ run: '63-c', diff: 'c'.repeat(64) }), [...all, 'fidelity-ac1.png']);
    writeFileSync(
      join(state, 'runs.jsonl'),
      [recorded('63-a'), recorded('63-b'), recorded('63-c'), recorded('63-now')].join('\n'),
    );
    expect(findProven(state, 63, PRINT, '63-now')?.run).toBe('63-a');
    expect(findProven(state, 63, 'd'.repeat(64))).toBeUndefined();
    expect(findProven(join(state, 'nothing'), 63, PRINT)).toBeUndefined();
    expect(JSON.parse(readFileSync(join(state, 'runs', '63-a', PROVEN), 'utf8'))).toMatchObject({
      run: '63-a',
    });
  });
});

describe('the host carries the earlier proof over', () => {
  it('finds the record through the ledger, and links the files where the earlier run put them', async () => {
    const root = mkdtempSync(join(tmpdir(), 'factory-carry-host-'));
    const config = { ...testConfig(), stateDir: join(root, 'state') };
    const state = config.stateDir;
    const record = unvalidated(proven({ run: '42-old' }));
    mkdirSync(join(state, 'runs', '42-old', 'proof'), { recursive: true });
    writeFileSync(join(state, 'runs', '42-old', PROVEN), JSON.stringify(record));
    for (const f of ['web-1.png', 'web-1.mp4', 'android-1.png'])
      writeFileSync(join(state, 'runs', '42-old', 'proof', f), f);
    writeFileSync(
      join(state, 'runs.jsonl'),
      `${JSON.stringify({ at: 'x', run: '42-old', event: 'proof-recorded', files: 2, diff: PRINT })}\n`,
    );
    const puts: [string, string][] = [];
    const gh = {
      json: () => Promise.resolve([]),
      run: () => Promise.resolve('https://github.com/htxryan/penmoss/pull/9\n'),
      graphql: () => Promise.reject(new Error('unused')),
    } as never;
    const deps = hostDeps({
      config,
      slot: config.slots[0]!,
      runId: '42-new',
      board: { items: [] },
      gh,
      tracker: {} as never,
      exec: nodeExec,
      secrets: {},
      pushToken: () => Promise.resolve('t'),
      sandboxToken: () => Promise.resolve('t'),
      proofStore: {
        put: (file, key) => {
          puts.push([file, key]);
          return Promise.resolve(`https://proof.penmoss.app/${key}`);
        },
      },
      agent: {} as never,
      log: () => undefined,
    });
    expect(deps.provenBefore?.(PRINT)).toEqual(record);
    expect(deps.provenBefore?.('d'.repeat(64))).toBeUndefined();
    await deps.openPr({
      branch: 'factory/42-x',
      title: 'x',
      body: '![web](./web-1.png)\n[▶](./web-1.mp4)',
      proof: record.proof,
      proofFrom: '42-old',
    });
    expect(puts).toContainEqual([
      join(state, 'runs', '42-old', 'proof', 'web-1.png'),
      'runs/42-old/web-1.png',
    ]);
    const body = readFileSync(join(state, 'runs', '42-new', 'proof', 'body.md'), 'utf8');
    expect(body).toContain('(https://proof.penmoss.app/runs/42-old/web-1.png)');
    expect(body).toContain('(https://proof.penmoss.app/runs/42-old/web-1.mp4)');
  });
});
