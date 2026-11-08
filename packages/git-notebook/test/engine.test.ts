/**
 * The engine's acceptance criteria one by one (T50 G1, #149), over the in-memory transport. The
 * property runs (converge.test.ts) mix all of these at random; here each has a test of its own.
 */
import { MAX_PATH_CHARS } from '@penmoss/core/mirror';
import { periodicNoteId } from '@penmoss/core/periodic';
import { bodyMarkdown } from '@penmoss/editor/markdown';
import { isDeleted, readTitle, setTitle } from '@penmoss/sync-client/note';
import { NOTE_ROOT } from '@penmoss/sync-client/replica';
import { readWorkspace } from '@penmoss/sync-client/workspace';
import * as Y from '@y/y';
import { describe, expect, it, vi } from 'vitest';
import {
  attributionMap,
  commitMessage,
  GitTransportError,
  Layout,
  MemorySecrets,
  NOTE_NAME_ATTR,
  NotebookError,
  parseActor,
  RENDER_VERSION,
  isPurged,
  WORKSPACE_PURGED_FROM,
  unmarkPurged,
} from '../src';
import { FORMAT } from '../src/layout';
import { NOTEBOOK_ID, testNotebook, titles, type TestClone } from './support/notebooks';

const decoder = new TextDecoder();

function append(clone: TestClone, noteId: string, text: string): void {
  const doc = clone.engine.replica.note(noteId)!;
  doc.transact(() => {
    const p = new Y.Node('paragraph');
    doc.get(NOTE_ROOT).insert(doc.get(NOTE_ROOT).length, [p]);
    p.insert(0, text);
  });
}

function nameOf(clone: TestClone, noteId: string): string | undefined {
  const node: unknown = clone.engine.replica.workspace.get('notes').getAttr(noteId);
  return node instanceof Y.Node
    ? (node.getAttr(NOTE_NAME_ATTR) as { name: string } | undefined)?.name
    : undefined;
}

describe('the layout and a first sync', () => {
  it('writes notebook.json, its own logs and actor file, and the rendered note', async () => {
    const nb = testNotebook();
    const a = await nb.open('A', { create: true });
    const work = a.ops.createFolder({ name: 'Work', parentId: null });
    const id = a.ops.createNote({ title: 'Meeting', folderId: work, markdown: 'Agenda' });
    const report = await a.engine.sync();
    expect(report.commit).not.toBeNull();
    const writer = a.engine.writer!.id;
    expect(nb.files()).toEqual(
      [
        '.penmoss/notebook.json',
        `.penmoss/actors/${writer}.json`,
        `.penmoss/workspace/${writer}.yjs`,
        `.penmoss/notes/${id}/${writer}.yjs`,
        'Work/Meeting.md',
      ].sort(),
    );
    const head = nb.head()!;
    expect(JSON.parse(decoder.decode(nb.remote.read(head, '.penmoss/notebook.json')!))).toEqual({
      id: NOTEBOOK_ID,
      name: 'Work',
      format: 1,
      renderVersion: RENDER_VERSION,
    });
    expect(nb.remote.commits.get(head)!.message).toBe(commitMessage(1, a.engine.writer!));
    // The author is the device's git identity; the trailer names the writer (A825).
    expect(commitMessage(1, a.engine.writer!)).toBe(
      `Penmoss: 1 note [skip ci]\n\nPenmoss-Writer: ${writer} (device "A")\n`,
    );
    expect(commitMessage(1)).toBe('Penmoss: 1 note [skip ci]');
    expect(commitMessage(3)).toBe('Penmoss: 3 notes [skip ci]');
    const md = nb.rendered().get('Work/Meeting.md')!;
    expect(md).toMatch(new RegExp(`^---\\nid: ${id}\\ntitle: Meeting\\n`));
    expect(md).toContain('Agenda');
  });

  it('a second device joins the same notebook, and their renders are byte-identical', async () => {
    const nb = testNotebook();
    const a = await nb.open('A', { create: true });
    const id = a.ops.createNote({ title: 'Plan', markdown: 'one' });
    await a.engine.sync();
    const b = await nb.open('B');
    const joined = await b.engine.sync();
    expect(joined.commit).toBeNull(); // Nothing of its own yet: it only read.
    expect(b.engine.info?.id).toBe(NOTEBOOK_ID);
    expect(titles(b)).toEqual(['Plan']);
    append(b, id, 'two');
    expect((await b.engine.sync()).commit).not.toBeNull();
    const pulled = await a.engine.sync();
    expect(pulled.changed).toEqual([id]);
    expect(bodyMarkdown(a.engine.replica.note(id)!)).toBe('one\n\ntwo\n');
    expect((await a.engine.renderAll(nb.head()!)).wanted).toEqual(
      (await b.engine.renderAll(nb.head()!)).wanted,
    );
  });

  it('refuses to join a target that holds no notebook', async () => {
    const nb = testNotebook();
    const b = await nb.open('B');
    await expect(b.engine.sync()).rejects.toMatchObject({ code: 'no_notebook' });
  });

  it('refuses a notebook format newer than it knows, and a target holding another notebook', async () => {
    const nb = testNotebook();
    await nb.remote.commitAs(nb.branch, {
      '.penmoss/notebook.json': JSON.stringify({
        id: NOTEBOOK_ID,
        name: 'Work',
        format: FORMAT + 1,
        renderVersion: 1,
      }),
    });
    const b = await nb.open('B');
    await expect(b.engine.sync()).rejects.toMatchObject({ code: 'format' });
    const other = testNotebook();
    await other.remote.commitAs(other.branch, {
      '.penmoss/notebook.json': JSON.stringify({
        id: '01JBOTHER00000000000000001',
        name: 'Other',
        format: 1,
        renderVersion: 1,
      }),
    });
    const c = await other.open('C', { create: true });
    const error = await c.engine.sync().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NotebookError);
    expect((error as NotebookError).code).toBe('other_notebook');
  });
});

