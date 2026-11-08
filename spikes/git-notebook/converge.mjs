#!/usr/bin/env node
// G0 convergence script (#148): random offline edits on three clones (two devices and an
// agent) of one notebook, random sync orders, and the listed scenarios in every run, then the
// acceptance checks. `node spikes/git-notebook/converge.mjs --runs 200`.
//
//   --runs N          runs, each with a random seed (default 20)
//   --seed S          one run with this seed (replays a failure)
//   --from S          seeds S, S+1, … (the same runs under two settings)
//   --steps N         random actions per run (default 60)
//   --remote local    a file:// bare repo per run (default)
//   --remote github   htxryan/penmoss-git-notebook-scratch (private), one branch per run
//   --dir docs/notes  a directory target inside a code repo
//   --committer       another committer pushes code (and a hand-made note) meanwhile
//   --keep            keep the run folders
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { checkConverged, checkHistory, checkRenders, CheckError } from './lib/check.mjs';
import { git, githubRemote, GitTransport, localRemote } from './lib/git.mjs';
import { Clone, rngFrom, WORDS } from './lib/notebook.mjs';
import { P } from './lib/penmoss.mjs';

const { values: opts } = parseArgs({
  options: {
    runs: { type: 'string', default: '20' },
    seed: { type: 'string' },
    from: { type: 'string' },
    steps: { type: 'string', default: '60' },
    remote: { type: 'string', default: 'local' },
    repo: { type: 'string', default: 'htxryan/penmoss-git-notebook-scratch' },
    dir: { type: 'string', default: '' },
    committer: { type: 'boolean', default: false },
    keep: { type: 'boolean', default: false },
    verbose: { type: 'boolean', default: false },
    json: { type: 'string' },
  },
});

const scratchRoot = join(tmpdir(), `pm-converge-${process.pid}`);
const token = opts.remote === 'github' ? execFileSync('gh', ['auth', 'token']).toString().trim() : null;
if (token) {
  // Penmoss writes only to private repositories (A761): check before the first push.
  const visibility = execFileSync('gh', ['api', `repos/${opts.repo}`, '--jq', '.visibility']).toString().trim();
  if (visibility !== 'private') throw new Error(`${opts.repo} is ${visibility}, not private: refusing to write to it`);
}

class Crash extends Error {}

/** A hook that runs once (a rebuild after a rejected push must not repeat it). */
const once = (f) => {
  let done = false;
  return (...args) => {
    if (done) return;
    done = true;
    f(...args);
  };
};

/** Titles: words, sometimes with characters files cannot hold (A201's sanitising). */
const title = (rng) => {
  const words = [rng.pick(WORDS), rng.pick(WORDS)];
  if (rng.chance(0.15)) words.push(rng.pick(['Q3: plan?', 'a/b', 'CON', '#tag', 'Résumé', 'notes.']));
  const t = words.join(' ');
  return t[0].toUpperCase() + t.slice(1);
};

