import { MATCH_END, MATCH_START } from '@penmoss/core/search';
import type { NoteRecord } from '@penmoss/sync-client';
import { describe, expect, it, vi } from 'vitest';
import { vaultDocuments } from '../../../../packages/core/test/support/search-vault-docs';
import { MEANING_ELSEWHERE } from '../../src/search/meaning';
import { NO_FILTERS, SearchService, type SearchDeps } from '../../src/search/service';
import { memoryNotes } from './support/memory-notes';

const docs = vaultDocuments();

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

function setup(options: Partial<SearchDeps> = {}) {
  const store = memoryNotes();
  for (const doc of docs) store.records.set(doc.id, recordOf(doc));
  const service = new SearchService({
    store: () => Promise.resolve(store),
    workspace: () => ({
      folders: [
        { id: 'lab', name: 'Home Lab', parentId: null, position: 'a0', sortMode: 'manual' },
        { id: 'storage', name: 'Storage', parentId: 'lab', position: 'a0', sortMode: 'manual' },
      ],
      notes: [
        { id: 'git-mirror', folderId: 'lab', position: 'a0', path: null },
        { id: 'zfs-snapshots', folderId: 'storage', position: 'a0', path: null },
      ],
    }),
    reserved: new Set(['workspace']),
    ...options,
  });
  return { service, store };
}

const ids = (hits: readonly { id: string }[]) => hits.map((hit) => hit.id);
const request = (input: string, extra: Partial<Parameters<SearchService['search']>[0]> = {}) => ({
  input,
  mode: 'full-text' as const,
  filters: NO_FILTERS,
  ...extra,
});

describe('search in the app (T22, T23)', () => {
  it('searches this device, ranked as FTS5 ranks, with the last word as a prefix', async () => {
    const { service } = setup();
    const outcome = await service.search(request('backup'));
    expect(outcome).toMatchObject({ source: 'device', notice: null });
    expect(ids(outcome.hits)).toEqual(['zfs-snapshots', 'offsite-backup', 'git-mirror']);
    expect(ids((await service.search(request('sourdo'))).hits)).toEqual(['sourdough']);
    const [first] = (await service.search(request('oil change'))).hits;
    expect(first!.snippet.replaceAll(MATCH_START, '[').replaceAll(MATCH_END, ']')).toContain(
      '[oil] [changed]',
    );
  });

  it('filters by folder with subfolders, by nested tag and by date', async () => {
    const { service } = setup();
    const search = (filters: Partial<typeof NO_FILTERS>) =>
      service.search(request('backup', { filters: { ...NO_FILTERS, ...filters } }));
    expect(ids((await search({ folderId: 'lab' })).hits).sort()).toEqual([
      'git-mirror',
      'zfs-snapshots',
    ]);
    expect(ids((await search({ folderId: 'storage' })).hits)).toEqual(['zfs-snapshots']);
    expect(ids((await search({ tag: 'homelab' })).hits)).toHaveLength(3);
    expect(ids((await search({ tag: 'home' })).hits)).toEqual([]);
    expect(ids((await search({ updatedAfter: Date.parse('2026-09-01') })).hits)).toEqual([
      'offsite-backup',
      'git-mirror',
    ]);
  });

  // Away from the Mac app (A1156): hybrid matches words and says Words only; semantic says why.
  it('says search by meaning is in the Mac app, and answers hybrid by words', async () => {
    const { service } = setup();
    expect(await service.search(request('backup', { mode: 'semantic' }))).toEqual({
      source: 'device',
      hits: [],
      notice: MEANING_ELSEWHERE.semantic,
    });
    const hybrid = await service.search(request('backup', { mode: 'hybrid' }));
    expect(hybrid.notice).toBeNull();
    expect(hybrid.wordsOnly).toBe(MEANING_ELSEWHERE.wordsOnly);
    expect(hybrid.hits).toHaveLength(3);
  });

  it('indexes only what changed since the last search', async () => {
    const { service, store } = setup();
    expect(ids((await service.search(request('zanzibar'))).hits)).toEqual([]);
    const get = vi.spyOn(store, 'get');
    store.records.set(
      'pests',
      recordOf(
        docs.find((d) => d.id === 'pests')!,
        { text: 'Zanzibar aphids', updatedAt: 9 },
      ),
    );
    store.records.delete('compost');
    store.records.set(
      'dune',
      recordOf(
        docs.find((d) => d.id === 'dune')!,
        { deleted: true, updatedAt: 10 },
      ),
    );
    service.invalidate();
    expect(ids((await service.search(request('zanzibar'))).hits)).toEqual(['pests']);
    expect(get.mock.calls.map(([id]) => id)).toEqual(['pests']);
    expect(ids((await service.search(request('browns'))).hits)).toEqual([]);
    expect(ids((await service.search(request('arrakis'))).hits)).toEqual([]);
  });

  it('drops a note whose record is gone while its list entry remains', async () => {
    const { service, store } = setup();
    expect(ids((await service.search(request('aphids'))).hits)).toEqual(['pests']);
    const pests = store.records.get('pests')!;
    store.records.set('pests', { ...pests, updatedAt: pests.updatedAt + 1 });
    const get = store.get.bind(store);
    vi.spyOn(store, 'get').mockImplementation((id) =>
      id === 'pests' ? Promise.resolve(undefined) : get(id),
    );
    service.invalidate();
    expect(ids((await service.search(request('aphids'))).hits)).toEqual([]);
  });
});