describe('own files (A821)', () => {
  it('a writer that changed nothing commits nothing when another deletes text (content ids)', async () => {
    const nb = testNotebook();
    const a = await nb.open('A', { create: true });
    const id = a.ops.createNote({ title: 'Plan', markdown: 'one two three' });
    await a.engine.sync();
    const b = await nb.open('B');
    await b.engine.sync();
    const doc = a.engine.replica.note(id)!;
    const paragraph = doc.get(NOTE_ROOT).toArray()[0] as Y.Node;
    paragraph.delete(0, 4);
    await a.engine.sync();
    const again = await b.engine.sync();
    expect(again.changed).toEqual([id]);
    expect(again.commit).toBeNull();
  });

  it('a writer writes only its own logs', async () => {
    const nb = testNotebook();
    const a = await nb.open('A', { create: true });
    const id = a.ops.createNote({ title: 'Plan', markdown: 'a' });
    await a.engine.sync();
    const b = await nb.open('B');
    await b.engine.sync();
    const aFiles = nb.files().filter((path) => path.includes(a.engine.writer!.id));
    const before = new Map(aFiles.map((path) => [path, nb.remote.read(nb.head()!, path)]));
    append(b, id, 'from b');
    await b.engine.sync();
    for (const [path, bytes] of before) expect(nb.remote.read(nb.head()!, path)).toEqual(bytes);
    expect(nb.files()).toContain(`.penmoss/notes/${id}/${b.engine.writer!.id}.yjs`);
  });

  it('`updated` is the latest per-writer change, never a shared key (A823)', async () => {
    const nb = testNotebook();
    const a = await nb.open('A', { create: true });
    const id = a.ops.createNote({ title: 'Plan', markdown: 'a' });
    await a.engine.sync();
    const b = await nb.open('B');
    await b.engine.sync();
    nb.tick(3_600_000);
    append(b, id, 'later');
    await b.engine.sync();
    await a.engine.sync();
    const meta = a.engine.replica.note(id)!.get('meta').getAttrs() as Record<string, unknown>;
    const keys = Object.keys(meta)
      .filter((key) => key.startsWith('changedAt/'))
      .sort();
    expect(keys).toEqual(
      [`changedAt/${a.engine.writer!.id}`, `changedAt/${b.engine.writer!.id}`].sort(),
    );
    expect(nb.rendered().get('Plan.md')).toContain('updated: 2026-10-29T10:00:00-05:00');
  });

  it('actor files are unions of the ids each writer used, and attribute every change (A829)', async () => {
    const nb = testNotebook();
    const a = await nb.open('A', { create: true, kind: 'device' });
    a.ops.createNote({ title: 'Plan', markdown: 'a' });
    await a.engine.sync();
    const c = await nb.open('Claude', { kind: 'agent' });
    await c.engine.sync();
    const id = c.ops.createNote({ title: 'From the agent', markdown: 'b' });
    await c.engine.sync();
    const layout = new Layout('');
    const actors = new Map(
      [a, c].map((clone) => [
        clone.engine.writer!.id,
        parseActor(nb.remote.read(nb.head()!, layout.actor(clone.engine.writer!.id)))!,
      ]),
    );
    expect(actors.get(c.engine.writer!.id)).toMatchObject({ kind: 'agent', label: 'Claude' });
    const byClient = attributionMap(actors);
    const writerOf = (doc: Y.Doc) =>
      [...Y.decodeStateVector(Y.encodeStateVector(doc)).keys()].map(
        (client) => byClient.get(client)?.label,
      );
    expect(writerOf(c.engine.replica.note(id)!)).toEqual(['Claude']);
  });
});

