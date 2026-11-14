/**
 * How History reads (Ryan's review of #192, finding 10): the list from the log alone, then every
 * version's summary read together through `readDir` (only the note's directory, never the whole
 * tree), each version read once for the reader's life. The answers are the same as reading each
 * commit on its own (a transport without `readDir`), over the in-memory transport and system git
 * on a fresh partial clone.
 */
import { NOTE_ROOT } from '@penmoss/sync-client/replica';
import * as Y from '@y/y';
import { afterEach, describe, expect, it } from 'vitest';
import { GitTransportError, Layout, NotebookHistory, type GitTransport } from '../src';
import { longHistory, type LongHistory } from './support/long-history';
import { testNotebook } from './support/notebooks';

/**
 * The transport's reads, counted (`calls`), with each `readDir`'s commits (`dirs`). Without
 * `readDir` when `batched` is false: as Android's or GitHub's, History lists and reads each commit.
 */
function counted(transport: GitTransport, batched = true) {
  const calls: Record<string, number> = {};
  const dirs: string[][] = [];
  const count = (name: string) => {
    calls[name] = (calls[name] ?? 0) + 1;
  };
  const proxy: GitTransport = {
    root: transport.root,
    fetch: () => transport.fetch(),
    list: (head) => (count('list'), transport.list(head)),
    changed: (from, to) => transport.changed(from, to),
    read: (head, paths) => (count('read'), transport.read(head, paths)),
    commit: (head, changes, message) => transport.commit(head, changes, message),
    push: (commit) => transport.push(commit),
    log: (options) => (count('log'), transport.log(options)),
    readAt: (commit, path) => (count('readAt'), transport.readAt(commit, path)),
    ...(batched && transport.readDir
      ? {
          readDir: (commits: readonly string[], dir: string) => {
            count('readDir');
            dirs.push([...commits]);
            return transport.readDir!(commits, dir);
          },
        }
      : {}),
  };
  return { proxy, calls, dirs };
}

async function edited(times: number) {
  const nb = testNotebook();
  const mac = await nb.open('Mac', { create: true });
  for (let i = 0; i < 30; i++) mac.ops.createNote({ title: `Other ${i}`, markdown: `x ${i}` });
  const id = mac.ops.createNote({ title: 'Plan', markdown: 'first line' });
  await mac.engine.sync();
  const agent = await nb.open('Claude Code', { kind: 'agent' });
  for (let i = 0; i < times; i++) {
    const by = i % 2 === 0 ? mac : agent;
    nb.tick();
    await by.engine.sync();
    const doc = by.engine.replica.note(id)!;
    doc.transact(() => {
      const p = new Y.Node('paragraph');
      doc.get(NOTE_ROOT).insert(doc.get(NOTE_ROOT).length, [p]);
      p.insert(0, `line ${i}`);
    });
    await by.engine.sync();
  }
  return { mac, id };
}

describe('History reads in batches (in memory)', () => {
  it('lists from the log alone, then reads every summary in one read', async () => {
    const { mac, id } = await edited(6);
    const { proxy, calls } = counted(mac.engine.transport);
    const history = new NotebookHistory(proxy, mac.engine.layout);

    const listed = await history.versions(id, { limit: 100 });
    expect(listed.versions.map((v) => v.id)).toEqual([7, 6, 5, 4, 3, 2, 1]);
    expect(listed.versions.every((v) => v.summary === '')).toBe(true);
    expect(calls).toEqual({ log: 1 });

    const summaries = await history.summaries(id, listed.versions);
    // Each version added a line (the first, its title's note made with one).
    expect([...summaries.values()]).toEqual(Array(7).fill('+1 −0 line'));
    expect(calls).toEqual({ log: 1, readDir: 1 });

    // Read again (a History opened again): the log only; every summary is known.
    const again = await history.history(id, { limit: 100 });
    expect(again.versions.map((v) => v.summary)).toEqual([...summaries.values()]);
    expect(calls).toEqual({ log: 2, readDir: 1 });

    // History's rows, with a few words on each change (Ryan's review of #192, finding 13): read
    // with the summaries, so nothing more.
    const described = await history.descriptions(id, listed.versions);
    expect([...described.values()].map((change) => change.summary)).toEqual([
      ...summaries.values(),
    ]);
    expect([...described.values()].every((change) => change.gist.startsWith('Added “'))).toBe(true);
    expect(calls).toEqual({ log: 2, readDir: 1 });
  });

  it('reads only the versions made since, opened again', async () => {
    const { mac, id } = await edited(2);
    const { proxy, dirs: read } = counted(mac.engine.transport);
    const history = new NotebookHistory(proxy, mac.engine.layout);
    await history.history(id);
    expect(read).toEqual([expect.any(Array)]);
    expect(read[0]).toHaveLength(3);
    const doc = mac.engine.replica.note(id)!;
    doc.transact(() => {
      const p = new Y.Node('paragraph');
      doc.get(NOTE_ROOT).insert(doc.get(NOTE_ROOT).length, [p]);
      p.insert(0, 'one more');
    });
    await mac.engine.sync();
    const again = await history.history(id);
    expect(again.versions.map((v) => v.id)).toEqual([4, 3, 2, 1]);
    expect(again.versions[0]!.summary).toBe('+1 −0 line');
    // Only the new version's commit: the one before it was read last time.
    expect(read).toHaveLength(2);
    expect(read[1]).toEqual([again.versions[0]!.commit]);
  });

  it('gives the same answers as reading each commit on its own', async () => {
    const { mac, id } = await edited(5);
    const batched = new NotebookHistory(mac.engine.transport, mac.engine.layout);
    const single = new NotebookHistory(
      counted(mac.engine.transport, false).proxy,
      mac.engine.layout,
    );
    expect(await batched.history(id, { limit: 3 })).toEqual(await single.history(id, { limit: 3 }));
    expect(await batched.detail(id, 4)).toEqual(await single.detail(id, 4));
    expect(await batched.stateAt(id, (await batched.commitOf(id, 2))!.commit.id)).toEqual(
      await single.stateAt(id, (await single.commitOf(id, 2))!.commit.id),
    );
  });
});

