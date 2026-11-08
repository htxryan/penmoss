/**
 * Links, embeds and the Info sheet's details on the phone (T40 P7; A470,
 * A471, A473, A475): other notes' bodies come over the bridge as the stored
 * updates Kotlin holds, never read by Kotlin, applied here to a scratch
 * document; embeds on screen follow their note through `watchNote` and
 * `noteChanged`; a link followed to a heading opens there; and the open
 * note's details go to the app at most every 300 ms.
 */
import { NOTE_ROOT } from '@penmoss/sync-client';
import { initNote } from '@penmoss/sync-client/note';
import { createYjs14Replica, type Yjs14Replica } from '@penmoss/sync-client/yjs14';
import * as Y from '@y/y';
import { toBase64 } from 'lib0/buffer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EditorHost, HEADING_MARK_MS, INFO_EVERY_MS } from '../src/host';
import {
  bodyOf,
  CONTENT_TIMEOUT_MS,
  MAX_UNWATCHED_CACHED,
  UNWATCHED_CACHE_MS,
  WATCH_RELEASE_MS,
} from '../src/linked';
import type { FromEditor, ToEditor } from '../src/protocol';

const NOTE = '01JD2Z7Q8R4T6Y8W0E2R4T6YB1';
const GARDEN = '01JD2Z7Q8R4T6Y8W0E2R4T6YB2';
const BEDS = '01JD2Z7Q8R4T6Y8W0E2R4T6YB3';

type Block =
  | { readonly heading: string; readonly level?: number }
  | { readonly text: string }
  | { readonly embed: string; readonly target: string; readonly section?: string };

/** A note as the @y/prosemirror binding lays one out: headings, paragraphs and embeds. */
function noteOf(id: string, title: string, blocks: readonly Block[]): Yjs14Replica {
  const replica = createYjs14Replica();
  initNote(replica.doc, { id, created: '2026-10-23T10:00:00-05:00', kind: 'note' }, title);
  replica.doc.transact(() => {
    for (const block of blocks) {
      const root = replica.doc.get(NOTE_ROOT);
      if ('heading' in block) {
        const node = new Y.Node('heading');
        root.push([node]);
        node.setAttr('level', block.level ?? 2);
        node.insert(0, block.heading);
      } else if ('text' in block) {
        const node = new Y.Node('paragraph');
        root.push([node]);
        node.insert(0, block.text);
      } else {
        const node = new Y.Node('embed');
        root.push([node]);
        node.setAttr('noteId', block.embed);
        node.setAttr('target', block.target);
        node.setAttr('heading', block.section ?? null);
        node.setAttr('alias', null);
      }
    }
  });
  return replica;
}

const stored = (replica: Yjs14Replica, id = '21') => [
  { id, update: toBase64(replica.encodeStateAsUpdate()) },
];

const content = (
  noteId: string,
  replica: Yjs14Replica | null,
  state: 'ok' | 'missing' | 'tooLarge' = replica ? 'ok' : 'missing',
): Extract<ToEditor, { type: 'noteContent' }> => ({
  v: 1,
  type: 'noteContent',
  noteId,
  state,
  updates: replica && state === 'ok' ? stored(replica) : [],
});

const hosts: EditorHost[] = [];
afterEach(() => {
  for (const host of hosts.splice(0)) host.close();
  document.body.replaceChildren();
  vi.useRealTimers();
});

function page() {
  const root = document.createElement('main');
  const title = document.createElement('textarea');
  const body = document.createElement('div');
  const unsupported = document.createElement('pre');
  root.append(title, body, unsupported);
  document.body.append(root);
  const sent: FromEditor[] = [];
  const host = new EditorHost({ root, title, body, unsupported }, (message) => sent.push(message));
  hosts.push(host);
  host.handle({
    v: 1,
    type: 'directory',
    notes: [
      { id: NOTE, title: 'Weekly review' },
      { id: GARDEN, title: 'Garden' },
      { id: BEDS, title: 'Beds' },
    ],
  });
  return { host, sent, body };
}