describe('names and paths (A823)', () => {
  it('a committed file is never renamed by a later note, an offline one with an older id included', async () => {
    const nb = testNotebook();
    const a = await nb.open('A', { create: true });
    await a.engine.sync();
    const b = await nb.open('B');
    await b.engine.sync();
    // B makes "Standup" first (the older id) but offline; A's lands first.
    const older = b.ops.createNote({ title: 'Standup', markdown: 'b' });
    nb.tick();
    const newer = a.ops.createNote({ title: 'Standup', markdown: 'a' });
    expect(older < newer).toBe(true);
    await a.engine.sync();
    expect(nb.rendered().has('Standup.md')).toBe(true);
    await b.engine.sync();
    await a.engine.sync();
    const files = [...nb.rendered().keys()].sort();
    expect(files).toEqual(['Standup.md', `Standup (${older.slice(-7)}).md`].sort());
    expect(nb.rendered().get('Standup.md')).toContain(`id: ${newer}`);
    // Every writer agrees, and freeing the plain name moves nothing.
    expect(nameOf(a, newer)).toBe('Standup');
    expect(nameOf(b, newer)).toBe('Standup');
    setTitle(a.engine.replica.note(newer)!, 'Standup moved');
    await a.engine.sync();
    await b.engine.sync();
    expect(nb.rendered().has(`Standup (${older.slice(-7)}).md`)).toBe(true);
  });

  it('two new notes named in one render: the older id takes the plain name', async () => {
    const nb = testNotebook();
    const a = await nb.open('A', { create: true });
    const first = a.ops.createNote({ title: 'Notes', markdown: '1' });
    nb.tick();
    const second = a.ops.createNote({ title: 'notes', markdown: '2' });
    await a.engine.sync();
    expect(nb.rendered().get('Notes.md')).toContain(`id: ${first}`);
    expect(nb.rendered().get(`notes (${second.slice(-7)}).md`)).toContain(`id: ${second}`);
  });

  it('deleting one of two same-named folders does not rename the other (A212)', async () => {
    const nb = testNotebook();
    const a = await nb.open('A', { create: true });
    const one = a.ops.createFolder({ name: 'Work', parentId: null });
    nb.tick();
    const two = a.ops.createFolder({ name: 'work', parentId: null });
    a.ops.createNote({ title: 'In two', folderId: two, markdown: 'x' });
    await a.engine.sync();
    const path = [...nb.rendered().keys()].find((p) => p.endsWith('In two.md'))!;
    expect(path).toBe(`work (${two.slice(-7)})/In two.md`);
    a.ops.deleteFolder(one);
    await a.engine.sync();
    expect(nb.rendered().has(path)).toBe(true);
  });

  it('a renamed folder moves its notes, with relative attachment paths, and their linkers', async () => {
    const nb = testNotebook();
    const a = await nb.open('A', { create: true });
    const work = a.ops.createFolder({ name: 'Work', parentId: null });
    const deep = a.ops.createFolder({ name: 'Deep', parentId: work });
    const target = a.ops.createNote({
      title: 'Target',
      folderId: deep,
      markdown: '![pic](attachments/' + 'a'.repeat(64) + '.png)',
    });
    a.ops.createNote({ title: 'Linker', markdown: 'see [[Target]]' });
    // Resolve the link as the app would: by the target's id.
    const linker = readWorkspace(a.engine.replica.workspace).notes.find((n) => n.id !== target)!.id;
    const doc = a.engine.replica.note(linker)!;
    const p = doc.get(NOTE_ROOT).toArray()[0] as Y.Node;
    const link = new Y.Node('wikilink');
    p.insert(p.length, [link]);
    link.setAttr('noteId', target);
    link.setAttr('target', 'Target');
    link.setAttr('heading', null);
    link.setAttr('alias', null);
    await a.engine.sync();
    expect(nb.rendered().get('Work/Deep/Target.md')).toContain(
      `](../../attachments/${'a'.repeat(64)}.png)`,
    );
    a.ops.moveFolder(deep, null);
    setTitle(a.engine.replica.note(target)!, 'Target renamed');
    await a.engine.sync();
    expect(nb.rendered().get('Deep/Target renamed.md')).toContain(
      `](../attachments/${'a'.repeat(64)}.png)`,
    );
    expect(nb.rendered().get('Linker.md')).toContain('[[Target renamed]]');
  });

  it('foreign files keep their names, and are never touched (A217)', async () => {
    const nb = testNotebook({ dir: 'docs/notes' });
    await nb.remote.commitAs(nb.branch, {
      'README.md': '# Code\n',
      'docs/notes/Ideas.md': '# Ideas\n\nBy hand.\n',
      'docs/notes/Work/keep.txt': 'mine\n',
    });
    const a = await nb.open('A', { create: true });
    const id = a.ops.createNote({ title: 'Ideas', markdown: 'penmoss' });
    a.ops.createFolder({ name: 'Work', parentId: null });
    await a.engine.sync();
    const head = nb.head()!;
    expect(decoder.decode(nb.remote.read(head, 'docs/notes/Ideas.md')!)).toBe(
      '# Ideas\n\nBy hand.\n',
    );
    expect(decoder.decode(nb.remote.read(head, 'docs/notes/Work/keep.txt')!)).toBe('mine\n');
    expect(decoder.decode(nb.remote.read(head, 'README.md')!)).toBe('# Code\n');
    expect(nb.rendered().get(`Ideas (${id.slice(-7)}).md`)).toContain('penmoss');
    for (const commit of nb.remote
      .history(nb.branch)
      .filter((c) => c.author.name.startsWith('Penmoss'))) {
      const parent = nb.remote.commits.get(commit.parents[0]!)!.tree;
      for (const path of new Set([...parent.keys(), ...commit.tree.keys()])) {
        if (parent.get(path) !== commit.tree.get(path))
          expect(path.startsWith('docs/notes/')).toBe(true);
      }
    }
  });

  it('keeps every path inside a Windows clone (MAX_PATH_CHARS)', async () => {
    const nb = testNotebook();
    const a = await nb.open('A', { create: true });
    let parent: string | null = null;
    for (let depth = 0; depth < 8; depth++) {
      parent = a.ops.createFolder({
        name: `A rather long folder name at depth ${depth} of the tree`,
        parentId: parent,
      });
      a.ops.createNote({
        title: `A very long title that goes on and on, well past what a file name keeps, at depth ${depth}`,
        folderId: parent,
        markdown: 'x',
      });
    }
    await a.engine.sync();
    for (const path of nb.rendered().keys())
      expect(path.length).toBeLessThanOrEqual(MAX_PATH_CHARS);
  });

  it('hand edits to rendered files are overwritten and reported (G0 change 3)', async () => {
    const nb = testNotebook();
    const a = await nb.open('A', { create: true });
    a.ops.createNote({ title: 'Plan', markdown: 'the plan' });
    await a.engine.sync();
    const before = nb.rendered().get('Plan.md')!;
    await nb.remote.commitAs(nb.branch, { 'Plan.md': `${before}\nA line by hand.\n` });
    const report = await a.engine.sync();
    expect(report.handEdits).toEqual(['Plan.md']);
    expect(nb.rendered().get('Plan.md')).toBe(before);
  });
});