describe('History over system git on a partial clone', () => {
  let fixture: LongHistory | null = null;
  afterEach(() => {
    fixture?.box.cleanup();
    fixture = null;
  });

  it('reads a note’s directory at many commits in one go, with the blobs it lacked', async () => {
    fixture = await longHistory({ notes: 40, edits: 6 });
    const reader = await fixture.reader();
    const layout = new Layout('');
    const dir = layout.noteDir(fixture.noteId);
    const commits = (await reader.log({ paths: [dir] })).map((c) => c.id);
    // Asked twice, a commit is read once.
    const { files, blobs } = await reader.readDir([...commits, commits[0]!], dir);
    expect(files.size).toBe(commits.length);
    for (const commit of commits) {
      const listed = files.get(commit)!;
      // Only the note's own logs, each as list and read give them.
      expect([...listed.keys()].every((path) => path.startsWith(dir))).toBe(true);
      expect(listed.size).toBeGreaterThan(0);
      const all = await reader.list(commit);
      const read = await reader.read(commit, [...listed.keys()]);
      for (const [path, blob] of listed) {
        expect(all.get(path)).toBe(blob);
        expect(blobs.get(blob)).toEqual(read.get(path));
      }
    }
    // A directory outside the notebook, or up and out of it, is refused.
    await expect(reader.readDir([commits[0]!], '../x/')).rejects.toBeInstanceOf(GitTransportError);
    await expect(reader.readDir([commits[0]!], '.penmoss/notes')).rejects.toBeInstanceOf(
      GitTransportError,
    );
    // A directory a commit does not have: no files.
    const none = await reader.readDir([commits[0]!], '.penmoss/notes/01JBNONE0000000000000000000/');
    expect(none.files.get(commits[0]!)!.size).toBe(0);
  });

  it('lists, summarises and details as reading each commit does', async () => {
    fixture = await longHistory({ notes: 40, edits: 8 });
    const layout = new Layout('');
    const batchedClone = await fixture.reader('batched');
    const singleClone = await fixture.reader('single');
    const { proxy, calls } = counted(batchedClone);
    const batched = new NotebookHistory(proxy, layout);
    const single = new NotebookHistory(counted(singleClone, false).proxy, layout);
    const got = await batched.history(fixture.noteId, { limit: 100 });
    expect(got).toEqual(await single.history(fixture.noteId, { limit: 100 }));
    expect(got.versions).toHaveLength(9);
    expect(got.versions.map((v) => v.authors[0]!.label)[0]).toBe('Mac');
    expect(got.versions.slice(0, 8).every((v) => v.summary === '+1 −0 line')).toBe(true);
    // One log and one read for the whole list, not a listing and a read per version.
    expect(calls).toEqual({ log: 1, readDir: 1 });
    expect(await batched.detail(fixture.noteId, 5)).toEqual(await single.detail(fixture.noteId, 5));
  });
});