export function runOnce(seed) {
  const rng = rngFrom(seed);
  const steps = Number(opts.steps);
  const dir = join(scratchRoot, `run-${seed}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const branch = opts.remote === 'github' ? `run-${seed}-${Date.now().toString(36)}` : 'main';
  const remote = opts.remote === 'github' ? githubRemote(opts.repo, token, join(dir, 'auth')) : localRemote(join(dir, 'remote.git'));
  const root = opts.dir ? `${opts.dir}/` : '';
  let time = Date.UTC(2026, 9, 29, 14, 0, 0);
  const clock = { now: () => time };
  const log = opts.verbose ? (m) => console.log(`  ${m}`) : () => {};
  const authors = new Set();
  const transport = (name) => {
    authors.add(`Penmoss ${name}`);
    return new GitTransport({
      path: join(dir, `clone-${name}`),
      remote,
      branch,
      dir: opts.dir,
      author: { name: `Penmoss ${name}`, email: `${name.toLowerCase()}@example.invalid` },
    });
  };

  // The code repo's other committer: a normal full clone pushing code (and, inside the
  // directory, a hand-made file Penmoss must leave alone).
  let other = null;
  if (opts.committer || opts.dir) {
    other = join(dir, 'other');
    mkdirSync(other);
    const run = (args, o = {}) => git(other, args, { env: { ...remoteEnv(remote), ...o.env }, ...o });
    run(['init', '--quiet', '--initial-branch', branch]);
    run(['remote', 'add', 'origin', remote.url]);
    writeOther(other, 'README.md', '# A code repository\n');
    writeOther(other, 'src/app.js', 'export const answer = 42;\n');
    if (opts.dir) writeOther(other, `${opts.dir}/README.md`, '# Team notes\n\nWritten by hand; Penmoss must leave it alone.\n');
    run(['add', '-A']);
    run(['commit', '--quiet', '-m', 'Initial code'], { env: committerEnv() });
    run(['push', '--quiet', 'origin', `HEAD:refs/heads/${branch}`]);
  }
  const otherPushes = { count: 0, files: new Map(), handEdits: 0, handMade: null };
  const otherCommit = () => {
    const run = (args, o = {}) => git(other, args, { env: { ...remoteEnv(remote), ...committerEnv() }, ...o });
    const file = `src/file-${otherPushes.count}.js`;
    const body = `export const n = ${otherPushes.count};\n`;
    for (let attempt = 0; attempt < 5; attempt++) {
      run(['fetch', '--quiet', 'origin', branch]);
      run(['reset', '--quiet', '--hard', `origin/${branch}`]);
      writeOther(other, file, body);
      if (rng.chance(0.3)) writeOther(other, 'README.md', `# A code repository\n\nEdit ${otherPushes.count}\n`);
      if (opts.dir && rng.chance(0.3)) {
        // A hand edit to a rendered note: Penmoss overwrites it on its next render (A743).
        const md = git(other, ['ls-files', '-z', '--', `${opts.dir}/*.md`]).toString().split('\0').filter((f) => f && !f.endsWith('README.md'));
        if (md.length) {
          const file = rng.pick(md);
          writeOther(other, file, `${readFileSync(join(other, file), 'utf8')}\nA line added by hand.\n`);
          otherPushes.handEdits++;
        }
      }
      if (opts.dir && rng.chance(0.15) && !otherPushes.handMade) {
        // A hand-made note named like one of Penmoss's ("Ideas"): Penmoss leaves it alone and
        // moves its own note to a suffixed name (A217).
        otherPushes.handMade = `${opts.dir}/Ideas.md`;
        writeOther(other, otherPushes.handMade, '# Ideas\n\nA note written by hand, no frontmatter.\n');
      }
      run(['add', '-A']);
      run(['commit', '--quiet', '-m', `Code change ${otherPushes.count}`]);
      const pushed = run(['push', '--quiet', 'origin', `HEAD:refs/heads/${branch}`], { ok: [0, 1] });
      if (pushed.status === 0) {
        otherPushes.files.set(file, body);
        otherPushes.count++;
        return;
      }
    }
    throw new Error('the other committer could not push');
  };

  const A = new Clone({ name: 'A', transport: transport('A').clone(), rng, clock, log });
  const B = new Clone({ name: 'B', transport: transport('B').clone(), rng, clock, log });
  const C = new Clone({ name: 'C', kind: 'agent', transport: transport('C').clone(), rng, clock, log });
  const clones = [A, B, C];
  const stats = { steps: 0, syncs: 0, interleaved: 0, crashes: 0, lostPushes: 0, copies: 0, purges: 0, otherPushes: 0 };
  const sparse = {};
  const special = { daily: null, sameTitle: [], purged: [], pinned: new Set() };

  // The first device makes the notebook; the others add the same remote.
  const work = A.createFolder('Work');
  const projects = A.createFolder('Projects', work);
  A.createNote({ title: 'Meeting', folderId: projects, body: 'First agenda item\n\nSecond item' });
  A.createNote({ title: 'Ideas', folderId: work, body: 'One idea' });
  A.sync();
  B.sync();
  C.sync();

  const live = (c) => c.liveNotes();
  const tick = () => (time += 1000 + rng.int(60_000));
  const syncOf = (c, hooks) => {
    stats.syncs++;
    const result = c.sync(hooks);
    if (result.gaveUp) throw new CheckError(`${c.name} gave up after retries`);
    return result;
  };
  const replace = (c, profile, keychain, name = c.name, t = c.t) => {
    const fresh = new Clone({ name, kind: c.kind, transport: t, rng, clock, log, profile, keychain });
    fresh.stats = c.stats;
    fresh.events = c.events;
    clones[clones.indexOf(c)] = fresh;
    return fresh;
  };

  // The scenarios #148 lists, each placed at a random step of every run.
  const scenarios = {
    sameDaily() {
      const [x, y] = [clones[0], clones[1]];
      const period = '2026-10-29';
      special.daily = x.createDaily(period);
      y.createDaily(period);
      x.editBody(special.daily, rng);
    },
    renames() {
      // One clone renames a note while another renames its folder (and a third moves it).
      const x = clones[0];
      const y = clones[1];
      const note = live(x).find((id) => P.readWorkspace(x.workspace).notes.find((n) => n.id === id)?.folderId === projects);
      if (!note || !y.notes.has(note)) return;
      x.renameNote(note, `${P.readTitle(x.notes.get(note))} renamed`);
      y.renameFolder(projects, 'Projects 2026');
      if (rng.chance(0.5)) clones[2].renameFolder(projects, 'Projects archive');
    },
    sameTitle() {
      const a = clones[0].createNote({ title: 'Standup', folderId: null, body: 'from A' });
      const b = clones[1].createNote({ title: 'Standup', folderId: null, body: 'from B' });
      special.sameTitle.push(a, b);
      special.pinned.add(a).add(b);
      // Both claim the name in commits that race: B builds, A lands first, B rebuilds.
      if (rng.chance(0.5)) syncOf(clones[1], { beforePush: once(() => syncOf(clones[0])) });
    },
    purgeWhileHeld() {
      const x = clones[0];
      const y = clones[1];
      const note = live(x).find((id) => y.notes.has(id) && !special.pinned.has(id) && id !== special.daily);
      if (!note) return;
      if (!P.isDeleted(y.notes.get(note))) y.editBody(note, rng, 3);
      x.purge(note);
      special.purged.push(note);
      stats.purges++;
    },
    crash() {
      const x = rng.pick(clones);
      if (live(x).length > 0) x.editBody(rng.pick(live(x)), rng);
      try {
        syncOf(x, { beforePush: () => { throw new Crash(); } });
      } catch (error) {
        if (!(error instanceof Crash)) throw error;
        stats.crashes++;
        replace(x, x.profile(), x.keychain);
      }
    },
    lostPush() {
      // The push landed but the app died before it recorded the new head.
      const x = rng.pick(clones);
      if (live(x).length > 0) x.editBody(rng.pick(live(x)), rng);
      try {
        syncOf(x, { afterPush: () => { throw new Crash(); } });
      } catch (error) {
        if (!(error instanceof Crash)) throw error;
        stats.lostPushes++;
        replace(x, x.profile(), x.keychain);
      }
    },
    copyProfile() {
      // A restored backup or a cloned data folder on another machine: same files, no secret.
      const source = clones[0];
      const name = 'D';
      const t = transport(name);
      cpSync(source.t.path, t.path, { recursive: true });
      const copy = new Clone({ name, kind: 'device', transport: t, rng, clock, log, profile: source.profile(), keychain: {} });
      clones.push(copy);
      stats.copies++;
      if (live(copy).length > 0) copy.editBody(rng.pick(live(copy)), rng);
    },
  };
  const placed = new Map();
  for (const name of Object.keys(scenarios)) {
    const at = rng.int(steps);
    placed.set(at, [...(placed.get(at) ?? []), name]);
  }

  for (let step = 0; step < steps; step++) {
    tick();
    stats.steps++;
    for (const name of placed.get(step) ?? []) {
      log(`step ${step}: scenario ${name}`);
      scenarios[name]();
    }
    const c = rng.pick(clones);
    const notes = live(c).filter((id) => !special.pinned.has(id));
    const folders = c.folders();
    const roll = rng();
    try {
      if (roll < 0.3 && notes.length > 0) c.editBody(rng.pick(notes), rng, 1 + rng.int(4));
      else if (roll < 0.38) c.createNote({ title: title(rng), folderId: folders.length && rng.chance(0.7) ? rng.pick(folders) : null, body: `${rng.pick(WORDS)} start` });
      else if (roll < 0.45 && notes.length > 0) c.renameNote(rng.pick(notes), title(rng));
      else if (roll < 0.48) c.createFolder(title(rng), folders.length && rng.chance(0.5) ? rng.pick(folders) : null);
      else if (roll < 0.52 && folders.length > 0) c.renameFolder(rng.pick(folders), title(rng));
      else if (roll < 0.56 && notes.length > 0) c.moveNote(rng.pick(notes), folders.length && rng.chance(0.8) ? rng.pick(folders) : null);
      else if (roll < 0.58 && folders.length > 1) c.moveFolder(rng.pick(folders), rng.chance(0.3) ? null : rng.pick(folders));
      else if (roll < 0.6 && notes.length > 0) c.trash(rng.pick(notes), true);
      else if (roll < 0.61) {
        const trashed = [...c.notes.keys()].filter((id) => P.isDeleted(c.notes.get(id)));
        if (trashed.length) c.trash(rng.pick(trashed), false);
      } else if (roll < 0.62 && notes.length > 2 && c.kind === 'device') {
        const id = rng.pick(notes);
        if (id !== special.daily) {
          c.purge(id);
          special.purged.push(id);
          stats.purges++;
        }
      } else if (roll < 0.86) syncOf(c, { checkRenderSet: true });
      else if (roll < 0.94) {
        // Interleaved: another clone syncs between this one's commit and its push.
        const d = rng.pick(clones.filter((x) => x !== c));
        let once = true;
        stats.interleaved++;
        syncOf(c, {
          checkRenderSet: true,
          beforePush: () => {
            if (!once) return;
            once = false;
            if (live(d).length) d.editBody(rng.pick(live(d)), rng);
            syncOf(d, { checkRenderSet: true });
          },
        });
      } else if (other) {
        otherCommit();
        stats.otherPushes++;
      }
    } catch (error) {
      if (error?.name !== 'WorkspaceError') throw error;
    }
  }

  // Everyone comes online: sync until a whole round commits nothing.
  let rounds = 0;
  const settle = () => {
    for (let round = 1; ; round++) {
      rounds++;
      if (other && round === 1) otherCommit();
      let commits = 0;
      for (const c of clones) if (syncOf(c, { checkRenderSet: true }).commit) commits++;
      if (commits === 0) return;
      if (round > 8) throw new CheckError(`no fixed point after ${round} rounds (ping-pong)`);
    }
  };
  settle();
  // Free the plain name: the note holding it is retitled. The other keeps its stored name
  // (A743: assigned once), so its file does not move.
  let freed = null;
  if (special.sameTitle.length === 2) {
    const [older, younger] = [...special.sameTitle].sort();
    const x = clones[0];
    if (x.notes.has(older) && x.notes.has(younger)) {
      const holder = [older, younger].find((id) => x.workspace.get('notes').getAttr(id)?.getAttr('fileName')?.name === 'Standup');
      if (holder) {
        x.renameNote(holder, 'Standup moved');
        freed = holder === older ? younger : older;
        settle();
      }
    }
  }
  checkConverged(clones);
  checkRenders(clones);
  const purges = clones.flatMap((c) => c.events.filter((e) => e.type === 'purge-pushed'));
  const history = checkHistory({ remote, branch, root, scratch: dir, purges, penmossAuthors: authors });
  for (const id of special.purged) {
    for (const c of clones) if (c.notes.has(id)) throw new CheckError(`${c.name} still holds purged ${id}`);
  }
  const misses = clones.reduce((n, c) => n + c.stats.renderSetMisses, 0);
  if (misses > 0) throw new CheckError(`render set missed ${misses} notes`);
  if (special.daily) {
    const doc = clones[0].notes.get(special.daily);
    const text = JSON.stringify(P.noteBody(doc).toJSON());
    const copies = text.split('Plan the day').length - 1;
    if (copies !== 1) throw new CheckError(`daily note holds the template ${copies} times`);
  }
  if (special.sameTitle.length === 2) {
    const [a, b] = special.sameTitle.sort();
    const names = clones[0].workspace.get('notes');
    const na = names.getAttr(a)?.getAttr('fileName')?.name;
    const nb = names.getAttr(b)?.getAttr('fileName')?.name;
    if (na !== undefined && nb !== undefined) {
      if (P.nameKey(na) === P.nameKey(nb)) throw new CheckError(`same-title notes share a name: ${na}`);
      if (!P.readTitle(clones[0].notes.get(a)).startsWith('Standup')) throw new CheckError('same-title note renamed');
      if (freed && (freed === a ? na : nb) === 'Standup') throw new CheckError('a stored name moved when the plain name was freed');
    }
  }
  if (other) {
    if (opts.dir) {
      // A partial clone with a sparse cone: nothing outside the directory is checked out
      // (files at the top are, as cone mode always includes them), and blobs outside it were
      // never fetched.
      const top = new Set(readdirSync(clones[0].t.path).filter((f) => f !== '.git'));
      for (const entry of top) {
        if (entry !== opts.dir.split('/')[0] && !entry.includes('.')) throw new CheckError(`sparse checkout has ${entry}/`);
      }
      if (readdirSync(join(clones[0].t.path, opts.dir.split('/')[0])).some((f) => f !== opts.dir.split('/')[1])) {
        throw new CheckError('sparse checkout has siblings of the directory');
      }
      const missing = git(clones[0].t.path, ['rev-list', '--objects', '--all', '--missing=print'], { env: remoteEnv(remote) })
        .toString()
        .split('\n')
        .filter((l) => l.startsWith('?')).length;
      sparse.missingBlobs = missing;
      if (otherPushes.count > 0 && missing === 0) throw new CheckError('the partial clone fetched every blob');
    }
    // The other committer's files are exactly as they pushed them (these reads fetch blobs).
    const final = clones[0].lastHead;
    for (const [file, body] of otherPushes.files) {
      const bytes = clones[0].t.readAt(final, file);
      if (!bytes || bytes.toString() !== body) throw new CheckError(`other committer's ${file} changed`);
    }
    if (otherPushes.handMade) {
      const bytes = clones[0].t.readAt(final, otherPushes.handMade);
      if (!bytes || !bytes.toString().includes('written by hand')) throw new CheckError('hand-made note in the directory changed');
    }
    if (opts.dir) {
      const readme = clones[0].t.readAt(final, `${opts.dir}/README.md`);
      if (!readme || !readme.toString().includes('Written by hand')) throw new CheckError('hand-made README in the directory changed');
    }
  }
  const t = clones.map((c) => c.t.stats);
  const summary = {
    seed,
    ...stats,
    rounds,
    clones: clones.length,
    notes: clones[0].notes.size,
    commits: history.penmossCommits,
    allCommits: history.commits,
    renames: history.renames,
    rejectedPushes: t.reduce((n, s) => n + s.rejected, 0),
    rendered: clones.reduce((n, c) => n + c.stats.rendered, 0),
    newWriters: clones.flatMap((c) => c.events.filter((e) => e.type === 'new-writer')).length,
    filterIgnored: clones.some((c) => c.t.filterIgnored),
    logBytes: [...clones[0].t.list(clones[0].lastHead)].filter(([p]) => p.startsWith(`${root}.penmoss/`) && p.endsWith('.yjs')).reduce((n, [p]) => n + (clones[0].t.read(p)?.length ?? 0), 0),
    handEdits: otherPushes.handEdits,
    handEditsOverwritten: clones.flatMap((c) => c.events.filter((e) => e.type === 'overwrote-hand-edit')).length,
    handMade: Boolean(otherPushes.handMade),
    ...sparse,
  };
  if (opts.remote === 'github') {
    // Each run's branch goes, except the first one an empty repository got, which GitHub made
    // its default branch and will not delete.
    git(join(dir, 'clone-A'), ['push', '--quiet', 'origin', '--delete', branch], { env: remoteEnv(remote), ok: [0, 1] });
  }
  if (!opts.keep) rmSync(dir, { recursive: true, force: true });
  return summary;
}

