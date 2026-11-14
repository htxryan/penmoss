/**
 * Search by meaning in the Mac app's search box (T77, A1155, A1156): a git notebook's search
 * keeps the embedding service fed and fuses its hits with the words'. The bridge here is
 * scripted: it records what the page sends and answers the hits a test gives it.
 */
import type { NoteRecord } from '@penmoss/sync-client';
import { describe, expect, it, vi } from 'vitest';
import { vaultDocuments } from '../../../../packages/core/test/support/search-vault-docs';
import type {
  DesktopMeaning,
  DesktopMeaningHit,
  DesktopMeaningNote,
  DesktopMeaningStatus,
} from '../../src/desktop/bridge';
import {
  MEANING_DOWNLOADING,
  MEANING_NOT_READY,
  NotebookMeaning,
  coverageNotice,
} from '../../src/search/meaning';
import { NO_FILTERS, SearchService, type SearchRequest } from '../../src/search/service';
import { SourceSearches } from '../../src/search/sources';
import { memoryNotes } from './support/memory-notes';

const docs = vaultDocuments();

const READY: DesktopMeaningStatus = {
  state: 'ready',
  generation: 1,
  enabled: true,
  indexed: docs.length,
  total: docs.length,
};

/** A scripted embedding service: what each update sent, and the hits search answers. */
function scriptedBridge(initial: DesktopMeaningStatus = READY) {
  let status = initial;
  const listeners: Array<(status: DesktopMeaningStatus) => void> = [];
  /** Note id → version the service has sections for. */
  const known = new Map<string, string | number>();
  const updates: DesktopMeaningNote[][] = [];
  const searches: Array<{ query: string; ids?: readonly string[] }> = [];
  const closes: string[] = [];
  const state = { hits: [] as DesktopMeaningHit[], floor: 0.28 };
  const bridge: DesktopMeaning = {
    status: () => Promise.resolve(status),
    update: (_notebook, notes) => {
      updates.push([...notes]);
      const need: string[] = [];
      for (const note of notes) {
        if (note.sections) known.set(note.id, note.version);
        else if (known.get(note.id) !== note.version) need.push(note.id);
      }
      return Promise.resolve(need);
    },
    close: (notebook) => {
      closes.push(notebook);
      return Promise.resolve();
    },
    search: (_notebook, query, options) => {
      searches.push({ query, ...(options?.ids ? { ids: options.ids } : {}) });
      return Promise.resolve({ floor: state.floor, hits: state.hits });
    },
    setEnabled: () => Promise.resolve(null),
    onChange: (listener) => {
      listeners.push(listener);
      return () => {
        const at = listeners.indexOf(listener);
        if (at >= 0) listeners.splice(at, 1);
      };
    },
  };
  const emit = (next: Partial<DesktopMeaningStatus>) => {
    status = { ...status, ...next };
    for (const listener of listeners) listener(status);
  };
  return { bridge, updates, searches, closes, listeners, state, known, emit };
}

function recordOf(doc: (typeof docs)[number], overrides: Partial<NoteRecord> = {}): NoteRecord {
  return {
    noteId: doc.id,
    engine: 'yjs14',
    update: new Uint8Array([0, 0]),
    stateVector: new Uint8Array([0]),
    text: doc.text,
    title: doc.title,
    tags: doc.tags,
    headings: doc.headings,
    epoch: 'e',
    updatedAt: doc.updatedAt,
    unsynced: false,
    ...overrides,
  };
}

async function setup(options: { status?: DesktopMeaningStatus; feed?: boolean } = {}) {
  const store = memoryNotes();
  for (const doc of docs) store.records.set(doc.id, recordOf(doc));
  const scripted = scriptedBridge(options.status);
  const meaning = new NotebookMeaning('nb', scripted.bridge, {
    delayMs: 0,
    ...(options.feed !== undefined ? { feed: options.feed } : {}),
  });
  const service = new SearchService({
    store: () => Promise.resolve(store),
    workspace: () => ({
      folders: [
        { id: 'lab', name: 'Home Lab', parentId: null, position: 'a0', sortMode: 'manual' },
      ],
      notes: [{ id: 'git-mirror', folderId: 'lab', position: 'a0', path: null }],
    }),
    reserved: new Set(['workspace']),
    meaning,
    // The vault's records hold no Yjs body: one section of their text.
    sectionsOf: (record) => [{ heading: 'Body', path: ['Body'], text: record.text }],
  });
  // The status arrives.
  await new Promise((resolve) => setTimeout(resolve, 5));
  return { service, store, meaning, ...scripted };
}

