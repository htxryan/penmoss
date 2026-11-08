// GitTransport over system git (A744), as G2 would build it: git is spawned without a shell,
// isolated from the machine's config, and never prompts. The clone is disposable: commits are
// built with plumbing on top of the fetched remote head (A742), in a temporary index, so no
// merge, rebase or checkout of local work ever runs. The working tree only mirrors the head
// inside the notebook's directory (a sparse cone over a partial clone), so reading every
// writer's logs and the rendered files is plain file reads.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Environment for every git call: no global or system config, no prompts (risks: CI coverage). */
export function gitEnv(extra = {}) {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    LANG: 'C',
    ...extra,
  };
}

export class GitError extends Error {
  constructor(args, result) {
    super(`git ${args.join(' ')} failed (${result.status}): ${String(result.stderr).trim()}`);
    this.name = 'GitError';
    this.status = result.status;
    this.stderr = String(result.stderr);
  }
}

/** Runs git in `cwd`; returns stdout as a Buffer. `ok` lists exit codes that are not errors. */
export function git(cwd, args, { input, env, ok = [0] } = {}) {
  const result = spawnSync('git', args, {
    cwd,
    input,
    env: env ?? gitEnv(),
    maxBuffer: 1 << 30,
  });
  if (result.error) throw result.error;
  if (!ok.includes(result.status)) throw new GitError(args, result);
  return Object.assign(result.stdout, { status: result.status, stderr: String(result.stderr) });
}

const text = (buffer) => buffer.toString('utf8').trim();

/**
 * A remote for the spike: a local bare repo (`file://`, filters allowed as the risks section
 * says tests must) or a github.com repo reached with a token through GIT_ASKPASS.
 */
export function localRemote(dir) {
  mkdirSync(dir, { recursive: true });
  git(dir, ['init', '--bare', '--quiet', '--initial-branch=main']);
  git(dir, ['config', 'uploadpack.allowFilter', 'true']);
  git(dir, ['config', 'uploadpack.allowAnySHA1InWant', 'true']);
  return { url: `file://${dir}`, env: {} };
}

/** A github.com remote; the token reaches git through GIT_ASKPASS only (never the URL or argv). */
export function githubRemote(repo, token, scratch) {
  mkdirSync(scratch, { recursive: true });
  const askpass = join(scratch, 'askpass.sh');
  writeFileSync(
    askpass,
    '#!/bin/sh\ncase "$1" in\n  Username*) echo x-access-token ;;\n  *) printf "%s\\n" "$SPIKE_GIT_TOKEN" ;;\nesac\n',
    { mode: 0o700 },
  );
  return {
    url: `https://github.com/${repo}.git`,
    env: { GIT_ASKPASS: askpass, SPIKE_GIT_TOKEN: token },
  };
}

/**
 * One device's clone of a notebook target (repo + branch + optional directory). `dir` is ''
 * for the repository root, or `docs/notes`.
 */
export class GitTransport {
  constructor({ path, remote, branch, dir = '', author }) {
    this.path = path;
    this.remote = remote;
    this.branch = branch;
    this.dir = dir;
    this.root = dir ? `${dir}/` : '';
    this.author = author;
    this.env = gitEnv(remote.env);
    this.stats = { fetches: 0, fetchMs: 0, pushes: 0, rejected: 0, pushMs: 0, checkoutMs: 0 };
    this.filterIgnored = false;
  }

  run(args, options = {}) {
    return git(this.path, args, { env: this.env, ...options });
  }

  /** A partial clone (`--filter=blob:none`) with a sparse cone on the directory (A744). */
  clone() {
    mkdirSync(this.path, { recursive: true });
    this.run(['init', '--quiet', '--initial-branch=main']);
    this.run(['remote', 'add', 'origin', this.remote.url]);
    this.run(['config', 'remote.origin.promisor', 'true']);
    this.run(['config', 'remote.origin.partialclonefilter', 'blob:none']);
    this.run(['config', 'core.sparseCheckout', 'true']);
    this.run(['config', 'core.sparseCheckoutCone', 'true']);
    this.run(['config', 'gc.auto', '0']);
    this.run(['config', 'fetch.writeCommitGraph', 'false']);
    if (this.dir) this.run(['sparse-checkout', 'set', '--cone', this.dir]);
    else this.run(['sparse-checkout', 'disable']);
    return this;
  }

  /** The remote branch's head after a fetch, or null for an empty branch. */
  fetch() {
    const started = performance.now();
    const ref = `refs/remotes/origin/${this.branch}`;
    const result = this.run(
      ['fetch', '--quiet', '--no-tags', '--filter=blob:none', 'origin', `+refs/heads/${this.branch}:${ref}`],
      { ok: [0, 128] },
    );
    this.stats.fetches++;
    this.stats.fetchMs += performance.now() - started;
    if (result.status === 128) {
      if (/couldn't find remote ref|Couldn't find remote ref/.test(result.stderr)) return null;
      throw new GitError(['fetch'], { status: 128, stderr: result.stderr });
    }
    if (/filtering not recognized|filter.*ignored/i.test(result.stderr)) this.filterIgnored = true;
    return text(this.run(['rev-parse', ref]));
  }

