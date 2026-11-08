// The G0 acceptance checks (#148) over a finished run: every clone holds the same docs and the
// same rendered tree, the history renamed no file except on a concurrent name claim, a purged
// note never came back, and nothing outside the directory changed.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { P } from './penmoss.mjs';
import { git, gitEnv } from './git.mjs';
import { CLAIMS, contentIdsEqual, frontmatterId, layout, noteContent, workspaceContent } from './notebook.mjs';

const { Y } = P;
const dec = new TextDecoder();

export class CheckError extends Error {}
const fail = (message) => {
  throw new CheckError(message);
};

/** Every clone: same head, same WorkspaceDoc and note docs (content and content ids). */
export function checkConverged(clones) {
  const [first, ...rest] = clones;
  const heads = clones.map((c) => c.lastHead);
  if (new Set(heads).size !== 1) fail(`clones end on different heads: ${heads.join(' ')}`);
  const ws = workspaceContent(first.workspace);
  const ids = [...first.notes.keys()].sort();
  for (const c of rest) {
    if (workspaceContent(c.workspace) !== ws) fail(`${c.name}'s WorkspaceDoc differs from ${first.name}'s: ${firstDiff(ws, workspaceContent(c.workspace))}`);
    if (!contentIdsEqual(c.workspace, first.workspace)) fail(`${c.name}'s WorkspaceDoc ids differ`);
    if (!sameSv(c.workspace, first.workspace)) fail(`${c.name}'s WorkspaceDoc state vector differs`);
    const theirs = [...c.notes.keys()].sort();
    if (theirs.join() !== ids.join()) fail(`${c.name} holds notes ${theirs.length} vs ${ids.length}`);
    for (const id of ids) {
      const a = first.notes.get(id);
      const b = c.notes.get(id);
      if (noteContent(a) !== noteContent(b)) fail(`note ${id} differs between ${first.name} and ${c.name}`);
      if (!contentIdsEqual(a, b) || !sameSv(a, b)) fail(`note ${id}'s ids differ between ${first.name} and ${c.name}`);
    }
  }
}

function firstDiff(a, b) {
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  return `…${a.slice(Math.max(0, i - 120), i + 120)}\n  vs …${b.slice(Math.max(0, i - 120), i + 120)}`;
}

function sameSv(a, b) {
  const x = Y.decodeStateVector(Y.encodeStateVector(a));
  const y = Y.decodeStateVector(Y.encodeStateVector(b));
  if (x.size !== y.size) return false;
  for (const [k, v] of x) if (y.get(k) !== v) return false;
  return true;
}

/** Each clone renders its own state in full; the bytes must equal the head's files exactly. */
export function checkRenders(clones) {
  for (const c of clones) {
    const head = c.lastHead;
    c.t.checkout(head);
    const files = c.t.list(head);
    const read = (path) => c.t.read(path);
    const { out, foreign } = c.fullRender(files, read);
    for (const [path, markdown] of out) {
      const bytes = read(path);
      if (!bytes) fail(`${c.name}: ${path} is not at head`);
      if (dec.decode(bytes) !== markdown) fail(`${c.name}: ${path} at head differs from its own render`);
    }
    for (const [path] of foreign.penmoss) if (!out.has(path)) fail(`${c.name}: stale Penmoss file ${path} at head`);
  }
}

/**
 * Walks the branch's history in a full clone: Penmoss commits change only paths under the
 * directory; a note's file moves only for its title, its folder, or a lost concurrent claim
 * (another, older note took the name); purged notes never return after their purge commit.
 */
