/**
 * History for git notebooks (T50 G6, #154; A831, A858): versions are the commits that touched a
 * note's logs, with their writer (device or agent); restore is A80's diff-apply and revert A81's
 * three-way merge, as new changes that sync. Over a real engine and the in-memory transport,
 * two devices and an agent; the local MCP's tools give the server's shapes.
 */
import { bodyMarkdown } from '@penmoss/editor/markdown';
import { NOTE_ROOT } from '@penmoss/sync-client/replica';
import * as Y from '@y/y';
import { describe, expect, it } from 'vitest';
import { commitWriter, NotebookHistory } from '../src';
import { LocalMcpServer, LocalNotebook } from '../src/local';
import { testNotebook, type TestClone } from './support/notebooks';

function append(clone: TestClone, noteId: string, text: string): void {
  const doc = clone.engine.replica.note(noteId)!;
  doc.transact(() => {
    const p = new Y.Node('paragraph');
    doc.get(NOTE_ROOT).insert(doc.get(NOTE_ROOT).length, [p]);
    p.insert(0, text);
  });
}

async function threeWriters() {
  const nb = testNotebook();
  const a = await nb.open('Mac', { create: true });
  const id = a.ops.createNote({ title: 'Plan', markdown: 'first line' });
  await a.engine.sync();
  nb.tick();
  const agent = await nb.open('Claude Code', { kind: 'agent' });
  await agent.engine.sync();
  append(agent, id, 'agent line');
  await agent.engine.sync();
  nb.tick();
  await a.engine.sync();
  append(a, id, 'later human line');
  await a.engine.sync();
  const b = await nb.open('Pixel');
  await b.engine.sync();
  return { nb, a, agent, b, id };
}

describe('versions from commits (A831)', () => {
  it('lists the commits that touched a note, newest first, with their writer and time', async () => {
    const { a, id } = await threeWriters();
    const history = new NotebookHistory(a.engine.transport, a.engine.layout);
    const { versions } = await history.history(id);
    expect(versions.map((v) => v.id)).toEqual([3, 2, 1]);
    expect(versions.map((v) => v.authors[0]!.label)).toEqual(['Mac', 'Claude Code', 'Mac']);
    expect(versions.map((v) => v.authors[0]!.kind)).toEqual(['device', 'agent', 'device']);
    expect(versions.map((v) => v.reason)).toEqual(['auto', 'edit', 'auto']);
    expect(versions[1]!.summary).toBe('+1 −0 line');
    expect(versions[0]!.createdAt).toBeGreaterThan(versions[2]!.createdAt);
    const detail = await history.detail(id, 2);
    expect(detail).toMatchObject({ id: 2, previousId: 1 });
    expect(detail!.markdown).toContain('agent line');
    expect(
      detail!.diff.filter((op) => op.op === 'add' && op.line !== '').map((op) => op.line),
    ).toEqual(['agent line']);
    expect(await history.detail(id, 9)).toBeNull();
  });

  it('reads the writer from the commit trailer', () => {
    expect(
      commitWriter(
        'Penmoss: 1 note [skip ci]\n\nPenmoss-Writer: 01JBW000000000000000000000 (agent "Claude Code")\n',
      ),
    ).toEqual({ id: '01JBW000000000000000000000', kind: 'agent', label: 'Claude Code' });
    expect(commitWriter('Some commit')).toBeNull();
  });
});

describe('restore and revert (A80, A81)', () => {
  it('restores a version as a new change that syncs to another device', async () => {
    const { a, b, id } = await threeWriters();
    const notebook = new LocalNotebook(a.ops, Date.now, async () => {
      await a.engine.sync();
    });
    const restored = await notebook.restoreVersion(id, 1);
    expect(restored).toMatchObject({ id, changed: true });
    expect(bodyMarkdown(a.engine.replica.note(id)!)).toBe('first line\n');
    // Again: nothing to change.
    expect((await notebook.restoreVersion(id, 1)).changed).toBe(false);
    await a.engine.sync();
    await b.engine.sync();
    expect(bodyMarkdown(b.engine.replica.note(id)!)).toBe('first line\n');
    // The restore is itself a version, so it can be undone too.
    expect((await notebook.versions(id)).versions[0]!.id).toBe(4);
  });

  it('reverts just the agent’s edit, keeping the later human edit', async () => {
    const { a, b, id } = await threeWriters();
    const notebook = new LocalNotebook(a.ops, Date.now, async () => {
      await a.engine.sync();
    });
    const reverted = await notebook.revertVersion(id, 2);
    expect(reverted).toMatchObject({ id, changed: true, conflicts: [] });
    expect(bodyMarkdown(a.engine.replica.note(id)!)).toBe('first line\n\nlater human line\n');
    expect((await notebook.revertVersion(id, 2)).changed).toBe(false);
    await a.engine.sync();
    await b.engine.sync();
    expect(bodyMarkdown(b.engine.replica.note(id)!)).toBe('first line\n\nlater human line\n');
  });

  it('reports an overlap: a later edit to the agent’s own line is kept', async () => {
    const { a, id } = await threeWriters();
    // Ryan rewrites the agent's line afterwards.
    const doc = a.engine.replica.note(id)!;
    const paragraph = doc.get(NOTE_ROOT).get(1) as Y.Node;
    doc.transact(() => paragraph.insert(paragraph.length, ' (checked by Ryan)'));
    await a.engine.sync();
    const notebook = new LocalNotebook(a.ops);
    const reverted = await notebook.revertVersion(id, 2);
    expect(reverted.conflicts).toHaveLength(1);
    expect(reverted.conflicts[0]).toMatchObject({ part: 'body' });
    expect(bodyMarkdown(a.engine.replica.note(id)!)).toContain('agent line (checked by Ryan)');
  });
});