  /** Puts the head's files inside the cone into the working tree (one batched blob fetch). */
  checkout(head) {
    const started = performance.now();
    this.run(['checkout', '--quiet', '--force', '--detach', head]);
    this.stats.checkoutMs += performance.now() - started;
  }

  /** Whether a commit exists locally (the last synced head may be gone after a force-push). */
  hasCommit(sha) {
    return this.run(['cat-file', '-e', `${sha}^{commit}`], { ok: [0, 1, 128] }).status === 0;
  }

  /** Every file under `prefix` (relative to the repo) at `head`: path → blob sha. */
  list(head, prefix = this.root) {
    const out = new Map();
    if (!head) return out;
    const args = ['ls-tree', '-r', '-z', '--full-tree', head];
    if (prefix) args.push('--', prefix);
    for (const line of this.run(args).toString('utf8').split('\0')) {
      if (!line) continue;
      const tab = line.indexOf('\t');
      const [, type, sha] = line.slice(0, tab).split(' ');
      if (type === 'blob') out.set(line.slice(tab + 1), sha);
    }
    return out;
  }

  /** Paths under `prefix` that differ between two commits, or null when `from` is unknown. */
  changed(from, to, prefix) {
    if (!from || !to || !this.hasCommit(from)) return null;
    const args = ['diff', '--name-only', '-z', '--no-renames', from, to];
    if (prefix) args.push('--', prefix);
    return this.run(args).toString('utf8').split('\0').filter(Boolean);
  }

  /** A file of the checked-out head (inside the cone). */
  read(path) {
    const file = join(this.path, path);
    return existsSync(file) ? readFileSync(file) : null;
  }

  /** The bytes of a path at any commit (History, `readAt`). */
  readAt(commit, path) {
    const result = this.run(['cat-file', 'blob', `${commit}:${path}`], { ok: [0, 128] });
    return result.status === 0 ? Buffer.from(result) : null;
  }

  /**
   * A commit on top of `head` (null: the branch's first commit) that sets or removes `changes`
   * (path → bytes, or null to remove). Only paths under the notebook's directory may change.
   * Returns null when nothing changes.
   */
  commitOnHead(head, changes, message) {
    for (const path of changes.keys()) {
      if (!path.startsWith(this.root)) throw new Error(`Refusing to write outside ${this.root}: ${path}`);
    }
    const scratch = mkdtempSync(join(tmpdir(), 'pm-commit-'));
    try {
      const env = { ...this.env, GIT_INDEX_FILE: join(scratch, 'index') };
      const opts = { env };
      this.run(head ? ['read-tree', head] : ['read-tree', '--empty'], opts);
      const writes = [...changes].filter(([, bytes]) => bytes !== null);
      const files = writes.map(([, bytes], i) => {
        const file = join(scratch, `b${i}`);
        writeFileSync(file, bytes);
        return file;
      });
      const shas = files.length
        ? text(this.run(['hash-object', '-w', '--no-filters', '--stdin-paths'], { ...opts, input: files.join('\n') })).split('\n')
        : [];
      const lines = [];
      writes.forEach(([path], i) => lines.push(`100644 ${shas[i]}\t${path}`));
      for (const [path, bytes] of changes) {
        if (bytes === null) lines.push(`0 ${'0'.repeat(40)}\t${path}`);
      }
      this.run(['update-index', '-z', '--index-info'], { ...opts, input: lines.join('\0') + '\0' });
      const tree = text(this.run(['write-tree'], opts));
      if (head && tree === text(this.run(['rev-parse', `${head}^{tree}`]))) return null;
      const authorEnv = {
        ...env,
        GIT_AUTHOR_NAME: this.author.name,
        GIT_AUTHOR_EMAIL: this.author.email,
        GIT_COMMITTER_NAME: this.author.name,
        GIT_COMMITTER_EMAIL: this.author.email,
      };
      const args = ['commit-tree', tree, '-m', message];
      if (head) args.splice(2, 0, '-p', head);
      return text(this.run(args, { env: authorEnv }));
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }

  /** Pushes a commit as the branch's new head, fast-forward only. False when rejected. */
  push(commit) {
    const started = performance.now();
    const result = this.run(['push', '--quiet', '--porcelain', 'origin', `${commit}:refs/heads/${this.branch}`], {
      ok: [0, 1],
    });
    this.stats.pushes++;
    this.stats.pushMs += performance.now() - started;
    if (result.status === 0) return true;
    if (/non-fast-forward|fetch first|\[rejected\]|stale info/.test(result.toString() + result.stderr)) {
      this.stats.rejected++;
      return false;
    }
    throw new GitError(['push'], { status: result.status, stderr: result.stderr + result.toString() });
  }

  /** Size of the clone's object store in bytes (packs and loose objects). */
  storeBytes() {
    const out = text(this.run(['count-objects', '-v']));
    const kb = (key) => Number(new RegExp(`^${key}: (\\d+)`, 'm').exec(out)?.[1] ?? 0);
    return (kb('size') + kb('size-pack') + kb('size-garbage')) * 1024;
  }
}