function remoteEnv(remote) {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    ...remote.env,
  };
}

function committerEnv() {
  return {
    GIT_AUTHOR_NAME: 'A Colleague',
    GIT_AUTHOR_EMAIL: 'colleague@example.invalid',
    GIT_COMMITTER_NAME: 'A Colleague',
    GIT_COMMITTER_EMAIL: 'colleague@example.invalid',
  };
}

function writeOther(root, file, text) {
  const path = join(root, file);
  mkdirSync(join(path, '..'), { recursive: true });
  execFileSync('sh', ['-c', 'cat > "$1"', 'sh', path], { input: text });
}

// ---------------------------------------------------------------------------------------------

const seeds = opts.seed
  ? [Number(opts.seed)]
  : opts.from
    ? Array.from({ length: Number(opts.runs) }, (_, i) => Number(opts.from) + i)
    : Array.from({ length: Number(opts.runs) }, () => Math.floor(Math.random() * 2 ** 31));
const started = performance.now();
const results = [];
let failed = 0;
for (const [i, seed] of seeds.entries()) {
  const t0 = performance.now();
  try {
    const summary = runOnce(seed);
    summary.ms = Math.round(performance.now() - t0);
    results.push(summary);
    console.log(
      `run ${i + 1}/${seeds.length} seed ${seed}: ok — ${summary.commits} commits, ${summary.rejectedPushes} rejected pushes, ` +
        `${summary.notes} notes, renames ${JSON.stringify(summary.renames)}, ${summary.crashes} crash, ${summary.lostPushes} lost push, ` +
        `${summary.purges} purges, ${summary.newWriters} new writer, ${summary.otherPushes} other pushes, ${summary.ms} ms`,
    );
  } catch (error) {
    failed++;
    results.push({ seed, failed: String(error.stack ?? error) });
    console.error(`run ${i + 1}/${seeds.length} seed ${seed}: FAILED — ${error.stack ?? error}`);
    if (seeds.length === 1) process.exitCode = 1;
  }
}
const total = results.filter((r) => !r.failed).reduce(
  (acc, r) => {
    for (const key of ['logBytes', 'commits', 'rejectedPushes', 'crashes', 'lostPushes', 'purges', 'newWriters', 'interleaved', 'otherPushes']) acc[key] = (acc[key] ?? 0) + r[key];
    for (const [k, v] of Object.entries(r.renames)) acc.renames[k] = (acc.renames[k] ?? 0) + v;
    return acc;
  },
  { renames: {} },
);
console.log(
  `\n${seeds.length - failed}/${seeds.length} runs green in ${((performance.now() - started) / 1000).toFixed(1)} s ` +
    `(remote ${opts.remote}${opts.dir ? `, dir ${opts.dir}` : ''}${opts.committer ? ', other committer' : ''}). Totals: ${JSON.stringify(total)}`,
);
if (opts.json) {
  const { writeFileSync } = await import('node:fs');
  writeFileSync(opts.json, JSON.stringify({ opts, failed, total, results }, null, 2));
}
if (!opts.keep) rmSync(scratchRoot, { recursive: true, force: true });
if (failed > 0) process.exitCode = 1;
