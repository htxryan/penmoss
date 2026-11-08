import type { NoteMeta } from '@penmoss/sync-client';
import { describe, expect, it } from 'vitest';
import { applyLive, displayTitle, mergeNotes, toMillis } from '../../src/notes/list';

const local = (noteId: string, overrides: Partial<NoteMeta> = {}): NoteMeta => ({
  noteId,
  engine: 'yjs14',
  title: `Local ${noteId}`,
  excerpt: 'local body',
  epoch: null,
  updatedAt: 1000,
  unsynced: false,
  deleted: false,
  bytes: 10,
  tags: [],
  ...overrides,
});

describe('mergeNotes', () => {
  it('lists this device’s notes, newest first', () => {
    const entries = mergeNotes([local('a', { updatedAt: 1 }), local('b', { updatedAt: 2 })]);
    expect(entries.map((entry) => entry.id)).toEqual(['b', 'a']);
    expect(entries[0]).toEqual({
      id: 'b',
      title: 'Local b',
      excerpt: 'local body',
      updatedAt: 2,
      unsynced: false,
      tags: [],
    });
  });

  it('lets live edits from an open note override the title and move it up', () => {
    const live = new Map([['a', { title: 'Typing…', updatedAt: 10 }]]);
    const entries = mergeNotes([local('a', { updatedAt: 1 }), local('b', { updatedAt: 5 })], live);
    expect(entries.map(({ id, title }) => ({ id, title }))).toEqual([
      { id: 'a', title: 'Typing…' },
      { id: 'b', title: 'Local b' },
    ]);
  });

  it('keeps the stored time when a live change came from elsewhere', () => {
    const live = new Map([['a', { title: 'Renamed elsewhere', updatedAt: 0 }]]);
    expect(mergeNotes([local('a', { updatedAt: 7 })], live)[0]).toMatchObject({
      title: 'Renamed elsewhere',
      updatedAt: 7,
    });
  });
});

describe('the workspace record', () => {
  it('is not a note', () => {
    const entries = mergeNotes([local('workspace'), local('a')]);
    expect(entries.map((entry) => entry.id)).toEqual(['a']);
  });
});

describe('applyLive', () => {
  it('gives what a full merge gives, for edits here and from elsewhere', () => {
    const locals = [
      local('a', { updatedAt: 100 }),
      local('b', { updatedAt: 300 }),
      local('c', { updatedAt: 200, unsynced: true }),
      local('d', { updatedAt: 200 }),
    ];
    const live = new Map<string, { title: string; updatedAt: number }>();
    let entries = mergeNotes(locals, live);
    const changes: Array<[string, { title: string; updatedAt: number }]> = [
      ['a', { title: 'A1', updatedAt: 500 }],
      ['c', { title: 'C1', updatedAt: 0 }],
      ['d', { title: 'D1', updatedAt: 500 }],
      ['a', { title: 'A2', updatedAt: 600 }],
    ];
    for (const [id, change] of changes) {
      live.set(id, change);
      const patched = applyLive(entries, id, change);
      expect(patched).toEqual(mergeNotes(locals, live));
      entries = patched!;
    }
  });

  it('asks for a full merge when the note is not listed', () => {
    expect(applyLive([], 'x', { title: 'X', updatedAt: 1 })).toBeNull();
  });
});

describe('helpers', () => {
  it('shows Untitled for blank titles', () => {
    expect(displayTitle('')).toBe('Untitled');
    expect(displayTitle('   ')).toBe('Untitled');
    expect(displayTitle('Plans')).toBe('Plans');
  });

  it('converts times', () => {
    expect(toMillis(5)).toBe(5);
    expect(toMillis('1970-01-01T00:00:01Z')).toBe(1000);
    expect(toMillis('garbage')).toBe(0);
    expect(toMillis(undefined)).toBe(0);
  });
});