function openNote(host: EditorHost, replica: Yjs14Replica): void {
  host.handle({
    v: 1,
    type: 'open',
    noteId: NOTE,
    synced: stored(replica, '11'),
    pending: [],
    editable: true,
  });
}

const of = <T extends FromEditor['type']>(sent: FromEditor[], type: T) =>
  sent.filter((message): message is Extract<FromEditor, { type: T }> => message.type === type);

describe('other notes over the bridge (T40 P7, A470)', () => {
  it('lists a linked note’s headings from its stored updates, as the web does', async () => {
    const { host, sent } = page();
    openNote(host, noteOf(NOTE, 'Weekly review', []));
    const garden = noteOf(GARDEN, 'Garden', [
      { heading: 'Beds' },
      { text: 'Raised.' },
      { heading: 'Watering', level: 3 },
      { heading: 'Beds' },
    ]);
    const headings = host.linkedNotes.headings(GARDEN);
    // Asked once, by id; Kotlin answers with the bytes it stores and never reads.
    expect(of(sent, 'noteContent')).toEqual([{ v: 1, type: 'noteContent', noteId: GARDEN }]);
    host.receive(JSON.stringify(content(GARDEN, garden)));
    expect(await headings).toEqual(['Beds', 'Watering']);
  });

  it('asks once for several readers of one note, and reads it again after a while', async () => {
    vi.useFakeTimers();
    const { host, sent } = page();
    openNote(host, noteOf(NOTE, 'Weekly review', []));
    const garden = noteOf(GARDEN, 'Garden', [{ heading: 'Beds' }]);
    const first = host.linkedNotes.headings(GARDEN);
    const second = host.linkedNotes.body(GARDEN);
    expect(of(sent, 'noteContent')).toHaveLength(1);
    host.handle(content(GARDEN, garden));
    expect(await first).toEqual(['Beds']);
    expect(await second).not.toBeNull();
    // Read again within a few seconds: from what was read.
    await host.linkedNotes.headings(GARDEN);
    expect(of(sent, 'noteContent')).toHaveLength(1);
    // Later, the note may have changed: asked again.
    vi.advanceTimersByTime(6_000);
    void host.linkedNotes.headings(GARDEN);
    expect(of(sent, 'noteContent')).toHaveLength(2);
  });

  it('keeps a note no embed shows only for a few seconds, and only a few such notes', async () => {
    vi.useFakeTimers();
    const { host } = page();
    openNote(host, noteOf(NOTE, 'Weekly review', []));
    const linked = host.linkedNotes;
    const read = linked.headings(GARDEN);
    host.handle(content(GARDEN, noteOf(GARDEN, 'Garden', [{ heading: 'Beds' }])));
    await read;
    expect(linked.cached).toEqual([GARDEN]);
    // Nothing asks for it again: its body is let go, not kept until the page closes.
    vi.advanceTimersByTime(UNWATCHED_CACHE_MS + 1);
    expect(linked.cached).toEqual([]);
    // Completion across many notes in a few seconds keeps only the latest few.
    const many = Array.from(
      { length: MAX_UNWATCHED_CACHED + 4 },
      (_, i) => `01JD2Z7Q8R4T6Y8W0E2R4T6Z${String(i).padStart(2, '0')}`,
    );
    for (const id of many) {
      const asked = linked.body(id);
      host.handle(content(id, noteOf(id, `Note ${id}`, [{ text: 'x' }])));
      await asked;
    }
    expect(linked.cached).toEqual(many.slice(-MAX_UNWATCHED_CACHED));
    // A watched note's body stays however long it shows.
    const stop = linked.watch(BEDS, () => undefined);
    const beds = linked.body(BEDS);
    host.handle(content(BEDS, noteOf(BEDS, 'Beds', [{ text: 'Raised' }])));
    await beds;
    vi.advanceTimersByTime(UNWATCHED_CACHE_MS * 10);
    expect(linked.cached).toEqual([BEDS]);
    stop();
  });

  it('gives no body for a note the phone lacks, one too large, or one that never answers', async () => {
    vi.useFakeTimers();
    const { host } = page();
    openNote(host, noteOf(NOTE, 'Weekly review', []));
    const missing = host.linkedNotes.body(GARDEN);
    host.handle(content(GARDEN, null));
    expect(await missing).toBeNull();
    const large = host.linkedNotes.body(BEDS);
    host.handle(content(BEDS, null, 'tooLarge'));
    expect(await large).toBeNull();
    const silent = host.linkedNotes.body(GARDEN);
    vi.advanceTimersByTime(CONTENT_TIMEOUT_MS);
    expect(await silent).toBeNull();
  });

  it('reads no partial note: updates that build on ones not sent give no body', () => {
    const garden = noteOf(GARDEN, 'Garden', [{ text: 'One' }]);
    const before = garden.encodeStateVector();
    garden.doc.transact(() => {
      const node = new Y.Node('paragraph');
      garden.doc.get(NOTE_ROOT).push([node]);
      node.insert(0, 'Two');
    });
    const later = toBase64(Y.encodeStateAsUpdate(garden.doc, before));
    expect(bodyOf([{ id: '2', update: later }])).toBeNull();
    expect(bodyOf(stored(garden))).not.toBeNull();
    // Bytes that are no update at all.
    expect(bodyOf([{ id: '9', update: '/////w==' }])).toBeNull();
  });

  it('reads the open note itself from its own document, asking the app nothing', async () => {
    const { host, sent } = page();
    openNote(host, noteOf(NOTE, 'Weekly review', [{ heading: 'Wins' }]));
    expect(await host.linkedNotes.headings(NOTE)).toEqual(['Wins']);
    expect(of(sent, 'noteContent')).toEqual([]);
  });
});