describe('Delete for good, copied profiles and crashes', () => {
  it('a purged note never comes back from a writer that still holds and edits it (A828)', async () => {
    const nb = testNotebook();
    const a = await nb.open('A', { create: true });
    const id = a.ops.createNote({ title: 'Secret', markdown: 'gone soon' });
    await a.engine.sync();
    const b = await nb.open('B');
    await b.engine.sync();
    append(b, id, 'edited offline');
    a.ops.purge(id);
    await a.engine.sync();
    expect(nb.files().some((path) => path.includes(id))).toBe(false);
    expect(nb.rendered().has('Secret.md')).toBe(false);
    const report = await b.engine.sync();
    expect(report.purged).toEqual([id]);
    expect(b.engine.replica.note(id)).toBeUndefined();
    expect(nb.files().some((path) => path.includes(id))).toBe(false);
    await a.engine.sync();
    expect(a.engine.replica.note(id)).toBeUndefined();
    expect(() => a.ops.createNote({ id, title: 'Again' })).toThrow(/deleted for good/);
  });

  it('a purge taken back before it synced (Keep note) brings the note back from the branch', async () => {
    const nb = testNotebook();
    const a = await nb.open('A', { create: true });
    const id = a.ops.createNote({ title: 'Kept', markdown: 'every word' });
    await a.engine.sync();
    const before = nb.files().filter((path) => path.includes(id));
    a.ops.purge(id);
    expect(a.engine.replica.note(id)).toBeUndefined();
    unmarkPurged(a.engine.replica.workspace, id);
    const report = await a.engine.sync();
    expect(report.purged).toEqual([]);
    expect(bodyMarkdown(a.engine.replica.note(id)!)).toBe('every word\n');
    expect(nb.files().filter((path) => path.includes(id))).toEqual(before);
    expect(nb.rendered().has('Kept.md')).toBe(true);
    const b = await nb.open('B');
    await b.engine.sync();
    expect(bodyMarkdown(b.engine.replica.note(id)!)).toBe('every word\n');
  });

  it('a purge that landed is never taken back: its content stays gone from the branch', async () => {
    const nb = testNotebook();
    const a = await nb.open('A', { create: true });
    const id = a.ops.createNote({ title: 'Secret', markdown: 'deleted words' });
    await a.engine.sync();
    const b = await nb.open('B');
    await b.engine.sync();
    a.ops.purge(id);
    await a.engine.sync();
    // B still holds its old copy and edits it, offline.
    append(b, id, 'edited on B');
    // A's page takes the mark back after it landed (a stale Keep, or a page script).
    const logs: string[] = [];
    const again = await nb.open('A', {
      storage: a.storage,
      secrets: a.secrets,
      engine: { log: (line) => logs.push(line) },
    });
    unmarkPurged(again.engine.replica.workspace, id);
    await again.engine.sync();
    expect(isPurged(again.engine.replica.workspace, id)).toBe(true);
    expect(logs.join('\n')).toContain('already deleted for good');
    await b.engine.sync();
    expect(b.engine.replica.note(id)).toBeUndefined();
    // A fresh clone has none of it.
    const c = await nb.open('C');
    await c.engine.sync();
    expect(c.engine.replica.note(id)).toBeUndefined();
    expect(nb.files().some((path) => path.includes(id))).toBe(false);
    expect([...nb.rendered().values()].join('\n')).not.toContain('deleted words');
  });

  it("a landed purge's purgedFrom entry goes at the next sync, and the purge stays (A855)", async () => {
    const nb = testNotebook();
    const a = await nb.open('A', { create: true });
    const id = a.ops.createNote({ title: 'Filed', markdown: 'here' });
    await a.engine.sync();
    const b = await nb.open('B');
    await b.engine.sync();
    a.ops.purge(id);
    // Not landed yet: Keep note needs where it was.
    expect(a.engine.replica.workspace.get(WORKSPACE_PURGED_FROM).hasAttr(id)).toBe(true);
    await a.engine.sync();
    // Landed: the next sync of any writer takes the entry out, in its own commit.
    const report = await b.engine.sync();
    expect(report.commit).not.toBeNull();
    expect(b.engine.replica.workspace.get(WORKSPACE_PURGED_FROM).hasAttr(id)).toBe(false);
    expect(isPurged(b.engine.replica.workspace, id)).toBe(true);
    await a.engine.sync();
    expect(a.engine.replica.workspace.get(WORKSPACE_PURGED_FROM).hasAttr(id)).toBe(false);
    expect(isPurged(a.engine.replica.workspace, id)).toBe(true);
    // Nothing more to do: no commit after that.
    expect((await a.engine.sync()).commit).toBeNull();
    expect((await b.engine.sync()).commit).toBeNull();
    const c = await nb.open('C');
    await c.engine.sync();
    expect(isPurged(c.engine.replica.workspace, id)).toBe(true);
    expect(c.engine.replica.workspace.get(WORKSPACE_PURGED_FROM).hasAttr(id)).toBe(false);
  });

  it('a copied profile gets a new writer id and loses nothing (A821)', async () => {
    const nb = testNotebook();
    const a = await nb.open('A', { create: true });
    const id = a.ops.createNote({ title: 'Plan', markdown: 'kept' });
    await a.engine.sync();
    const copy = await nb.open('A', { storage: a.storage.copy(), secrets: new MemorySecrets() });
    expect(copy.engine.writer?.id).toBe(a.engine.writer!.id); // Until it syncs and checks.
    append(copy, id, 'from the copy');
    const report = await copy.engine.sync();
    expect(report.newWriter).not.toBeNull();
    expect(report.newWriter).not.toBe(a.engine.writer!.id);
    expect(nb.files()).toContain(`.penmoss/notes/${id}/${report.newWriter}.yjs`);
    await a.engine.sync();
    expect(bodyMarkdown(a.engine.replica.note(id)!)).toBe('kept\n\nfrom the copy\n');
    // The original keeps its own id: its secret still matches.
    expect((await a.engine.sync()).newWriter).toBeNull();
  });

  it('a crash between commit and push loses nothing: the next sync recomputes the same difference', async () => {
    const nb = testNotebook();
    const a = await nb.open('A', { create: true });
    const id = a.ops.createNote({ title: 'Plan', markdown: 'one' });
    await a.engine.sync();
    append(a, id, 'two');
    await a.engine.save();
    const saved = a.storage.copy();
    await expect(
      a.engine.sync({
        beforePush: () => {
          throw new Error('crash');
        },
      }),
    ).rejects.toThrow('crash');
    const restarted = await nb.open('A', {
      storage: saved,
      secrets: a.secrets,
      transport: a.transport,
    });
    expect((await restarted.engine.sync()).commit).not.toBeNull();
    const b = await nb.open('B');
    await b.engine.sync();
    expect(bodyMarkdown(b.engine.replica.note(id)!)).toBe('one\n\ntwo\n');
  });

  it('a push that landed but was never recorded is found again, and not committed twice', async () => {
    const nb = testNotebook();
    const a = await nb.open('A', { create: true });
    const id = a.ops.createNote({ title: 'Plan', markdown: 'one' });
    await a.engine.sync();
    append(a, id, 'two');
    await a.engine.save();
    const saved = a.storage.copy();
    await expect(
      a.engine.sync({
        afterPush: () => {
          throw new Error('died');
        },
      }),
    ).rejects.toThrow('died');
    const commits = nb.remote.history(nb.branch).length;
    const restarted = await nb.open('A', {
      storage: saved,
      secrets: a.secrets,
      transport: a.transport,
    });
    expect((await restarted.engine.sync()).commit).toBeNull();
    expect(nb.remote.history(nb.branch).length).toBe(commits);
    expect(restarted.engine.replica.state.dirty).toEqual({});
  });

  it('builds again on a rejected push, up to three times, then keeps the changes (A822)', async () => {
    const nb = testNotebook();
    const a = await nb.open('A', { create: true });
    const id = a.ops.createNote({ title: 'Plan', markdown: 'one' });
    await a.engine.sync();
    const b = await nb.open('B');
    await b.engine.sync();
    append(b, id, 'from b');
    let pushes = 0;
    const report = await a.engine.sync({
      beforePush: async () => {
        if (pushes++ === 0) await b.engine.sync();
      },
    });
    expect(report.attempts).toBe(1); // A had nothing to push.
    append(a, id, 'from a');
    let rejections = 0;
    const busy = await a.engine
      .sync({
        beforePush: async () => {
          // Someone always pushes first.
          rejections++;
          await nb.remote.commitAs(nb.branch, { [`other-${rejections}.txt`]: 'x' });
        },
      })
      .catch((e: unknown) => e);
    expect(busy).toMatchObject({ code: 'busy' });
    expect(rejections).toBe(4);
    expect(Object.keys(a.engine.replica.state.dirty)).toEqual([id]);
    const landed = await a.engine.sync();
    expect(landed.commit).not.toBeNull();
    expect(a.engine.replica.state.dirty).toEqual({});
  });

  it('a refused push says why and keeps local edits for the next sync', async () => {
    const nb = testNotebook();
    const a = await nb.open('A', { create: true });
    const id = a.ops.createNote({ title: 'Plan', markdown: 'one' });
    await a.engine.sync();
    append(a, id, 'two');
    nb.remote.refuse = {
      code: 'protected',
      message: 'GH006: Protected branch update failed for refs/heads/main.',
    };
    const error = await a.engine.sync().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GitTransportError);
    expect((error as GitTransportError).code).toBe('protected');
    expect((error as GitTransportError).hostMessage).toContain('GH006');
    expect(Object.keys(a.engine.replica.state.dirty)).toEqual([id]);
    nb.remote.refuse = null;
    expect((await a.engine.sync()).commit).not.toBeNull();
  });
});

