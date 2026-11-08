/**
 * The personal workspace into one git notebook (T56, A1020–A1025), in memory: a workspace shaped
 * as the server keeps it (notebook flags, Trash out of the tree, settings under the user's id,
 * comment threads sent to an agent, unsalted daily notes) goes into a new notebook, and the check
 * reads it back from the branch. The CLI's run against `wrangler dev` is
 * packages/cli/test/export-personal.test.ts.
 */
import { periodicNoteId, journalFolderId } from '@penmoss/core/periodic';
import { periodicNote } from '@penmoss/editor/periodic';
import { parseMarkdown } from '@penmoss/core';
import {
  anchorForQuote,
  createThread,
  readThreads,
  type CommentAuthor,
} from '@penmoss/sync-client/comments';
import {
  createFolder,
  readWorkspace,
  registerNote,
  setNotebook,
  setSetting,
  unregisterNote,
} from '@penmoss/sync-client/workspace';
import * as Y from '@y/y';
import { describe, expect, it } from 'vitest';
import { LocalNotebook } from '../src/local';
import { NOTE_META } from '@penmoss/sync-client/note';
import { CHANGED_AT_PREFIX, changedAtOf } from '../src/render';
import {
  dryRunPersonal,
  importPersonal,
  IMPORT_SALT,
  IMPORT_WRITER,
  openAtHead,
  personalAttachments,
  sha256Bytes,
  verifyPersonal,
  type PersonalAttachment,
  type PersonalWorkspace,
  type ServerSide,
} from '../src/personal';
import { GIT_MAX_ATTACHMENT_BYTES } from '@penmoss/core/attachments';
import { GitNotebookEngine, MemorySecrets, MemoryStorage } from '../src';
import { testNotebook } from './support/notebooks';

const USER = '01JBUSER000000000000000001';
const RYAN: CommentAuthor = { id: 'device-1', kind: 'device', label: 'Ryan’s Mac' };

/** A workspace as the server holds it, made with a scratch notebook's notes API. */
async function serverWorkspace() {
  const scratch = testNotebook();
  const clone = await scratch.open('Server', { create: true });
  const notes = new LocalNotebook(clone.ops, scratch.clock);
  const ws = clone.ops.workspace;
  createFolder(ws, { id: '01JBWORK000000000000000001', name: 'Work', parentId: null });
  createFolder(ws, {
    id: '01JBPLANS00000000000000001',
    name: 'Plans',
    parentId: '01JBWORK000000000000000001',
  });
  const garden = notes.create({
    title: 'Garden',
    markdown: 'Tomatoes and beans.\n\nSee the compost note.',
    tags: ['home/garden'],
    folderId: '01JBPLANS00000000000000001',
  }).reply.id;
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
  const pngFile = `${await sha256Bytes(png)}.png`;
  const big = new Uint8Array(GIT_MAX_ATTACHMENT_BYTES + 1);
  const bigFile = `${await sha256Bytes(big)}.pdf`;
  const linker = notes.create({
    title: 'Index',
    markdown: `Read [[Garden]] first. #todo\n\n![plot](attachments/${pngFile})\n\n[manual](attachments/${bigFile})`,
  }).reply.id;
  const trashed = notes.create({ title: 'Old idea', markdown: 'Gone soon.' }).reply.id;
  notes.trash(trashed);
  // A daily note as the server makes it: unsalted id, in the unsalted Journal folders (A76).
  const day = periodicNote({ parseMarkdown }, 'daily', '2026-10-29', '# {{date}}\n\nNotes.');
  Y.applyUpdate(clone.engine.replica.ensureNote(day.id), day.update);
  let parent: string | null = null;
  for (const path of ['Journal', 'Journal/2026', 'Journal/2026/10']) {
    const id = journalFolderId(path);
    createFolder(ws, { id, name: path.split('/').at(-1)!, parentId: parent });
    parent = id;
  }
  registerNote(ws, { id: day.id, folderId: parent });
  // A thread on Garden, sent to an agent session (the server's alone, A1023).
  const gardenDoc = clone.ops.note(garden)!;
  const quote = anchorForQuote(gardenDoc, 'Tomatoes');
  if ('error' in quote) throw new Error('no quote');
  createThread(gardenDoc, {
    id: 'thread-1',
    anchor: quote.anchor,
    quote: quote.quote,
    author: RYAN,
    at: Date.UTC(2026, 9, 29),
    comment: { id: 'c-1', body: 'Which variety?' },
    // A target from the server's time named a token (A1060 reads it as none; the export drops it).
    target: { token: 'tok_1', session: 'session-1', label: 'Claude Code' } as never,
  });
  await clone.engine.sync();

  // The server's WorkspaceDoc: the same tree, with what only the server has.
  const server = new Y.Doc();
  Y.applyUpdate(server, Y.encodeStateAsUpdate(ws));
  setNotebook(server, '01JBWORK000000000000000001', true);
  server.get('root').setAttr('notebookName', 'Personal');
  (server.get('notes').getAttr(garden) as Y.Node).setAttr('path', 'Work/Plans/Garden.md');
  // Trash is out of the server's tree.
  unregisterNote(server, trashed);
  setSetting(server, USER, 'timeZone', 'America/Chicago');
  setSetting(server, USER, 'template.daily', '# {{date}}\n\nNotes.');
  setSetting(server, USER, 'symbols.list', [{ glyph: '★', color: '#c00' }]);
  setSetting(server, USER, 'quickAccess.notes', [garden, linker]);
  setSetting(server, '01JBOTHERUSER0000000000001', 'theme', 'dark');

  const ids = [garden, linker, trashed, day.id];
  const updates = ids.map((id) => ({
    id,
    update: Y.encodeStateAsUpdate(clone.ops.note(id)!),
    updatedAt: changedAtOf(clone.ops.note(id)!) || scratch.clock(),
  }));
  const attachments = new Map<string, PersonalAttachment>([
    [pngFile, { kind: 'bytes', bytes: png }],
    [bigFile, { kind: 'too_large', bytes: big.byteLength }],
  ]);
  const workspace: PersonalWorkspace = {
    userId: USER,
    workspace: Y.encodeStateAsUpdate(server),
    notes: updates,
    attachments,
  };
  const serverSide = (): ServerSide => ({
    userId: USER,
    workspace: workspace.workspace,
    notes: ids.map((id) => {
      const content = notes.content(id);
      return {
        id,
        update: Y.encodeStateAsUpdate(clone.ops.note(id)!),
        content: {
          title: content.title,
          tags: content.tags,
          markdown: content.markdown,
          body: content.body,
          deleted: content.deleted,
        },
      };
    }),
    attachments: new Map([
      [pngFile, pngFile.slice(0, 64)],
      [bigFile, 'too_large' as const],
    ]),
  });
  return { workspace, serverSide, ids: { garden, linker, trashed, day: day.id }, pngFile, bigFile };
}