describe('search as you type (A111)', () => {
  it('answers typing from this device at once', async () => {
    const { service } = setup();
    const typing = await service.typing(request('backu'));
    expect(typing).toMatchObject({ source: 'device', notice: null });
    expect(ids(typing!.hits)).toEqual(['zfs-snapshots', 'offsite-backup', 'git-mirror']);
    // Without meaning, hybrid's words are the answer, not a preview.
    const hybrid = await service.typing(request('backu', { mode: 'hybrid' }));
    expect(ids(hybrid!.hits)).toHaveLength(3);
    expect(hybrid!.preview).toBeUndefined();
    // Search by meaning has nothing to show.
    expect(await service.typing(request('backu', { mode: 'semantic' }))).toBeNull();
  });
});

describe('the offline index at startup (A119)', () => {
  it('fills older records’ fields first, builds in slices and saves the index', async () => {
    const turns = vi.fn(() => Promise.resolve());
    const { service, store } = setup({ yieldToPage: turns, indexSlice: 10, saveDelayMs: 0 });
    const order: string[] = [];
    const listTexts = store.listTexts!.bind(store);
    Object.assign(store, {
      backfillSearchFields: () => {
        order.push('backfill');
        return Promise.resolve();
      },
      listTexts: () => {
        order.push('texts');
        return listTexts();
      },
    });
    expect(ids((await service.search(request('backup'))).hits)).toHaveLength(3);
    expect(order).toEqual(['backfill', 'texts']);
    expect(turns.mock.calls.length).toBeGreaterThanOrEqual(5);
    await vi.waitFor(() => expect(store.state.get('searchIndex')).toBeDefined());
  });

  it('restores a saved index instead of reading and tokenising every note again', async () => {
    const first = setup({ saveDelayMs: 0 });
    await first.service.search(request('backup'));
    await vi.waitFor(() => expect(first.store.state.get('searchIndex')).toBeDefined());

    const second = setup({ saveDelayMs: 0 });
    second.store.state.set('searchIndex', structuredClone(first.store.state.get('searchIndex')));
    const listTexts = vi.spyOn(second.store, 'listTexts');
    const get = vi.spyOn(second.store, 'get');
    // One note changed since the index was saved: only it is read.
    const pests = second.store.records.get('pests')!;
    second.store.records.set('pests', { ...pests, text: 'Zanzibar aphids', updatedAt: 99 });
    expect(ids((await second.service.search(request('backup'))).hits)).toEqual(
      ids((await first.service.search(request('backup'))).hits),
    );
    expect(ids((await second.service.search(request('zanzibar'))).hits)).toEqual(['pests']);
    expect(listTexts).not.toHaveBeenCalled();
    expect(get.mock.calls.map(([id]) => id)).toEqual(['pests']);
  });
});