describe('render versions and determinism (A823)', () => {
  it('an older client than notebook.json says writes logs but renders nothing', async () => {
    const nb = testNotebook();
    const a = await nb.open('A', { create: true });
    a.ops.createNote({ title: 'Plan', markdown: 'one' });
    await a.engine.sync();
    const info = JSON.parse(
      decoder.decode(nb.remote.read(nb.head()!, '.penmoss/notebook.json')!),
    ) as Record<string, unknown>;
    await nb.remote.commitAs(nb.branch, {
      '.penmoss/notebook.json': JSON.stringify({ ...info, renderVersion: RENDER_VERSION + 1 }),
    });
    const id = a.ops.createNote({ title: 'New', markdown: 'two' });
    const report = await a.engine.sync();
    expect(report.renderSkipped).toBe(true);
    expect(nb.files()).toContain(`.penmoss/notes/${id}/${a.engine.writer!.id}.yjs`);
    expect(nb.rendered().has('New.md')).toBe(false);
  });

  it('a newer client raises an older renderVersion and renders everything again', async () => {
    const nb = testNotebook();
    const a = await nb.open('A', { create: true });
    a.ops.createNote({ title: 'Plan', markdown: 'one' });
    await a.engine.sync();
    const info = JSON.parse(
      decoder.decode(nb.remote.read(nb.head()!, '.penmoss/notebook.json')!),
    ) as Record<string, unknown>;
    await nb.remote.commitAs(nb.branch, {
      '.penmoss/notebook.json': JSON.stringify({ ...info, renderVersion: 0 }),
      'Plan.md': null,
    });
    const b = await nb.open('B');
    await b.engine.sync();
    expect(
      (
        JSON.parse(decoder.decode(nb.remote.read(nb.head()!, '.penmoss/notebook.json')!)) as {
          renderVersion: number;
        }
      ).renderVersion,
    ).toBe(RENDER_VERSION);
    expect(nb.rendered().has('Plan.md')).toBe(true);
  });

  it('renders version 3 since names lost their format characters: an older client stops (#174 review)', async () => {
    expect(RENDER_VERSION).toBe(3);
    const nb = testNotebook();
    const a = await nb.open('A', { create: true });
    a.ops.createNote({ title: 'Sha\u200elom notes', markdown: 'one' });
    await a.engine.sync();
    const info = JSON.parse(
      decoder.decode(nb.remote.read(nb.head()!, '.penmoss/notebook.json')!),
    ) as Record<string, unknown>;
    expect(info['renderVersion']).toBe(3);
    expect(nb.rendered().has('Shalom notes.md')).toBe(true);
    expect([...nb.rendered().keys()].some((path) => /\p{Cf}/u.test(path))).toBe(false);
  });

  it('renders the same state to the same bytes, every time and on every writer', async () => {
    const nb = testNotebook();
    const a = await nb.open('A', { create: true });
    a.ops.createNote({ title: 'Plan', markdown: '# Plan\n\n- [ ] one\n- [x] two\n' });
    await a.engine.sync();
    const b = await nb.open('B');
    await b.engine.sync();
    const head = nb.head()!;
    const first = await a.engine.renderAll(head);
    const again = await a.engine.renderAll(head);
    const other = await b.engine.renderAll(head);
    expect(again.wanted).toEqual(first.wanted);
    expect(other.wanted).toEqual(first.wanted);
    // Nothing changed: a sync renders nothing new and commits nothing.
    expect((await b.engine.sync()).commit).toBeNull();
    expect((await a.engine.sync()).commit).toBeNull();
  });
});