/** A new notebook for the import, as `penmoss export-personal` opens it. */
async function importTarget() {
  const nb = testNotebook();
  const transport = nb.transport('Import');
  const engine = await GitNotebookEngine.open({
    transport,
    storage: new MemoryStorage(),
    secrets: new MemorySecrets(),
    writer: IMPORT_WRITER,
    create: { name: 'Personal', salt: IMPORT_SALT },
    clock: nb.clock,
  });
  return { nb, engine };
}

describe('the personal workspace into one git notebook', () => {
  it('imports every note in one commit, ids kept, and the check finds no difference', async () => {
    const source = await serverWorkspace();
    const { nb, engine } = await importTarget();
    const report = await importPersonal(engine, source.workspace);
    expect(report).toMatchObject({
      notes: 4,
      inTrash: 1,
      folders: 5,
      settings: { notebook: 2, device: 2 },
      symbols: 1,
      quickAccess: 2,
      filed: [source.ids.trashed],
      notebooksFlattened: ['01JBWORK000000000000000001'],
      sendingDropped: 1,
      otherUsers: { '01JBOTHERUSER0000000000001': 1 },
      attachments: {
        written: 1,
        tooLarge: [{ file: source.bigFile, notes: [source.ids.linker] }],
        missing: [],
      },
    });
    const synced = await engine.sync();
    expect(synced.commit).not.toBeNull();
    // One commit holds it all, with notebook.json saying the ids are unsalted (A1021).
    expect(nb.remote.history('main')).toHaveLength(1);
    const info = JSON.parse(
      new TextDecoder().decode(nb.remote.read(nb.head()!, '.penmoss/notebook.json')!),
    ) as Record<string, unknown>;
    expect(info).toMatchObject({ name: 'Personal', format: 2, salt: '' });
    expect(nb.files()).toContain(`attachments/${source.pngFile}`);
    expect(nb.files()).not.toContain(`attachments/${source.bigFile}`);

    const read = await openAtHead(nb.transport('Check'));
    const verified = await verifyPersonal(source.serverSide(), read);
    expect(verified.differences).toEqual([]);
    expect(verified).toMatchObject({ notes: 4, tooLarge: [source.bigFile] });
    expect(read.unrendered).toEqual([]);
    const ops = read.notebook.ops;
    // No notebook flags, no server name, no mirror paths, no sending to agents.
    const tree = readWorkspace(ops.workspace);
    expect(tree.folders.some((folder) => folder.notebook)).toBe(false);
    expect(tree.defaultNotebookName).toBeUndefined();
    expect(tree.notes.every((entry) => entry.path === null)).toBe(true);
    expect(readThreads(ops.note(source.ids.garden)!)[0]).not.toHaveProperty('target');
    // The Journal is the workspace's: today's note is the one imported, in its own folders.
    expect(ops.salt).toBe('');
    const day = ops.daily({ kind: 'daily', date: '2026-10-29', create: false });
    expect(day).toMatchObject({ id: source.ids.day, exists: true });
    expect(day.id).toBe(periodicNoteId('daily', '2026-10-29'));
    const next = ops.daily({ kind: 'daily', date: '2026-10-30', create: true });
    expect(next.id).toBe(periodicNoteId('daily', '2026-10-30'));
    const journals = readWorkspace(ops.workspace).folders.filter((f) => f.name === 'Journal');
    expect(journals.map((folder) => folder.id)).toEqual([journalFolderId('Journal')]);
    read.close();
  });

  it("reads a day's note made ahead of its day as the server does: `updated` before `created`", async () => {
    const source = await serverWorkspace();
    // Made (and last changed) five days before its own date, as opening a future day does.
    const at = Date.UTC(2026, 9, 24, 19, 52, 26);
    // The server keeps a note's last change in its own row, never in the note (the fixture's
    // notes carry the scratch clone's key, taken off here).
    const notes = source.workspace.notes.map((note) => {
      if (note.id !== source.ids.day) return note;
      const doc = new Y.Doc();
      Y.applyUpdate(doc, note.update);
      const meta = doc.get(NOTE_META);
      for (const [key] of [...meta.attrEntries()]) {
        if (String(key).startsWith(CHANGED_AT_PREFIX)) meta.deleteAttr(String(key));
      }
      return { ...note, update: Y.encodeStateAsUpdate(doc), updatedAt: at };
    });
    const { nb, engine } = await importTarget();
    await importPersonal(engine, { ...source.workspace, notes });
    await engine.sync();
    const read = await openAtHead(nb.transport('Check'));
    const file = new TextDecoder().decode(
      nb.remote.read(nb.head()!, 'Journal/2026/10/2026-10-29.md')!,
    );
    expect(file).toContain('created: 2026-10-29\n');
    expect(file).toContain('updated: 2026-10-24T19:52:26Z\n');
    expect(read.notebook.content(source.ids.day).markdown).toBe(file);
    read.close();
  });

  it('reports a note changed in the notebook since, and a note it lacks', async () => {
    const source = await serverWorkspace();
    const { nb, engine } = await importTarget();
    await importPersonal(engine, source.workspace);
    await engine.sync();
    // Someone edits Garden in the notebook afterwards.
    const other = await nb.open('Mac');
    await other.engine.sync();
    const local = new LocalNotebook(other.ops, nb.clock);
    nb.tick();
    local.edit(source.ids.garden, { op: 'append', markdown: 'Added in the notebook.' }, null);
    await other.engine.sync();

    const server = source.serverSide();
    const read = await openAtHead(nb.transport('Check'));
    const verified = await verifyPersonal(
      {
        ...server,
        notes: [...server.notes, { ...server.notes[0]!, id: '01JBNOTONTHESERVER00000001' }],
      },
      read,
    );
    const fields = verified.differences.map((d) => `${d.id} ${d.field}`);
    expect(fields).toContain(`${source.ids.garden} markdown`);
    expect(fields).toContain(`${source.ids.garden} body`);
    expect(fields).toContain('01JBNOTONTHESERVER00000001 note');
    read.close();
  });

  it('refuses a notebook that holds notes already', async () => {
    const source = await serverWorkspace();
    const { engine } = await importTarget();
    await importPersonal(engine, source.workspace);
    await expect(importPersonal(engine, source.workspace)).rejects.toMatchObject({
      code: 'not_empty',
    });
  });

  it('dry-runs into memory: what the commit would hold, written nowhere', async () => {
    const source = await serverWorkspace();
    const dry = await dryRunPersonal(source.workspace, { name: 'Personal' });
    expect(dry.report.notes).toBe(4);
    expect(dry.files).toMatchObject({ rendered: 3, attachments: 1 });
    expect(dry.commit.subject).toBe('Penmoss: 4 notes [skip ci]');
    expect(dry.paths).toContain('Work/Plans/Garden.md');
    expect(personalAttachments(source.workspace.notes).get(source.bigFile)).toEqual([
      source.ids.linker,
    ]);
  });
});