describe('live embeds (T40 P7, LK4, A471)', () => {
  const embedOf = (body: HTMLElement) => body.querySelector<HTMLElement>('.pm-embed')!;

  it('renders an embedded section from stored updates, and again when the note changes', async () => {
    const { host, sent, body } = page();
    openNote(
      host,
      noteOf(NOTE, 'Weekly review', [{ embed: GARDEN, target: 'Garden', section: 'Beds' }]),
    );
    await vi.waitFor(() => expect(of(sent, 'noteContent').map((m) => m.noteId)).toEqual([GARDEN]));
    const garden = noteOf(GARDEN, 'Garden', [
      { heading: 'Beds' },
      { text: 'Tomatoes by the fence.' },
      { heading: 'Paths' },
      { text: 'Gravel.' },
    ]);
    host.handle(content(GARDEN, garden));
    await vi.waitFor(() =>
      expect(embedOf(body).querySelector('.pm-embed-body')!.textContent).toContain(
        'Tomatoes by the fence.',
      ),
    );
    // Only the section; the title says which.
    expect(embedOf(body).querySelector('.pm-embed-body')!.textContent).not.toContain('Gravel.');
    expect(embedOf(body).querySelector('.pm-embed-title')!.textContent).toBe('Garden › Beds');
    // On screen, it follows the note.
    expect(of(sent, 'watchNote')).toContainEqual({
      v: 1,
      type: 'watchNote',
      noteId: GARDEN,
      on: true,
    });

    // Another device edits the garden; a sync stores it, and the app says so.
    const before = garden.encodeStateVector();
    garden.doc.transact(() => {
      const beds = garden.doc.get(NOTE_ROOT).get(1) as Y.Node;
      beds.insert(0, 'Peppers and ');
    });
    const asked = of(sent, 'noteContent').length;
    host.handle({ v: 1, type: 'noteChanged', noteId: GARDEN });
    await vi.waitFor(() => expect(of(sent, 'noteContent').length).toBe(asked + 1));
    host.handle({
      v: 1,
      type: 'noteContent',
      noteId: GARDEN,
      state: 'ok',
      updates: [
        ...stored(garden).map((entry) => ({ ...entry, id: '21' })),
        { id: '22', update: toBase64(Y.encodeStateAsUpdate(garden.doc, before)) },
      ],
    });
    await vi.waitFor(() =>
      expect(embedOf(body).querySelector('.pm-embed-body')!.textContent).toContain(
        'Peppers and Tomatoes by the fence.',
      ),
    );
    // Nothing was written to the open note by rendering it.
    expect(of(sent, 'update')).toEqual([]);
  });

  it('shows a note embedding itself as a link, asking for nothing', async () => {
    const { host, sent, body } = page();
    openNote(host, noteOf(NOTE, 'Weekly review', [{ embed: NOTE, target: 'Weekly review' }]));
    await vi.waitFor(() =>
      expect(embedOf(body).querySelector('.pm-embed-notice')!.textContent).toContain(
        'Embedded in itself',
      ),
    );
    expect(of(sent, 'noteContent')).toEqual([]);
  });

  it('shows a cycle through another note as a link inside its embed', async () => {
    const { host, sent, body } = page();
    openNote(host, noteOf(NOTE, 'Weekly review', [{ embed: GARDEN, target: 'Garden' }]));
    await vi.waitFor(() => expect(of(sent, 'noteContent')).toHaveLength(1));
    // The garden embeds the weekly review back.
    host.handle(
      content(
        GARDEN,
        noteOf(GARDEN, 'Garden', [{ text: 'Beds.' }, { embed: NOTE, target: 'Weekly review' }]),
      ),
    );
    await vi.waitFor(() =>
      expect(body.querySelector('.pm-embed-nested .pm-embed-notice')!.textContent).toContain(
        'Embedded in itself',
      ),
    );
  });

  it('says a note the phone lacks is not on this device yet', async () => {
    const { host, sent, body } = page();
    openNote(host, noteOf(NOTE, 'Weekly review', [{ embed: GARDEN, target: 'Garden' }]));
    await vi.waitFor(() => expect(of(sent, 'noteContent')).toHaveLength(1));
    host.handle(content(GARDEN, null));
    await vi.waitFor(() =>
      expect(embedOf(body).querySelector('.pm-embed-notice')!.textContent).toBe(
        '“Garden” is not on this device yet.',
      ),
    );
  });

  it('stops following a note a moment after its last embed goes', async () => {
    const { host, sent } = page();
    openNote(host, noteOf(NOTE, 'Weekly review', [{ embed: GARDEN, target: 'Garden' }]));
    await vi.waitFor(() => expect(of(sent, 'noteContent')).toHaveLength(1));
    host.handle(content(GARDEN, noteOf(GARDEN, 'Garden', [{ text: 'Beds.' }])));
    await vi.waitFor(() => expect(host.linkedNotes.watched).toEqual([GARDEN]));
    vi.useFakeTimers();
    host.close();
    expect(of(sent, 'watchNote').filter((m) => !m.on)).toEqual([]);
    vi.advanceTimersByTime(WATCH_RELEASE_MS);
    expect(of(sent, 'watchNote').filter((m) => !m.on)).toEqual([
      { v: 1, type: 'watchNote', noteId: GARDEN, on: false },
    ]);
    expect(host.linkedNotes.watched).toEqual([]);
  });
});