describe('the Journal (A820, A827)', () => {
  it('a daily note made offline on two devices has one template body and a salted id', async () => {
    const nb = testNotebook();
    const a = await nb.open('A', { create: true });
    await a.engine.sync();
    const b = await nb.open('B');
    await b.engine.sync();
    a.ops.setSetting('template.daily', '## Plan\n\n## Log\n');
    await a.engine.sync();
    await b.engine.sync();
    const one = a.ops.daily({ date: '2026-10-29', create: true });
    const two = b.ops.daily({ date: '2026-10-29', create: true });
    expect(one.id).toBe(two.id);
    expect(one.id).not.toBe(periodicNoteId('daily', '2026-10-29'));
    await a.engine.sync();
    await b.engine.sync();
    await a.engine.sync();
    expect(bodyMarkdown(a.engine.replica.note(one.id)!)).toBe('## Plan\n\n## Log\n');
    expect(nb.rendered().get('Journal/2026/10/2026-10-29.md')).toContain('type: daily');
  });

  it('a daily note in Trash comes back when asked for again', async () => {
    const nb = testNotebook();
    const a = await nb.open('A', { create: true });
    const day = a.ops.daily({ date: '2026-10-29', create: true });
    a.ops.trash(day.id);
    expect(isDeleted(a.engine.replica.note(day.id)!)).toBe(true);
    const again = a.ops.daily({ date: '2026-10-29', create: true });
    expect(again).toMatchObject({ created: false, restoredFromTrash: true });
    expect(readTitle(a.engine.replica.note(day.id)!)).toBe('2026-10-29');
  });
});

describe('attachments (A828)', () => {
  it('commits the files notes use, once, and refuses files over 10 MB', async () => {
    const nb = testNotebook();
    const a = await nb.open('A', { create: true });
    const bytes = new TextEncoder().encode('png bytes');
    const { path, sha256 } = await a.ops.keepAttachment(bytes, 'png');
    a.ops.createNote({ title: 'Pic', markdown: `![a picture](${path})` });
    await a.engine.sync();
    expect(nb.files()).toContain(`attachments/${sha256}.png`);
    expect(nb.remote.read(nb.head()!, `attachments/${sha256}.png`)).toEqual(bytes);
    await expect(
      a.ops.keepAttachment(new Uint8Array(10 * 1024 * 1024 + 1), 'bin'),
    ).rejects.toMatchObject({
      code: 'file_too_large',
    });
  });
});

