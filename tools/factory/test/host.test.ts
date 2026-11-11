import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { nodeExec } from '../src/exec.ts';
import type { Gh } from '../src/github.ts';
import { chatUrlOf, keepFiles, LAST_PROOF, openOrReusePr, stageLastProof } from '../src/host.ts';
import { pushBranch } from '../src/publish.ts';

// Real git against a bare repository standing in for GitHub, pushed to by URL as the host does
// from its publish repo (here a plain clone holding the commit).
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

const BRANCH = 'factory/42-fix-the-typo';

describe("the harness's push", { timeout: 30_000 }, () => {
  let remote: string;
  let url: string;
  let clone: string;

  beforeEach(async () => {
    const root = mkdtempSync(join(tmpdir(), 'factory-push-'));
    remote = join(root, 'github.git');
    clone = join(root, 'repo');
    url = `file://${remote}`;
    await git(root, 'init', '-q', '--bare', '-b', 'main', remote);
    await git(root, 'init', '-q', '-b', 'main', clone);
    await git(clone, 'commit', '-q', '--allow-empty', '-m', 'main');
    await git(clone, 'remote', 'add', 'origin', url);
    await git(clone, 'push', '-q', 'origin', 'main');
    await git(
      clone,
      'remote',
      'set-url',
      '--push',
      'origin',
      'no-push://the-factory-harness-pushes',
    );
    await git(clone, 'checkout', '-q', '-b', BRANCH);
    await git(clone, 'commit', '-q', '--allow-empty', '-m', 'the agent');
  });

  const remoteHead = () => git(remote, 'rev-parse', `refs/heads/${BRANCH}`);
  const push = async () =>
    pushBranch(nodeExec, clone, url, BRANCH, await git(clone, 'rev-parse', BRANCH), 'a-token');

  it('pushes the same branch again after a repair commit and after a rebase rewrites it', async () => {
    await push();
    expect(await remoteHead()).toBe(await git(clone, 'rev-parse', BRANCH));

    // A CI repair or review round: one more commit on top.
    await git(clone, 'commit', '-q', '--allow-empty', '-m', 'the repair');
    await push();
    expect(await remoteHead()).toBe(await git(clone, 'rev-parse', BRANCH));

    // The gate's rebase onto main rewrites the branch.
    await git(clone, 'commit', '-q', '--amend', '--allow-empty', '-m', 'the repair, rebased');
    await push();
    expect(await remoteHead()).toBe(await git(clone, 'rev-parse', BRANCH));
  });

  it('never overwrites a commit someone else pushed to the branch', async () => {
    await push();
    const other = mkdtempSync(join(tmpdir(), 'factory-push-ryan-'));
    await git(other, 'clone', '-q', '-b', BRANCH, url, 'ryan');
    await git(join(other, 'ryan'), 'commit', '-q', '--allow-empty', '-m', "Ryan's fix");
    await git(join(other, 'ryan'), 'push', '-q', 'origin', BRANCH);
    const ryans = await remoteHead();

    await git(clone, 'commit', '-q', '--amend', '--allow-empty', '-m', 'the agent, rewritten');
    await expect(push()).rejects.toThrow(/push failed: .*\[rejected\].*stale info/);
    expect(await remoteHead()).toBe(ryans);
  });

  it('pushes the branch afresh when GitHub no longer has it (deleted after a merge)', async () => {
    await push();
    await git(remote, 'update-ref', '-d', `refs/heads/${BRANCH}`);
    await git(clone, 'commit', '-q', '--amend', '--allow-empty', '-m', 'a new run');
    await push();
    expect(await remoteHead()).toBe(await git(clone, 'rev-parse', BRANCH));
  });
});

describe("the harness's PR", () => {
  function fakeGh(open: { number: number; url: string }[]): { gh: Gh; calls: string[][] } {
    const calls: string[][] = [];
    const gh: Gh = {
      run: (args) => {
        calls.push([...args]);
        return Promise.resolve(
          args[1] === 'create'
            ? 'Creating pull request…\nhttps://github.com/htxryan/penmoss/pull/7\n'
            : '{}',
        );
      },
      json: <T>(args: readonly string[]) => {
        calls.push([...args]);
        return Promise.resolve(open as T);
      },
      graphql: () => Promise.reject(new Error('not used')),
    };
    return { gh, calls };
  }
  const pr = {
    repo: 'htxryan/penmoss',
    branch: BRANCH,
    title: 'Fix the typo',
    bodyFile: '/runs/42/proof/body.md',
    reviewer: 'htxryan',
  };

  it('opens a PR for a branch that has none, asking Ryan to review', async () => {
    const { gh, calls } = fakeGh([]);
    expect(await openOrReusePr(gh, pr)).toBe('https://github.com/htxryan/penmoss/pull/7');
    expect(calls[1]).toEqual([
      ...['pr', 'create', '--repo', 'htxryan/penmoss', '--base', 'main', '--head', BRANCH],
      ...['--title', 'Fix the typo', '--reviewer', 'htxryan', '--body-file', pr.bodyFile],
    ]);
  });

  it("reuses the branch's open PR when a restarted run gets here again (R12)", async () => {
    const { gh, calls } = fakeGh([{ number: 5, url: 'https://github.com/htxryan/penmoss/pull/5' }]);
    expect(await openOrReusePr(gh, pr)).toBe('https://github.com/htxryan/penmoss/pull/5');
    expect(calls.some((c) => c[1] === 'create')).toBe(false);
    expect(calls[1]).toEqual([
      ...['api', '-X', 'PATCH', 'repos/htxryan/penmoss/pulls/5'],
      ...['-f', 'title=Fix the typo', '-F', `body=@${pr.bodyFile}`],
    ]);
  });
});

