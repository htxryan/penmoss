import { initNote } from '@penmoss/sync-client/note';
import { recordFromDoc, withoutLinks } from '@penmoss/sync-client/records';
import { createYjs14Replica } from '@penmoss/sync-client/yjs14';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  loadBacklinks,
  localUnlinked,
  snippetParts,
  distinct,
  othersKey,
} from '../../src/notes/backlinks';
import { NoteDirectory, noteHref } from '../../src/notes/directory';
import { MAX_LIVE_EMBEDS, type Notes } from '../../src/notes/service';
import {
  appendHeading,
  appendLinkParagraph,
  appendParagraph,
} from '../../../../packages/sync-client/test/support/editing';
import { testNotes } from './support/local-sources';
import { memoryNotes } from './support/memory-notes';

const stop: Notes[] = [];
afterEach(() => {
  for (const notes of stop.splice(0)) notes.stop();
});

function setup() {
  const store = memoryNotes();
  const notes = testNotes(store, { persistStorage: () => Promise.resolve(true) });
  stop.push(notes);
  return { notes, store };
}

/** Stores a note whose body has `text`, then a link to each target. */
function storeNote(
  store: ReturnType<typeof memoryNotes>,
  id: string,
  title: string,
  text: string,
  targets: Array<{ noteId: string; target: string }> = [],
  unsynced = false,
) {
  const replica = createYjs14Replica();
  initNote(replica.doc, { id, created: '2026-10-22T09:00:00-05:00', kind: 'note' }, title);
  if (targets.length === 0) appendParagraph(replica, text);
  for (const [index, target] of targets.entries()) {
    appendLinkParagraph(replica, index === 0 ? text : '', target, '');
  }
  store.records.set(id, recordFromDoc(id, replica.doc, { epoch: 'e', unsynced, updatedAt: 1000 }));
}

function directoryFor(notes: Notes, navigate = vi.fn()) {
  const register = vi.fn();
  const openTab = vi.fn();
  const openWindow = vi.fn();
  const directory = new NoteDirectory({
    notes,
    folderOf: (id) => (id === 'A' ? 'f1' : null),
    folderName: (id) => (id === 'f1' ? 'Projects' : null),
    register,
    navigate,
    openTab,
    openWindow,
  });
  return { directory, register, navigate, openTab, openWindow };
}