describe('what a review of G1+G2 found (#165)', () => {
  it('every process writes under a new client id, never one it or the docs used (A821)', async () => {
    const nb = testNotebook();
    const a = await nb.open('A', { create: true });
    const id = a.ops.createNote({ title: 'Plan', markdown: 'one' });
    await a.engine.sync();
    const first = a.engine.replica.clientID;
    // Loading its own content back must not make Yjs give the docs ids of its own (it warns).
    const printed = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const again = await nb.open('A', { storage: a.storage, secrets: a.secrets });
    const second = again.engine.replica.clientID;
    expect(second).not.toBe(first);
    expect(a.engine.replica.state.ownClients).not.toContain(second);
    expect(again.engine.replica.workspace.clientID).toBe(second);
    expect(again.engine.replica.note(id)!.clientID).toBe(second);
    append(again, id, 'more');
    await again.engine.sync();
    expect(printed.mock.calls.flat().join(' ')).not.toContain('[yjs]');
    printed.mockRestore();
    // The claims keep their id across processes (a claims fork starts from head, A823).
    expect(again.engine.replica.state.claimsClientId).toBe(a.engine.replica.state.claimsClientId);
    expect(again.engine.replica.state.ownClients).toContain(second);
    const copy = await nb.open('A', { storage: a.storage.copy(), secrets: new MemorySecrets() });
    expect(copy.engine.replica.usedClientIds().has(copy.engine.replica.clientID)).toBe(false);
    expect(copy.engine.replica.state.claimsClientId).toBeNull();
    append(again, id, 'two');
    append(copy, id, 'three');
    await again.engine.sync();
    await copy.engine.sync();
    await again.engine.sync();
    expect(bodyMarkdown(again.engine.replica.note(id)!)).toBe(
      bodyMarkdown(copy.engine.replica.note(id)!),
    );
    expect(bodyMarkdown(copy.engine.replica.note(id)!)).toMatch(/two[\s\S]*three|three[\s\S]*two/);
  });

  it('a profile rolled back to before its last push, which edits before it syncs, converges', async () => {
    // A VM snapshot rollback, Time Machine, a copied ~/.penmoss: the same writer and secret, with
    // files older than what it pushed, and the CLI writes before it syncs.
    const nb = testNotebook();
    const a = await nb.open('A', { create: true });
    const id = a.ops.createNote({ title: 'Plan', markdown: 'one' });
    await a.engine.sync();
    const backup = a.storage.copy();
    append(a, id, 'two');
    await a.engine.sync();
    const rolledBack = await nb.open('A', { storage: backup, secrets: a.secrets });
    append(rolledBack, id, 'three');
    await rolledBack.engine.sync();
    await a.engine.sync();
    const b = await nb.open('B');
    await b.engine.sync();
    const text = bodyMarkdown(b.engine.replica.note(id)!);
    expect(text).toMatch(/one[\s\S]*two/);
    expect(text).toContain('three');
    expect(bodyMarkdown(rolledBack.engine.replica.note(id)!)).toBe(text);
    expect(bodyMarkdown(a.engine.replica.note(id)!)).toBe(text);
  });

  it('a writer whose client id another writer uses moves to a new one before it writes on', async () => {
    const nb = testNotebook();
    const a = await nb.open('A', { create: true });
    const id = a.ops.createNote({ title: 'Shared', markdown: 'base' });
    await a.engine.sync();
    const b = await nb.open('B');
    // As two processes that rolled the same id would: B starts with A's.
    b.engine.replica.setClientId(a.engine.replica.clientID);
    await b.engine.sync();
    expect(b.engine.replica.clientID).not.toBe(a.engine.replica.clientID);
    append(a, id, 'from A');
    append(b, id, 'from B');
    await a.engine.sync();
    await b.engine.sync();
    await a.engine.sync();
    const text = bodyMarkdown(a.engine.replica.note(id)!);
    expect(bodyMarkdown(b.engine.replica.note(id)!)).toBe(text);
    expect(text).toContain('from A');
    expect(text).toContain('from B');
  });

  it('one corrupt or huge writer file is skipped and reported, and sync goes on (A822)', async () => {
    const nb = testNotebook();
    const a = await nb.open('A', { create: true, engine: { maxLogBytes: 4096 } });
    a.ops.createNote({ title: 'One', markdown: 'x' });
    await a.engine.sync();
    const bad = `.penmoss/notes/01JBN000000000000000000000/01JBW000000000000000000000.yjs`;
    const huge = `.penmoss/workspace/01JBW000000000000000000001.yjs`;
    await nb.remote.commitAs(nb.branch, { [bad]: 'garbage-not-yjs', [huge]: 'x'.repeat(10_000) });
    a.ops.createNote({ title: 'Two', markdown: 'y' });
    const report = await a.engine.sync();
    expect(report.commit).not.toBeNull();
    expect(report.skipped).toEqual({ [bad]: 'not a Yjs update', [huge]: 'larger than 0 MB' });
    expect(titles(a)).toEqual(['One', 'Two']);
    // Still skipped, and still reported, on the next sync and after a restart.
    a.ops.createNote({ title: 'Three', markdown: 'z' });
    expect((await a.engine.sync()).skipped).toEqual(report.skipped);
    const b = await nb.open('B', { engine: { maxLogBytes: 4096 } });
    expect((await b.engine.sync()).skipped).toEqual(report.skipped);
    expect(titles(b)).toEqual(['One', 'Three', 'Two']);
  });

  it('a stored name that would leave its folder is ignored, never written (A823)', async () => {
    const nb = testNotebook({ dir: 'docs/notes' });
    await nb.remote.commitAs(nb.branch, {
      'README.md': 'code',
      'docs/notes/sub/README.md': 'colleague text',
    });
    const a = await nb.open('A', { create: true });
    const n = a.ops.createNote({ title: 'Hello', markdown: 'hi' });
    const m = a.ops.createNote({ title: 'World', markdown: 'there' });
    await a.engine.sync();
    const b = await nb.open('B');
    await b.engine.sync();
    // B (buggy, or crafted) stores claims with a slash and with `..`.
    const registry = b.engine.replica.workspace.get('notes');
    b.engine.replica.workspace.transact(() => {
      (registry.getAttr(n) as Y.Node).setAttr(NOTE_NAME_ATTR, {
        base: 'Hello',
        name: 'sub/README',
      });
      (registry.getAttr(m) as Y.Node).setAttr(NOTE_NAME_ATTR, { base: 'World', name: '..' });
    });
    await b.engine.sync();
    await a.engine.sync();
    expect(nb.rendered().get('sub/README.md')).toBe('colleague text');
    expect(nb.rendered().has('Hello.md')).toBe(true);
    expect(nb.rendered().has('World.md')).toBe(true);
    expect(nb.files().every((path) => path.startsWith('docs/notes/') || path === 'README.md')).toBe(
      true,
    );
  });

  it('a branch deleted on the host is never pushed again as a new history (A822)', async () => {
    const nb = testNotebook();
    const a = await nb.open('A', { create: true });
    a.ops.createNote({ title: 'Plan', markdown: 'kept' });
    await a.engine.sync();
    nb.remote.branches.delete(nb.branch);
    a.ops.createNote({ title: 'Later', markdown: 'kept too' });
    await expect(a.engine.sync()).rejects.toMatchObject({ code: 'branch_gone' });
    expect(nb.remote.branches.has(nb.branch)).toBe(false);
    expect(Object.keys(a.engine.replica.state.dirty)).toHaveLength(1);
  });

  it('a copy of a rendered file, with the note’s id, is reported and left alone (A823)', async () => {
    const nb = testNotebook();
    const a = await nb.open('A', { create: true });
    const id = a.ops.createNote({ title: 'Plan', markdown: 'one' });
    await a.engine.sync();
    const text = nb.rendered().get('Plan.md')!;
    await nb.remote.commitAs(nb.branch, { 'Plan copy.md': text, 'Archive/Plan.md': text });
    const report = await a.engine.sync();
    expect(report.copies).toEqual(['Archive/Plan.md', 'Plan copy.md']);
    expect(nb.rendered().get('Plan copy.md')).toBe(text);
    // A rename still moves Penmoss's own file, and the copies stay.
    setTitle(a.engine.replica.note(id)!, 'Plan copy');
    await a.engine.sync();
    expect(nb.rendered().has('Plan.md')).toBe(false);
    expect(nb.rendered().get('Plan copy.md')).toBe(text);
    expect([...nb.rendered().keys()].sort()).toEqual([
      'Archive/Plan.md',
      expect.stringMatching(/^Plan copy \(.+\)\.md$/) as string,
      'Plan copy.md',
    ]);
  });

  it('a day whose note was deleted for good gets a new one, the same on every device', async () => {
    const nb = testNotebook();
    const a = await nb.open('A', { create: true });
    await a.engine.sync();
    const b = await nb.open('B');
    await b.engine.sync();
    const day = a.ops.daily({ date: '2026-10-29', create: true });
    a.ops.purge(day.id);
    await a.engine.sync();
    await b.engine.sync();
    const again = a.ops.daily({ date: '2026-10-29', create: true });
    const fromB = b.ops.daily({ date: '2026-10-29', create: true });
    expect(again.created).toBe(true);
    expect(again.id).not.toBe(day.id);
    expect(fromB.id).toBe(again.id);
  });
});

describe('a profile older than what it pushed (a restored backup)', () => {
  it('writes under a new client id from the start, so its clocks never repeat (A821)', async () => {
    const nb = testNotebook();
    const a = await nb.open('A', { create: true });
    const id = a.ops.createNote({ title: 'Plan', markdown: 'one' });
    await a.engine.sync();
    const backup = a.storage.copy();
    append(a, id, 'two');
    await a.engine.sync();
    // The same writer (its secret still matches), from files older than its last push.
    const restored = await nb.open('A', { storage: backup, secrets: a.secrets });
    expect(restored.engine.replica.clientID).not.toBe(a.engine.replica.clientID);
    await restored.engine.sync();
    append(restored, id, 'three');
    await restored.engine.sync();
    const b = await nb.open('B');
    await b.engine.sync();
    expect(bodyMarkdown(b.engine.replica.note(id)!)).toBe('one\n\ntwo\n\nthree\n');
  });
});