describe("validation's files in the run folder (A1256)", () => {
  it('keeps the review, captures and image pairs, never a link or a folder', () => {
    const root = mkdtempSync(join(tmpdir(), 'factory-keep-'));
    const from = join(root, 'worktree', '.factory', 'validation');
    mkdirSync(join(from, 'sub'), { recursive: true });
    writeFileSync(join(from, 'review.json'), '{"rows":[]}');
    writeFileSync(join(from, 'ac1.png'), 'png');
    writeFileSync(join(from, 'ac1-mockup.png'), 'png');
    writeFileSync(join(root, 'outside.txt'), "not the agent's");
    symlinkSync(join(root, 'outside.txt'), join(from, 'link.png'));
    const to = join(root, 'runs', 'r1', 'validation', '1');
    expect(keepFiles(from, to).sort()).toEqual(['ac1-mockup.png', 'ac1.png', 'review.json']);
    expect(readdirSync(to).sort()).toEqual(['ac1-mockup.png', 'ac1.png', 'review.json']);
    expect(readFileSync(join(to, 'review.json'), 'utf8')).toBe('{"rows":[]}');
    // Nothing to keep: no folder made.
    expect(keepFiles(join(root, 'none'), join(root, 'empty'))).toEqual([]);
    expect(existsSync(join(root, 'empty'))).toBe(false);
  });
});

describe("a session's chat link, from the runner's stream (A1287)", () => {
  it("takes only the runner's own line, with a claude.ai session link", () => {
    const line = (o: object) => JSON.stringify(o);
    expect(
      chatUrlOf(
        line({ type: 'system', subtype: 'factory_chat', url: 'https://claude.ai/code/session_A1' }),
      ),
    ).toBe('https://claude.ai/code/session_A1');
    // The agent's own words can't post a link: only a system line of the runner's.
    expect(
      chatUrlOf(
        line({
          type: 'assistant',
          subtype: 'factory_chat',
          url: 'https://claude.ai/code/session_A1',
        }),
      ),
    ).toBeUndefined();
    expect(
      chatUrlOf(line({ type: 'system', subtype: 'factory_chat', url: 'https://evil.example/x' })),
    ).toBeUndefined();
    expect(chatUrlOf('{"type":"system","subtype":"factory_chat"')).toBeUndefined();
  });
});

describe("a session's chat link (A1287)", () => {
  it("takes the runner's link, and only a claude.ai one", () => {
    const line = (url: string) => JSON.stringify({ type: 'system', subtype: 'factory_chat', url });
    expect(chatUrlOf(line('https://claude.ai/code/session_01Ab'))).toBe(
      'https://claude.ai/code/session_01Ab',
    );
    expect(chatUrlOf(line('https://evil.example/code/session_01Ab'))).toBeUndefined();
    // The agent's own words that mention it are an assistant message, not the runner's line.
    expect(
      chatUrlOf(JSON.stringify({ type: 'assistant', subtype: 'factory_chat', url: 'x' })),
    ).toBeUndefined();
    expect(chatUrlOf('{"factory_chat"')).toBeUndefined();
  });
});

describe("the last proof's screenshots, for the agent's next round (A1291)", () => {
  it("copies each platform's screenshot into the worktree, and nothing else", () => {
    const raw = mkdtempSync(join(tmpdir(), 'factory-raw-'));
    const worktree = mkdtempSync(join(tmpdir(), 'factory-wt-'));
    for (const f of ['mac-1-screenshot.png', 'web-1-screenshot.png', 'mac-1-video.mp4', 'x.png'])
      writeFileSync(join(raw, f), f);
    expect(stageLastProof(raw, worktree).sort()).toEqual([
      'mac-1-screenshot.png',
      'web-1-screenshot.png',
    ]);
    expect(readFileSync(join(worktree, LAST_PROOF, 'mac-1-screenshot.png'), 'utf8')).toBe(
      'mac-1-screenshot.png',
    );
    expect(existsSync(join(worktree, LAST_PROOF, 'mac-1-video.mp4'))).toBe(false);
    expect(stageLastProof(join(raw, 'none'), worktree)).toEqual([]);
  });
});