describe('links to a heading (T40 P7, LK3)', () => {
  it('opens a link at its heading through the app', () => {
    const { host, sent } = page();
    openNote(host, noteOf(NOTE, 'Weekly review', []));
    const { editor } = host.editor!;
    editor.commands.setContent({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'wikilink', attrs: { target: 'Garden', noteId: GARDEN, heading: 'Beds' } },
          ],
        },
      ],
    });
    let at = -1;
    editor.state.doc.descendants((node, pos) => {
      if (node.type.name === 'wikilink') at = pos;
    });
    const event = new MouseEvent('click', { button: 0 });
    editor.view.someProp('handleClickOn', (handle) =>
      handle(editor.view, at, editor.state.doc.nodeAt(at)!, at, event, true),
    );
    expect(of(sent, 'openNote').at(-1)).toEqual({
      v: 1,
      type: 'openNote',
      noteId: GARDEN,
      heading: 'Beds',
    });
  });

  it('scrolls to the heading the app names and marks it for a moment', () => {
    vi.useFakeTimers();
    const { host, body } = page();
    openNote(
      host,
      noteOf(NOTE, 'Weekly review', [
        { heading: 'Wins' },
        { text: 'Shipped.' },
        { heading: 'Next week' },
      ]),
    );
    const scrolled: Element[] = [];
    const scroll = vi.spyOn(HTMLElement.prototype, 'scrollIntoView').mockImplementation(function (
      this: HTMLElement,
    ) {
      scrolled.push(this);
    });
    host.handle({ v: 1, type: 'showHeading', noteId: NOTE, heading: ' next WEEK ' });
    const target = [...body.querySelectorAll('h2')].find((h) => h.textContent === 'Next week')!;
    expect(scrolled).toEqual([target]);
    expect(target.classList.contains('pm-heading-target')).toBe(true);
    vi.advanceTimersByTime(HEADING_MARK_MS);
    expect(target.classList.contains('pm-heading-target')).toBe(false);
    // A heading the note no longer has leaves it where it is.
    host.handle({ v: 1, type: 'showHeading', noteId: NOTE, heading: 'Gone' });
    expect(scrolled).toHaveLength(1);
    scroll.mockRestore();
  });
});

