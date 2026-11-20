/**
 * AI Descriptions' describer (PEN-161): a note edited and left for the pause is described once;
 * the description's own write asks for nothing; nothing is sent when Off, with no provider, for
 * an empty body or a description written by hand; At Sync waits for the sync.
 */
import { readDescription, setHandDescription } from '@penmoss/model/description';
import { initNote, setTitle } from '@penmoss/model/note';
import { NOTE_ROOT } from '@penmoss/model/replica';
import {
  createFolder,
  readWorkspace,
  registerNote,
  setFolderAiDescription,
} from '@penmoss/model/workspace';
import * as Y from '@y/y';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Describer, type AiBridge, type DescriberSource } from '../../src/notes/describer';

function noteDoc(id: string, title: string, body: string): Y.Doc {
  const doc = new Y.Doc();
  initNote(doc, { id, created: '2026-11-20T09:00:00Z', kind: 'note' }, title);
  if (body) {
    doc.transact(() => {
      const paragraph = new Y.Node('paragraph');
      doc.get(NOTE_ROOT).push([paragraph]);
      paragraph.insert(0, body);
    });
  }
  return doc;
}

function fakeSource() {
  const docs = new Map<string, Y.Doc>();
  const stored = new Set<(ids: readonly string[]) => void>();
  const pulled = new Set<(ids: readonly string[]) => void>();
  const sync = new Set<() => void>();
  let phase = 'syncing';
  const workspaceDoc = new Y.Doc();
  let notebookSetting: unknown;
  const copy = (id: string) => ({
    ready: Promise.resolve(),
    isLoaded: true,
    isClosed: false,
    replica: { doc: docs.get(id)! },
    close: () => undefined,
  });
  const source: DescriberSource = {
    id: 'nb',
    name: 'Personal',
    notes: {
      openCopies: () => [],
      openNote: copy,
      editNote: (id, edit) => {
        edit(docs.get(id)!);
        for (const listener of stored) listener([id]);
        return Promise.resolve();
      },
      onStored: (listener) => (stored.add(listener), () => stored.delete(listener)),
      onPulled: (listener) => (pulled.add(listener), () => pulled.delete(listener)),
      subscribeSync: (listener) => (sync.add(listener), () => sync.delete(listener)),
      syncState: () => ({ phase }),
    },
    workspace: {
      settings: () => (notebookSetting ? { 'ai.description': notebookSetting } : {}),
      getState: () => ({ snapshot: readWorkspace(workspaceDoc) }),
    },
  };
  return {
    source,
    docs,
    workspaceDoc,
    setNotebook: (value: unknown) => (notebookSetting = value),
    edited: (id: string) => {
      for (const listener of stored) listener([id]);
    },
    pulledIn: (id: string) => {
      for (const listener of pulled) listener([id]);
    },
    setPhase: (next: string) => {
      phase = next;
      for (const listener of sync) listener();
    },
  };
}

let settings: Record<string, unknown>;
let calls: string[];
const bridge: AiBridge = {
  describe: (provider, model, prompt) => {
    calls.push(`${provider}|${model}|${prompt}`);
    return Promise.resolve({ ok: true, text: ' "Plans for the week." ' });
  },
};

beforeEach(() => {
  vi.useFakeTimers();
  settings = { 'ai.description.global': true, 'ai.provider': 'claude-code' };
  calls = [];
});
afterEach(() => vi.useRealTimers());

function setup() {
  const fake = fakeSource();
  fake.docs.set('n1', noteDoc('n1', 'Plans', 'Ship AI Descriptions.'));
  registerNote(fake.workspaceDoc, { id: 'n1', folderId: null });
  const describer = new Describer({
    sources: () => [fake.source],
    subscribeSources: () => () => undefined,
    settings: () => settings,
    bridge,
    locks: null,
    today: () => '2026-11-20',
  });
  describer.start();
  return { fake, describer };
}

async function settle() {
  await vi.advanceTimersByTimeAsync(121_000);
}

describe('the describer', () => {
  it('describes after the pause, once, and its write asks for nothing', async () => {
    const { fake, describer } = setup();
    fake.edited('n1');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls).toHaveLength(0);
    fake.edited('n1'); // restarts the pause
    await vi.advanceTimersByTimeAsync(100_000);
    expect(calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('claude-code|haiku|');
    expect(calls[0]).toContain('Ship AI Descriptions.');
    expect(readDescription(fake.docs.get('n1')!)).toBe('Plans for the week.');
    expect(describer.status('nb', 'n1').state).toBe('described');
    // Its own write was stored, which waits the pause again: the hash matches, so no call.
    await settle();
    expect(calls).toHaveLength(1);
    // A real change is described again.
    setTitle(fake.docs.get('n1')!, 'Plans 2');
    fake.pulledIn('n1');
    await settle();
    expect(calls).toHaveLength(2);
  });

  it('sends nothing when Off, with no provider, or for an empty body', async () => {
    const { fake } = setup();
    settings = { 'ai.description.global': false, 'ai.provider': 'claude-code' };
    fake.edited('n1');
    await settle();
    settings = { 'ai.description.global': true };
    fake.edited('n1');
    await settle();
    fake.docs.set('n2', noteDoc('n2', 'Empty', ''));
    settings = { 'ai.description.global': true, 'ai.provider': 'anthropic' };
    fake.edited('n2');
    await settle();
    expect(calls).toHaveLength(0);
  });

  it('follows the closest setting: a folder Off wins over global On', async () => {
    const { fake } = setup();
    createFolder(fake.workspaceDoc, { id: 'w', name: 'Work', parentId: null });
    fake.docs.set('n3', noteDoc('n3', 'In work', 'Text.'));
    registerNote(fake.workspaceDoc, { id: 'n3', folderId: 'w' });
    setFolderAiDescription(fake.workspaceDoc, 'w', 'off');
    fake.edited('n3');
    await settle();
    expect(calls).toHaveLength(0);
    settings = { 'ai.provider': 'anthropic' };
    fake.setNotebook('on');
    setFolderAiDescription(fake.workspaceDoc, 'w', 'inherit');
    fake.edited('n3');
    await settle();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('Folder: Work');
  });

  it('never overwrites a description written by hand, unless asked', async () => {
    const { fake, describer } = setup();
    setHandDescription(fake.docs.get('n1')!, 'Mine.');
    fake.edited('n1');
    await settle();
    expect(calls).toHaveLength(0);
    await describer.describeNow(fake.source, 'n1');
    expect(readDescription(fake.docs.get('n1')!)).toBe('Plans for the week.');
  });

  it('waits for the sync At Sync', async () => {
    const { fake } = setup();
    settings = { ...settings, 'ai.description.when': 'sync' };
    fake.edited('n1');
    await settle();
    expect(calls).toHaveLength(0);
    fake.setPhase('synced');
    await vi.advanceTimersByTimeAsync(10);
    expect(calls).toHaveLength(1);
  });

  it('shows a failure and does not retry by itself', async () => {
    const { fake, describer } = setup();
    const failing: AiBridge = {
      describe: () => {
        calls.push('x');
        return Promise.resolve({ ok: false, code: 'offline', message: 'Couldn’t reach it.' });
      },
    };
    const d = new Describer({
      sources: () => [fake.source],
      subscribeSources: () => () => undefined,
      settings: () => settings,
      bridge: failing,
      locks: null,
    });
    describer.stop();
    d.start();
    fake.edited('n1');
    await settle();
    await settle();
    expect(calls).toEqual(['x']);
    expect(d.status('nb', 'n1')).toMatchObject({ state: 'error', message: 'Couldn’t reach it.' });
  });
});