const hybrid = (input: string, extra: Partial<SearchRequest> = {}): SearchRequest => ({
  input,
  mode: 'hybrid',
  filters: NO_FILTERS,
  ...extra,
});
const ids = (hits: readonly { id: string }[]) => hits.map((hit) => hit.id);
const meaningHit = (id: string, score: number): DesktopMeaningHit => ({
  id,
  score,
  heading: 'Body',
  preview: `about ${id}`,
});

describe('feeding the embedding service (T77)', () => {
  it('sends every note’s version, then the sections the service asks for, and only changes after', async () => {
    const { updates, known, store, service } = await setup();
    await vi.waitFor(() => expect(known.size).toBe(docs.length));
    expect(updates[0]!.every((note) => note.sections === undefined)).toBe(true);
    expect(updates[1]!.find((note) => note.id === 'sourdough')).toMatchObject({
      title: docs.find((doc) => doc.id === 'sourdough')!.title,
      sections: [{ heading: 'Body' }],
    });
    // A note changes: versions again, and its sections alone.
    const before = updates.length;
    const pests = docs.find((doc) => doc.id === 'pests')!;
    store.records.set('pests', recordOf(pests, { text: 'Aphids again', updatedAt: 99 }));
    service.invalidate();
    await vi.waitFor(() => expect(updates.length).toBe(before + 2));
    expect(
      updates
        .at(-1)!
        .filter((note) => note.sections)
        .map((note) => note.id),
    ).toEqual(['pests']);
  });

  it('sends everything again to a new start of the service, and nothing from other windows', async () => {
    const { updates, known, emit } = await setup();
    await vi.waitFor(() => expect(known.size).toBe(docs.length));
    known.clear();
    emit({ generation: 2 });
    await vi.waitFor(() => expect(known.size).toBe(docs.length));
    const noteWindow = await setup({ feed: false });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(noteWindow.updates).toEqual([]);
    expect(updates.length).toBeGreaterThanOrEqual(4);
  });
});

describe('a removed notebook (A-NEW-1)', () => {
  /** A source as `SourceSearches` sees it, counting its notes' subscribers. */
  const source = () => {
    const subscribers = new Set<() => void>();
    return {
      id: 'nb',
      subscribers,
      notes: {
        subscribe: (listener: () => void) => {
          subscribers.add(listener);
          return () => subscribers.delete(listener);
        },
      },
    };
  };

  it('closes its meaning: the service forgets it, and nothing more is heard or sent', async () => {
    const { service, updates, known, closes, listeners, emit } = await setup();
    await vi.waitFor(() => expect(known.size).toBe(docs.length));
    const searches = new SourceSearches(() => service);
    const nb = source();
    expect(searches.get(nb)).toBe(service);
    expect(nb.subscribers.size).toBe(1);
    expect(listeners).toHaveLength(1);
    // Still open: kept.
    searches.retain(new Set(['nb', 'other']));
    expect(closes).toEqual([]);
    // Removed from the app.
    searches.retain(new Set(['other']));
    expect(closes).toEqual(['nb']);
    expect(listeners).toHaveLength(0);
    expect(nb.subscribers.size).toBe(0);
    // A new start of the service, or a change, sends nothing for it.
    const before = updates.length;
    emit({ generation: 2 });
    service.invalidate();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(updates.length).toBe(before);
    // Closing again is a no-op.
    searches.retain(new Set());
    service.close();
    expect(closes).toEqual(['nb']);
  });

  it('sends nothing it was sending when it is removed mid-sync', async () => {
    const { service, updates, known, closes, meaning } = await setup();
    await vi.waitFor(() => expect(known.size).toBe(docs.length));
    const before = updates.length;
    // A sync is reading its notes' versions when the notebook goes.
    const syncing = meaning.sync();
    service.close();
    await syncing;
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(closes).toEqual(['nb']);
    expect(updates.length).toBe(before);
  });

  it('a view that goes lets go of its searches, and meaning forgets only the removed ones', async () => {
    const { service, closes, listeners } = await setup();
    const searches = new SourceSearches(() => service);
    const nb = source();
    searches.get(nb);
    // The view remounts with the notebook still there: nothing is forgotten.
    searches.release(new Set(['nb']));
    expect(listeners).toHaveLength(0);
    expect(nb.subscribers.size).toBe(0);
    expect(closes).toEqual([]);
    // The view went because the last notebook was removed: then it is.
    const again = await setup();
    const later = new SourceSearches(() => again.service);
    later.get(source());
    later.release(new Set());
    expect(again.closes).toEqual(['nb']);
  });

  it('only the window that feeds the service tells it to forget the notebook', async () => {
    const { service, closes, listeners } = await setup({ feed: false });
    service.close();
    expect(listeners).toHaveLength(0);
    expect(closes).toEqual([]);
  });
});

