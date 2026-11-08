import type { DocJson } from '@penmoss/core/links';
import { journalFolderId, periodicNoteId } from '@penmoss/core/periodic';
import { readWorkspace } from '@penmoss/sync-client/workspace';
import { bodyJson, createYjs14Replica } from '@penmoss/sync-client/yjs14';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DESTINATION_SETTING, destinationOf, saveCapture } from '../../src/capture/save';
import { INBOX } from '../../src/workspace/service';
import { TEST_NOTEBOOK, testNotes, testWorkspace } from './support/local-sources';
import { memoryNotes } from './support/memory-notes';

// T30: saving a capture through the local replica of a git notebook (D49): the capture is
// stored on this device, for the notebook's engine to commit and push.

const toStop: Array<{ stop(): void }> = [];
afterEach(() => {
  for (const item of toStop.splice(0)) item.stop();
  vi.restoreAllMocks();
});

/** A git notebook's notes and folders on this device, offline. */
async function offlineDevice(store = memoryNotes()) {
  const notes = testNotes(store, {
    online: () => false,
    persistStorage: () => Promise.resolve(true),
  });
  const workspace = testWorkspace(store);
  toStop.push(notes, workspace);
  await Promise.all([notes.start(), workspace.start()]);
  return { notes, workspace, store };
}

/** A body's top-level blocks as markdown-ish lines (headings, bold, italic, list items). */
function blocks(doc: DocJson): string {
  const inline = (node: DocJson): string =>
    node.type === 'text'
      ? (node.marks ?? []).reduce((text, mark) => {
          const wrap = mark.type === 'bold' ? '**' : mark.type === 'italic' ? '*' : '';
          return `${wrap}${text}${wrap}`;
        }, node.text ?? '')
      : (node.content ?? []).map(inline).join('');
  return (doc.content ?? [])
    .map((block) =>
      block.type === 'heading'
        ? `${'#'.repeat(Number(block.attrs?.['level'] ?? 1))} ${inline(block)}`
        : inline(block),
    )
    .join('\n\n');
}

/** The stored note's body (what the record holds, not an open replica). */
function storedMarkdown(store: ReturnType<typeof memoryNotes>, id: string): string {
  const record = store.records.get(id);
  if (!record) return '';
  const replica = createYjs14Replica();
  replica.applyUpdate(record.update);
  const text = blocks(bodyJson(replica.doc));
  replica.destroy();
  return text;
}

describe('saving a capture (T30)', () => {
  it('appends to today’s note under one ## Captures heading, offline, with the time in the synced zone', async () => {
    const { notes, workspace, store } = await offlineDevice();
    // 14:32 in Chicago (the default zone) on 23 October: the 23rd's note, whatever the device's zone.
    const first = await saveCapture(
      notes,
      workspace,
      'Call Sam',
      'daily',
      new Date('2026-10-23T19:32:00Z'),
    );
    const second = await saveCapture(
      notes,
      workspace,
      'Order *seed* potatoes',
      'daily',
      new Date('2026-10-23T20:05:00Z'),
    );
    const id = periodicNoteId('daily', '2026-10-23', TEST_NOTEBOOK);
    expect(first.noteId).toBe(id);
    expect(second.noteId).toBe(id);
    await vi.waitFor(() =>
      expect(storedMarkdown(store, id)).toBe(
        [
          '## Plan',
          '## Notes',
          '## Captures',
          '**14:32** Call Sam',
          '**15:05** Order *seed* potatoes',
        ].join('\n\n'),
      ),
    );
    // Stored on this device, for the notebook's engine to commit.
    expect(store.records.get(id)).toMatchObject({ unsynced: true });
    // Filed in the journal like any daily note.
    expect(workspace.folderOfNote(id)).toBe(journalFolderId('Journal/2026/10', TEST_NOTEBOOK));
    expect(destinationOf(workspace.settings())).toBe('daily');
  });

  it('files a new note in Inbox, made once, without changing the default (A947)', async () => {
    const { notes, workspace, store } = await offlineDevice();
    const { noteId } = await saveCapture(
      notes,
      workspace,
      '- [ ] Renew passport\nForms are in the **desk**',
      'inbox',
    );
    await notes.settled(noteId);
    expect(store.records.get(noteId)).toMatchObject({
      title: 'Renew passport',
      unsynced: true,
    });
    await vi.waitFor(() => expect(storedMarkdown(store, noteId)).toBe('Forms are in the **desk**'));
    const inbox = journalFolderId(INBOX, TEST_NOTEBOOK);
    expect(workspace.folderOfNote(noteId)).toBe(inbox);
    // The form's choice is for this capture only: Settings → Daily Notes sets the default.
    expect(workspace.settings()[DESTINATION_SETTING]).toBeUndefined();
    expect(destinationOf(workspace.settings())).toBe('daily');

    // A second capture reuses the folder; the workspace record holds both, stored.
    const again = await saveCapture(notes, workspace, 'Shed idea', 'inbox');
    expect(workspace.folderOfNote(again.noteId)).toBe(inbox);
    const folders = readWorkspace(workspace.doc).folders.filter((f) => f.name === INBOX);
    expect(folders).toHaveLength(1);
    expect(store.records.get('workspace')).toBeDefined();
  });

  it('leaves a default of New Note in Inbox as it is when one capture goes to today (A947)', async () => {
    const { notes, workspace } = await offlineDevice();
    workspace.setSetting(DESTINATION_SETTING, 'inbox');
    await saveCapture(notes, workspace, 'Just this once', 'daily');
    expect(destinationOf(workspace.settings())).toBe('inbox');
  });

  it('uses the user’s own Inbox folder when there is one', async () => {
    const { notes, workspace } = await offlineDevice();
    const own = workspace.createFolder('inbox', null);
    const { noteId } = await saveCapture(notes, workspace, 'Mine', 'inbox');
    expect(workspace.folderOfNote(noteId)).toBe(own);
  });

  it('changes a note open in this window through its own replica', async () => {
    const { notes, workspace } = await offlineDevice();
    const id = await notes.ensurePeriodic('daily', '2026-10-24', '');
    const open = notes.openNote(id);
    await open.ready;
    await saveCapture(notes, workspace, 'Seen at once', 'daily', new Date('2026-10-24T15:00:00Z'));
    expect(blocks(bodyJson(open.replica.doc))).toContain('**10:00** Seen at once');
    open.close();
  });
});