describe('restore and revert save the note as it is first (as the server does)', () => {
  it('an edit not committed yet becomes a version before the restore, so the restore can be undone', async () => {
    const { a, b, id } = await threeWriters();
    append(a, id, 'typed, never synced');
    const notebook = new LocalNotebook(a.ops, Date.now, async () => {
      await a.engine.sync();
    });
    expect((await notebook.restoreVersion(id, 1)).changed).toBe(true);
    // Version 4 holds the edit as it was; the restore comes after it.
    const detail = await notebook.versionDetail(id, 4);
    expect(detail.markdown).toContain('typed, never synced');
    await a.engine.sync();
    await b.engine.sync();
    expect(bodyMarkdown(b.engine.replica.note(id)!)).toBe('first line\n');
    expect((await notebook.versions(id)).versions.map((v) => v.id)).toEqual([5, 4, 3, 2, 1]);
  });

  it('a revert too; and with no way to commit, an uncommitted note is refused, not lost', async () => {
    const { a, id } = await threeWriters();
    append(a, id, 'typed, never synced');
    const offline = new LocalNotebook(a.ops);
    await expect(offline.revertVersion(id, 2)).rejects.toMatchObject({ status: 409 });
    await expect(offline.restoreVersion(id, 1)).rejects.toMatchObject({ status: 409 });
    expect(bodyMarkdown(a.engine.replica.note(id)!)).toContain('typed, never synced');
    const notebook = new LocalNotebook(a.ops, Date.now, async () => {
      await a.engine.sync();
    });
    expect((await notebook.revertVersion(id, 2)).changed).toBe(true);
    expect((await notebook.versionDetail(id, 4)).markdown).toContain('agent line');
  });
});

describe('the local MCP’s history tools (A830, A858)', () => {
  it('get_history, save_version, restore_version and revert_edit answer as /mcp does', async () => {
    const { a, id } = await threeWriters();
    let synced = 0;
    const notebook = new LocalNotebook(a.ops, Date.now, async () => {
      synced++;
      await a.engine.sync();
    });
    const mcp = new LocalMcpServer({ use: async (_write, run) => run(notebook) }, 'work');
    let next = 1;
    const tool = async (name: string, args: Record<string, unknown>) => {
      const reply = await mcp.line(
        JSON.stringify({
          jsonrpc: '2.0',
          id: next++,
          method: 'tools/call',
          params: { name, arguments: args },
        }),
      );
      return (JSON.parse(reply!) as { result: { isError?: boolean; structuredContent: never } })
        .result;
    };
    const listed = await tool('get_history', { id });
    expect(listed.isError).toBeUndefined();
    expect(listed.structuredContent).toMatchObject({
      id,
      versions: [
        { id: 3, reason: 'auto', authors: ['Mac'] },
        { id: 2, reason: 'edit', authors: ['Claude Code'], summary: '+1 −0 line' },
        { id: 1, reason: 'auto', authors: ['Mac'] },
      ],
      unversioned: null,
    });
    const detail = await tool('get_history', { id, versionId: 2 });
    expect(detail.structuredContent).toMatchObject({
      versionId: 2,
      previousId: 1,
      changes: expect.arrayContaining(['+ agent line']) as string[],
    });
    const reverted = await tool('revert_edit', { id, versionId: 2 });
    expect(reverted.structuredContent).toMatchObject({ id, changed: true, conflicts: [] });
    const saved = await tool('save_version', { id });
    expect(synced).toBe(1);
    expect(saved.structuredContent).toMatchObject({ id, saved: true, version: { id: 4 } });
    const again = await tool('save_version', { id });
    expect(again.structuredContent).toMatchObject({ saved: false, version: { id: 4 } });
    const restored = await tool('restore_version', { id, versionId: 2 });
    expect(restored.structuredContent).toMatchObject({ changed: true });
    const missing = await tool('restore_version', { id, versionId: 99 });
    expect(missing.isError).toBe(true);
  });
});
