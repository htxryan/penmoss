#!/usr/bin/env node
// G0 sizes (#148): how big a git notebook gets, and how long its syncs take.
//
//   node spikes/git-notebook/sizes.mjs --scenario big-note    one 10,000-word note, 1,000 bursts, a commit each
//   node spikes/git-notebook/sizes.mjs --scenario daily-year  365 daily notes (and 52 weekly), a commit a day
//   node spikes/git-notebook/sizes.mjs --scenario thousand    1,000 notes in 20 folders, then 50 edit syncs
//   --remote github --branch <name>   push to htxryan/penmoss-git-notebook-scratch (private) and keep the branch
//   --json <file>                     write the numbers
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, statSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { git, gitEnv, githubRemote, GitTransport, localRemote } from './lib/git.mjs';
import { Clone, rngFrom, WORDS } from './lib/notebook.mjs';
import { P } from './lib/penmoss.mjs';

const { Y } = P;
const { values: opts } = parseArgs({
  options: {
    scenario: { type: 'string', default: 'big-note' },
    remote: { type: 'string', default: 'local' },
    repo: { type: 'string', default: 'htxryan/penmoss-git-notebook-scratch' },
    branch: { type: 'string' },
    bursts: { type: 'string', default: '1000' },
    notes: { type: 'string', default: '1000' },
    days: { type: 'string', default: '365' },
    seed: { type: 'string', default: '42' },
    json: { type: 'string' },
  },
});

const rng = rngFrom(Number(opts.seed));
const scratch = join(tmpdir(), `pm-sizes-${process.pid}`);
rmSync(scratch, { recursive: true, force: true });
mkdirSync(scratch, { recursive: true });
let remote;
if (opts.remote === 'github') {
  const visibility = execFileSync('gh', ['api', `repos/${opts.repo}`, '--jq', '.visibility']).toString().trim();
  if (visibility !== 'private') throw new Error(`${opts.repo} is not private`);
  remote = githubRemote(opts.repo, execFileSync('gh', ['auth', 'token']).toString().trim(), join(scratch, 'auth'));
} else {
  remote = localRemote(join(scratch, 'remote.git'));
}
const branch = opts.branch ?? (opts.remote === 'github' ? `sizes-${opts.scenario}-${Date.now().toString(36)}` : 'main');
let time = Date.UTC(2026, 0, 1, 14, 0, 0);
const clock = { now: () => time };
const transport = (name) =>
  new GitTransport({ path: join(scratch, name), remote, branch, author: { name: `Penmoss ${name}`, email: `${name}@example.invalid` } }).clone();
const A = new Clone({ name: 'A', transport: transport('A'), rng, clock });

const syncTimes = [];
const timedSync = (c) => {
  const t0 = performance.now();
  const result = c.sync();
  if (result.gaveUp) throw new Error('gave up');
  syncTimes.push(performance.now() - t0);
  return result;
};
const words = (n) => Array.from({ length: n }, () => rng.pick(WORDS)).join(' ');
const paragraphs = (wordCount, per = 60) => {
  const out = [];
  for (let left = wordCount; left > 0; left -= per) out.push(`${words(Math.min(per, left))}.`);
  return out.join('\n\n');
};

/** One editing burst as a person types: a run of keystrokes at one place, a few backspaces, now and then a cut. */
function burst(c, noteId) {
  const doc = c.notes.get(noteId);
  const root = doc.get(P.NOTE_ROOT);
  const paras = root.toArray().filter((n) => n instanceof Y.Node && n.name === 'paragraph');
  const p = rng.pick(paras);
  let at = rng.int(p.length + 1);
  const typed = ` ${words(2 + rng.int(10))}`;
  for (const ch of typed) {
    doc.transact(() => p.insert(at, ch));
    at++;
    if (rng.chance(0.03) && at > 1) {
      doc.transact(() => p.delete(at - 1, 1));
      at--;
    }
  }
  if (rng.chance(0.2)) {
    const q = rng.pick(paras);
    if (q.length > 20) doc.transact(() => q.delete(rng.int(q.length - 10), 1 + rng.int(8)));
  }
  if (rng.chance(0.05)) {
    const np = new Y.Node('paragraph');
    doc.transact(() => {
      root.insert(rng.int(root.length + 1), [np]);
      np.insert(0, `${words(8)}.`);
    });
  }
  c.touch(noteId);
}