describe('the Info sheet’s details (T40 P7, NT23, A473, A475)', () => {
  it('reports frontmatter as the web’s Info panel shows it, and the notes linked to', () => {
    const { host, sent } = page();
    const note = noteOf(NOTE, 'Weekly review', [
      { embed: GARDEN, target: 'Garden', section: 'Beds' },
    ]);
    openNote(host, note);
    const [info] = of(sent, 'noteInfo');
    expect(info).toEqual({
      v: 1,
      type: 'noteInfo',
      noteId: NOTE,
      created: '2026-10-23T10:00:00-05:00',
      kind: 'note',
      period: null,
      fields: [
        { key: 'id', value: NOTE },
        { key: 'title', value: 'Weekly review' },
        { key: 'created', value: '2026-10-23T10:00:00-05:00' },
      ],
      links: [GARDEN],
    });
  });

  it('follows edits at most every 300 ms, never per keystroke', () => {
    vi.useFakeTimers();
    const { host, sent } = page();
    openNote(host, noteOf(NOTE, 'Weekly review', []));
    const { editor } = host.editor!;
    expect(of(sent, 'noteInfo')).toHaveLength(1);
    // Typing a link, then a run of keystrokes inside 300 ms.
    editor.commands.insertContent({
      type: 'wikilink',
      attrs: { target: 'Beds', noteId: BEDS },
    });
    for (const letter of 'and more') editor.commands.insertContent(letter);
    expect(of(sent, 'noteInfo')).toHaveLength(1);
    vi.advanceTimersByTime(INFO_EVERY_MS);
    expect(of(sent, 'noteInfo')).toHaveLength(2);
    expect(of(sent, 'noteInfo').at(-1)!.links).toEqual([BEDS]);
    // Typing that changes none of the details sends nothing more.
    editor.commands.insertContent(' still');
    vi.advanceTimersByTime(INFO_EVERY_MS);
    expect(of(sent, 'noteInfo')).toHaveLength(2);
  });

  it('names a periodic note’s kind and period, and lists tags as the web does', () => {
    vi.useFakeTimers();
    const { host, sent } = page();
    const note = createYjs14Replica();
    initNote(
      note.doc,
      { id: NOTE, created: '2026-10-23T00:00:00-05:00', kind: 'daily', period: '2026-10-23' },
      '2026-10-23',
    );
    openNote(host, note);
    host.handle({ v: 1, type: 'setTag', noteId: NOTE, tag: 'garden', on: true });
    host.handle({ v: 1, type: 'setTag', noteId: NOTE, tag: 'plans/2026', on: true });
    vi.advanceTimersByTime(INFO_EVERY_MS);
    const info = of(sent, 'noteInfo').at(-1)!;
    expect(info).toMatchObject({ kind: 'daily', period: '2026-10-23' });
    expect(info.fields).toContainEqual({ key: 'tags', value: '[garden, plans/2026]' });
    expect(info.fields.at(-1)).toEqual({ key: 'type', value: 'daily' });
  });
});