describe('the search box with meaning (T77, A1155, A1156)', () => {
  it('fuses meaning with the words: a note found by meaning alone, at its heading', async () => {
    const { service, state } = await setup();
    state.hits = [
      meaningHit('sourdough', 0.4),
      meaningHit('offsite-backup', 0.5),
      meaningHit('dune', 0.1),
    ];
    const outcome = await service.search(hybrid('backup'));
    expect(outcome.notice).toBeNull();
    expect(outcome.wordsOnly).toBeUndefined();
    const sourdough = outcome.hits.find((hit) => hit.id === 'sourdough')!;
    expect(sourdough).toMatchObject({
      sources: ['semantic'],
      heading: 'Body',
      snippet: 'about sourdough',
    });
    // Found both ways: the words' snippet, meaning's heading.
    expect(outcome.hits.find((hit) => hit.id === 'offsite-backup')).toMatchObject({
      sources: ['full-text', 'semantic'],
      heading: 'Body',
    });
    // Below the floor, meaning alone is not enough.
    expect(ids(outcome.hits)).not.toContain('dune');
  });

  it('answers semantic by meaning alone, and passes the filters as ids', async () => {
    const { service, state, searches } = await setup();
    state.hits = [meaningHit('dune', 0.1), meaningHit('sourdough', 0.05)];
    const semantic = await service.search(hybrid('desert planet', { mode: 'semantic' }));
    expect(ids(semantic.hits)).toEqual(['dune', 'sourdough']);
    expect(searches.at(-1)!.ids).toBeUndefined();
    await service.search(hybrid('mirror', { filters: { ...NO_FILTERS, folderId: 'lab' } }));
    expect(searches.at(-1)!.ids).toEqual(['git-mirror']);
  });

  it('previews the words while typing, then answers with meaning', async () => {
    const { service } = await setup();
    const typing = await service.typing(hybrid('backu'));
    expect(typing).toMatchObject({ preview: true, notice: null });
    expect(ids(typing!.hits)).toHaveLength(3);
    expect(await service.typing(hybrid('backu', { mode: 'semantic' }))).toBeNull();
  });

  it('says how much meaning covers while it indexes', async () => {
    const { service, emit } = await setup();
    emit({ state: 'indexing', indexed: 3, total: 9 });
    expect((await service.search(hybrid('backup'))).notice).toBe(coverageNotice(3, 9));
  });

  it('says Words only while the model is not ready, and why', async () => {
    const off = await setup({ status: { ...READY, state: 'off', enabled: false } });
    const words = await off.service.search(hybrid('backup'));
    expect(words).toMatchObject({ notice: null, wordsOnly: MEANING_NOT_READY.wordsOnly });
    expect(ids(words.hits)).toHaveLength(3);
    expect((await off.service.typing(hybrid('backu')))?.preview).toBeUndefined();
    expect(off.searches).toEqual([]);
    expect(off.updates).toEqual([]);
    const downloading = await setup({ status: { ...READY, state: 'downloading' } });
    expect(await downloading.service.search(hybrid('backup', { mode: 'semantic' }))).toEqual({
      source: 'device',
      hits: [],
      notice: MEANING_DOWNLOADING.semantic,
    });
  });
});