function measure(label) {
  const files = A.t.list(A.lastHead);
  let writerBytes = 0;
  let workspaceBytes = 0;
  let mdBytes = 0;
  let largestLog = 0;
  for (const [path] of files) {
    const size = A.t.read(path)?.length ?? 0;
    if (path.includes('.penmoss/workspace/')) workspaceBytes += size;
    else if (path.endsWith('.yjs')) {
      writerBytes += size;
      largestLog = Math.max(largestLog, size);
    } else if (path.endsWith('.md')) mdBytes += size;
  }
  // The remote as a host keeps it: gc'd (GitHub repacks too).
  let remoteBytes = null;
  let remoteRawBytes = null;
  if (opts.remote === 'local') {
    const bare = join(scratch, 'remote.git');
    remoteRawBytes = dirBytes(join(bare, 'objects'));
    git(bare, ['gc', '--quiet', '--aggressive', '--prune=now']);
    remoteBytes = dirBytes(join(bare, 'objects'));
  }
  // A new device: a full clone, then a shallow one (what JGit on Android would do).
  const cloneTimes = {};
  for (const [kind, extra] of [
    ['full', []],
    ['shallow', ['--depth=1']],
  ]) {
    const dest = join(scratch, `fresh-${kind}`);
    rmSync(dest, { recursive: true, force: true });
    const t0 = performance.now();
    git(scratch, ['clone', '--quiet', '--no-checkout', '--single-branch', '--branch', branch, ...extra, remote.url, dest], { env: gitEnv(remote.env) });
    cloneTimes[kind] = { ms: Math.round(performance.now() - t0), gitBytes: dirBytes(join(dest, '.git')) };
    rmSync(dest, { recursive: true, force: true });
  }
  // A second device's first sync (fetch, apply every log, render) and a no-op sync after.
  const B = new Clone({ name: 'B', transport: transport(`B-${label}`), rng, clock });
  const t0 = performance.now();
  timedSyncQuiet(B);
  const firstSyncMs = Math.round(performance.now() - t0);
  const t1 = performance.now();
  timedSyncQuiet(B);
  const noopSyncMs = Math.round(performance.now() - t1);
  const sorted = [...syncTimes].sort((a, b) => a - b);
  return {
    label,
    commits: A.stats.commits,
    files: files.size,
    writerBytes,
    largestLog,
    workspaceBytes,
    mdBytes,
    localGitBytes: A.t.storeBytes(),
    // The same clone after `git gc` (the engine's housekeeping; nothing here runs it by itself).
    localGitBytesAfterGc: (git(A.t.path, ['gc', '--quiet', '--prune=now'], { env: gitEnv(remote.env) }), A.t.storeBytes()),
    remoteRawBytes,
    remoteGcBytes: remoteBytes,
    clone: cloneTimes,
    secondDevice: { firstSyncMs, noopSyncMs },
    sync: {
      count: sorted.length,
      p50: Math.round(sorted[Math.floor(sorted.length * 0.5)] ?? 0),
      p95: Math.round(sorted[Math.floor(sorted.length * 0.95)] ?? 0),
      max: Math.round(sorted.at(-1) ?? 0),
      fetchMs: Math.round(A.t.stats.fetchMs / Math.max(1, A.t.stats.fetches)),
      pushMs: Math.round(A.t.stats.pushMs / Math.max(1, A.t.stats.pushes)),
    },
  };
}

function timedSyncQuiet(c) {
  const result = c.sync();
  if (result.gaveUp) throw new Error('gave up');
}

function dirBytes(dir) {
  let total = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    total += entry.isDirectory() ? dirBytes(path) : statSync(path).size;
  }
  return total;
}

const results = { scenario: opts.scenario, remote: opts.remote, branch };
const started = performance.now();
if (opts.scenario === 'big-note') {
  const id = A.createNote({ title: 'Big note', body: paragraphs(10_000) });
  timedSync(A);
  const words0 = P.readTitle(A.notes.get(id)) && P.noteBody(A.notes.get(id)).textContent.split(/\s+/).length;
  results.startWords = words0;
  results.startUpdateBytes = Y.encodeStateAsUpdate(A.notes.get(id)).length;
  const bursts = Number(opts.bursts);
  for (let i = 0; i < bursts; i++) {
    time += 60_000;
    burst(A, id);
    timedSync(A);
  }
  results.endWords = P.noteBody(A.notes.get(id)).textContent.split(/\s+/).length;
  results.endUpdateBytes = Y.encodeStateAsUpdate(A.notes.get(id)).length;
  results.compactedBytes = compacted(A.notes.get(id));
  results.measure = measure('big-note');
} else if (opts.scenario === 'daily-year') {
  const days = Number(opts.days);
  for (let d = 0; d < days; d++) {
    time = Date.UTC(2026, 0, 1, 14, 0, 0) + d * 86_400_000;
    const date = new Date(time).toISOString().slice(0, 10);
    const id = A.createDaily(date);
    for (let b = 0, n = 3 + rng.int(8); b < n; b++) burst(A, id);
    timedSync(A);
  }
  results.measure = measure('daily-year');
} else if (opts.scenario === 'thousand') {
  const folders = [];
  for (let f = 0; f < 20; f++) folders.push(A.createFolder(`Folder ${f + 1}`, f >= 10 ? folders[f - 10] : null));
  const n = Number(opts.notes);
  const ids = [];
  for (let i = 0; i < n; i++) {
    time += 1000;
    ids.push(A.createNote({ title: `Note ${i + 1} ${words(2)}`, folderId: rng.pick(folders), body: paragraphs(150 + rng.int(300)) }));
  }
  const t0 = performance.now();
  timedSync(A);
  results.firstCommitMs = Math.round(performance.now() - t0);
  syncTimes.length = 0;
  for (let i = 0; i < 50; i++) {
    time += 60_000;
    burst(A, rng.pick(ids));
    timedSync(A);
  }
  const t1 = performance.now();
  A.sync();
  results.noopSyncMs = Math.round(performance.now() - t1);
  const t2 = performance.now();
  A.renameFolder(folders[0], 'Folder one renamed');
  A.sync();
  results.folderRenameSyncMs = Math.round(performance.now() - t2);
  results.measure = measure('thousand');
}
results.totalSeconds = Math.round((performance.now() - started) / 1000);

/** What a compaction of one writer's log would be: the doc re-encoded (tombstones stay). */
function compacted(doc) {
  const fresh = new Y.Doc();
  Y.applyUpdate(fresh, Y.encodeStateAsUpdate(doc));
  return Y.encodeStateAsUpdate(fresh).length;
}

console.log(JSON.stringify(results, null, 2));
if (opts.json) {
  const { writeFileSync } = await import('node:fs');
  writeFileSync(opts.json, JSON.stringify(results, null, 2));
}
rmSync(scratch, { recursive: true, force: true });