describe('embeds (T13)', () => {
  type Embedded = { embedded: Map<string, { listeners: Set<() => void> }> };

  it('follow a note: opened once for every embed of it, and closed after the last goes', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const { notes, store } = setup();
      storeNote(store, 'G', 'Garden', 'Raised beds');
      await notes.refreshLocal();
      const { directory } = directoryFor(notes);
      const embeds = directory.forNote('HOST');
      const first = vi.fn();
      const second = vi.fn();

      const offFirst = embeds.watch('G', first);
      const offSecond = embeds.watch('G', second);
      await vi.waitFor(() => expect(first).toHaveBeenCalled());
      expect(second).toHaveBeenCalled();
      const open = (notes as unknown as Embedded).embedded;
      expect([...open.keys()]).toEqual(['G']);
      expect(embeds.noteId).toBe('HOST');
      expect(await embeds.body('G')).toMatchObject({ type: 'doc' });

      offFirst();
      offSecond();
      // A re-render that watches again within the grace period keeps it open.
      const third = vi.fn();
      const offThird = embeds.watch('G', third);
      vi.advanceTimersByTime(5000);
      expect(open.has('G')).toBe(true);
      offThird();
      vi.advanceTimersByTime(5000);
      expect(open.has('G')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('embeds: how many notes stay open', () => {
  type Embedded = { embedded: Map<string, unknown> };

  it('keeps at most a few notes open (one socket each), and opens the next waiting one when one lets go', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const { notes, store } = setup();
      const ids = Array.from({ length: 12 }, (_, i) => `N${String(i).padStart(2, '0')}`);
      for (const id of ids) storeNote(store, id, `Note ${id}`, 'Text');
      await notes.refreshLocal();
      const opened = vi.spyOn(notes, 'openNote');
      const listeners = ids.map(() => vi.fn());
      const offs = ids.map((id, i) => notes.watchNote(id, listeners[i]!));
      const open = (notes as unknown as Embedded).embedded;

      expect(MAX_LIVE_EMBEDS).toBe(8);
      expect(opened).toHaveBeenCalledTimes(8);
      expect(open.size).toBe(8);

      offs[0]!();
      offs[1]!();
      vi.advanceTimersByTime(5000);
      expect(open.size).toBe(8);
      expect([...open.keys()]).toEqual(expect.arrayContaining(['N08', 'N09']));
      await vi.waitFor(() => expect(listeners[8]).toHaveBeenCalled());

      // A watch let go of while it waits never opens its note.
      offs[10]!();
      for (const off of offs.slice(2)) off();
      vi.advanceTimersByTime(5000);
      expect(open.size).toBe(0);
      expect(opened).toHaveBeenCalledTimes(10);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('local links of notes stored before T16', () => {
  it('are computed once, in the background, and stored with the links version', async () => {
    const { notes, store } = setup();
    storeNote(store, 'A', 'Alpha', 'See ', [{ noteId: 'B', target: 'Beta' }]);
    storeNote(store, 'B', 'Beta', 'No links here');
    storeNote(store, 'C', 'Gamma', 'Nothing either');
    // A and B as an older build stored them: no links field and no version.
    for (const id of ['A', 'B']) {
      store.records.set(id, withoutLinks(store.records.get(id)!));
    }
    const update = vi.spyOn(store, 'update');

    await notes.refreshLocal();
    await vi.waitFor(() =>
      expect(notes.localLinks().find((note) => note.id === 'A')?.links).toMatchObject([
        { noteId: 'B', target: 'Beta' },
      ]),
    );
    expect(store.records.get('A')!.linksVersion).toBeGreaterThan(0);
    expect(store.records.get('B')!.linksVersion).toBeGreaterThan(0);
    // C was written with the version (it has no links): it is never recomputed.
    expect(update.mock.calls.map(([id]) => id).sort()).toEqual(['A', 'B']);

    await notes.refreshLocal();
    expect(update).toHaveBeenCalledTimes(2);
  });
});

describe('an open note’s links (T51, A936)', () => {
  it('reach the local links as they are made, before the stored record catches up', async () => {
    const { notes, store } = setup();
    storeNote(store, 'A', 'Alpha', 'Nothing yet');
    storeNote(store, 'B', 'Beta', 'No links here');
    await notes.refreshLocal();
    const listener = vi.fn();
    notes.subscribe(listener);

    const open = notes.openNote('A');
    await open.ready;
    appendLinkParagraph(open.replica, 'See ', { noteId: 'B', target: 'Beta' }, '');
    // The Local Graph and the Backlinks panel read these, and redraw as the list changes.
    await vi.waitFor(() =>
      expect(notes.localLinks().find((note) => note.id === 'A')?.links).toMatchObject([
        { noteId: 'B', target: 'Beta' },
      ]),
    );
    expect(listener).toHaveBeenCalled();
    open.close();
  });
});

describe('NoteDirectory', () => {
  it('gives current titles, fuzzy matches, exact resolution and broken links for unknown notes', async () => {
    const { notes, store } = setup();
    storeNote(store, 'A', 'Garden plan', 'beds');
    storeNote(store, 'B', 'Grocery list', 'eggs');
    await notes.refreshLocal();
    const { directory } = directoryFor(notes);

    expect(directory.title('A')).toBe('Garden plan');
    expect(directory.title('missing')).toBeNull();
    expect(directory.search('gpl', 5)).toEqual([
      { id: 'A', title: 'Garden plan', detail: 'Projects' },
    ]);
    expect(directory.resolve('grocery LIST')).toBe('B');
    // The note being edited is not offered as a link to itself.
    expect(directory.forNote('A').search('garden', 5)).toEqual([]);
  });

  it('creates a note from a link, filed beside the linking note, without taking focus', async () => {
    const { notes } = setup();
    const { directory, register } = directoryFor(notes);
    const listener = vi.fn();
    directory.subscribe(listener);

    const id = directory.forNote('A').create('  Holiday ideas ')!;

    expect(directory.title(id)).toBe('Holiday ideas');
    expect(register).toHaveBeenCalledWith(id, 'f1');
    expect(notes.takeTitleFocus(id)).toBe(false);
    expect(listener).toHaveBeenCalled();
    await notes.settled(id);
    expect(await notes.body(id)).toMatchObject({ type: 'doc' });
  });

  it('opens a note at a heading', () => {
    const { notes } = setup();
    const { directory, navigate } = directoryFor(notes);
    directory.open('A', 'Beds & borders');
    expect(navigate).toHaveBeenCalledWith('/notes/A?heading=Beds%20%26%20borders');
    expect(noteHref('A')).toBe('/notes/A');
  });

  it('opens a note in a new tab or a new window, as the click asked (T45, A710)', () => {
    const { notes } = setup();
    const { directory, navigate, openTab, openWindow } = directoryFor(notes);
    directory.open('A', null, 'tab');
    expect(openTab).toHaveBeenCalledWith('/notes/A');
    directory.open('A', 'Beds', 'window');
    expect(openWindow).toHaveBeenCalledWith('A', 'Beds');
    expect(navigate).not.toHaveBeenCalled();
  });

  it('reads a note’s headings from this device’s copy', async () => {
    const { notes, store } = setup();
    const replica = createYjs14Replica();
    appendHeading(replica, 2, 'Beds');
    store.records.set('H', recordFromDoc('H', replica.doc, { epoch: null, unsynced: false }));
    const { directory } = directoryFor(notes);
    expect(await directory.headings('H')).toEqual(['Beds']);
  });
});

describe('backlinks', () => {
  it('come from the local replica offline: linked with context, unlinked by title', async () => {
    const { notes, store } = setup();
    storeNote(store, 'T', 'Garden plan', 'Tomatoes');
    storeNote(store, 'S', 'Weekly review', 'Started the ', [
      { noteId: 'T', target: 'Garden plan' },
    ]);
    storeNote(store, 'M', 'Shopping', 'Seeds for the garden plan, and compost.');
    storeNote(store, 'X', 'Other', 'Gardening plans are different words.');
    await notes.refreshLocal();

    const result = await loadBacklinks(notes, 'T', 'Garden plan');

    expect(result.linked).toMatchObject([
      { id: 'S', title: 'Weekly review', mentions: [{ embed: false }] },
    ]);
    expect(result.linked[0]!.mentions[0]!.context).toEqual([
      'Started the ',
      { noteId: 'T', target: 'Garden plan', heading: null, alias: null },
    ]);
    expect(result.unlinked.map((note) => note.id)).toEqual(['M']);
    expect(result.unlinked[0]!.snippet.find((part) => part.match)?.text).toBe('garden plan');
  });

  it('show a block holding two links to the note once', () => {
    const ref = { noteId: 'T', target: 'Garden plan', heading: null, alias: null };
    const twice = {
      context: ['See ', ref, ' and ', { ...ref, heading: 'Soil' }],
      embed: false,
      heading: null,
    };
    const other = { context: ['Elsewhere ', ref], embed: false, heading: null };
    expect(distinct([twice, { ...twice, heading: 'Soil' }, other])).toEqual([twice, other]);
  });

  it('split snippets on their markers, and find no mention of a title without words', () => {
    expect(snippetParts('a\u0002b\u0003c\u0002d')).toEqual([
      { text: 'a', match: false },
      { text: 'b', match: true },
      { text: 'c', match: false },
      { text: 'd', match: true },
    ]);
    expect(localUnlinked([{ noteId: 'a', title: 'A', text: 'x' }], 't', '  ', [])).toEqual([]);
  });
});

describe('when the Backlinks panel reloads', () => {
  const entry = (id: string, updatedAt: number, title = id) => ({
    id,
    title,
    excerpt: '',
    tags: [],
    updatedAt,
    unsynced: false,
  });

  it('keys other notes cheaply: typing here changes nothing, edits elsewhere do', () => {
    const list = [entry('me', 50), entry('a', 40), entry('b', 30)];
    const key = othersKey(list, 'me');
    expect(othersKey([entry('me', 60), entry('a', 40), entry('b', 30)], 'me')).toBe(key);
    expect(othersKey([entry('me', 50), entry('a', 45), entry('b', 30)], 'me')).not.toBe(key);
    expect(othersKey([entry('me', 50), entry('b', 30), entry('a', 20)], 'me')).not.toBe(key);
    expect(othersKey([entry('me', 50), entry('a', 40)], 'me')).not.toBe(key);
    expect(othersKey([...list, entry('c', 10)], 'me')).not.toBe(key);
  });
});