export function checkHistory({ remote, branch, root, scratch, purges, penmossAuthors }) {
  const path = join(scratch, 'history');
  mkdirSync(path, { recursive: true });
  const env = gitEnv(remote.env);
  const run = (args, opts = {}) => git(path, args, { env, ...opts });
  run(['init', '--quiet', '--bare']);
  run(['fetch', '--quiet', '--no-tags', remote.url, `+refs/heads/${branch}:refs/heads/${branch}`]);
  // The repository is sound: no missing or corrupt objects in what the writers pushed.
  run(['fsck', '--no-progress', '--no-dangling', branch]);
  const commits = run(['rev-list', '--reverse', '--first-parent', branch]).toString().trim().split('\n');
  // Linear: every commit has one parent (no merge ever ran, A742).
  const merges = run(['rev-list', '--merges', branch]).toString().trim();
  if (merges) fail(`merge commits on the branch: ${merges.split('\n').length}`);
  const L = layout(root);
  const report = { commits: commits.length, penmossCommits: 0, renames: { title: 0, folder: 0, clash: 0, foreign: 0 }, outside: 0 };
  let previous = null;
  const purgeIndex = new Map();
  commits.forEach((c, i) => {
    for (const p of purges) if (p.commit === c) purgeIndex.set(p.noteId, i);
  });
  for (let i = 0; i < commits.length; i++) {
    const c = commits[i];
    const author = run(['log', '-1', '--format=%an%x00%s', c]).toString().trim().split('\0');
    const isPenmoss = penmossAuthors.has(author[0]);
    if (isPenmoss) {
      report.penmossCommits++;
      if (!/^Penmoss: \d+ notes? \[skip ci\]$/.test(author[1])) fail(`commit ${c} message: ${author[1]}`);
      if (i > 0) {
        const touched = run(['diff', '--name-only', '-z', '--no-renames', commits[i - 1], c]).toString().split('\0').filter(Boolean);
        const outside = touched.filter((p) => !p.startsWith(root));
        if (outside.length > 0) {
          report.outside += outside.length;
          fail(`Penmoss commit ${c} changed files outside ${root || '/'}: ${outside.join(', ')}`);
        }
      }
    }
    const listing = run(['ls-tree', '-r', '--full-tree', '-z', c]).toString().split('\0').filter(Boolean);
    const blobs = listing.map((line) => [line.slice(line.indexOf('\t') + 1), line.split(' ')[2].split('\t')[0]]);
    const mds = blobs.filter(([p]) => p.startsWith(root) && p.endsWith('.md') && !p.startsWith(L.base));
    const contents = catBlobs(run, mds.map(([, sha]) => sha));
    const notes = new Map();
    const foreignKeys = new Set();
    mds.forEach(([p], k) => {
      const bytes = contents[k];
      const id = frontmatterId(bytes);
      const name = p.slice(p.lastIndexOf('/') + 1, -3);
      if (!id) {
        foreignKeys.add(P.nameKey(name));
        return;
      }
      const fm = /^---\n([\s\S]*?)\n---\n/.exec(dec.decode(bytes));
      const title = fm ? (P.parseYaml(fm[1])?.title ?? '') : '';
      notes.set(id, { path: p, name, dir: p.slice(0, p.lastIndexOf('/') + 1), base: P.noteName(String(title)) });
    });
    for (const [id, at] of purgeIndex) {
      if (i < at) continue;
      if (blobs.some(([p]) => p.startsWith(L.noteDir(id)))) fail(`purged note ${id} has logs again at ${c}`);
      if (notes.has(id)) fail(`purged note ${id} has a file again at ${c}`);
    }
    if (previous) {
      for (const [id, now] of notes) {
        const before = previous.get(id);
        if (!before || before.path === now.path) continue;
        if (before.base !== now.base) report.renames.title++;
        else if (before.dir !== now.dir) report.renames.folder++;
        else {
          const holder = [...notes].find(([other, n]) => other !== id && P.nameKey(n.name) === P.nameKey(before.name));
          if (holder && holder[0] < id && CLAIMS === 'local') report.renames.clash++;
          else if (holder && holder[0] < id) fail(`note ${id} lost its committed name ${before.name} to ${holder[0]} at ${c}, though claims ride only in landed commits`);
          else if (foreignKeys.has(P.nameKey(before.name))) report.renames.foreign++;
          else fail(`note ${id} renamed ${before.path} → ${now.path} at ${c} with no cause`);
        }
      }
    }
    previous = notes;
  }
  return report;
}

function catBlobs(run, shas) {
  if (shas.length === 0) return [];
  const out = run(['cat-file', '--batch'], { input: shas.join('\n') + '\n' });
  const result = [];
  let at = 0;
  for (let k = 0; k < shas.length; k++) {
    const nl = out.indexOf(10, at);
    const size = Number(out.subarray(at, nl).toString().split(' ')[2]);
    result.push(out.subarray(nl + 1, nl + 1 + size));
    at = nl + 1 + size + 1;
  }
  return result;
}
