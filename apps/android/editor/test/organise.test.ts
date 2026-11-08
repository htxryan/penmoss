/**
 * The editor page's T38 side: New note made on the phone (`create`), and the
 * open note's frontmatter tags read and set as the web's tag chips do
 * (`tags`, `setTag`). Tags live in the note's document, so only the page
 * touches them; the app stores the edit as it stores typing.
 */
import { schema as coreSchema } from '@penmoss/core';
import { markSpecs, nodeSpecs } from '@penmoss/core/schema';
import { setBody } from '@penmoss/sync-client/history';
import { initNote, NOTE_META, readTitle } from '@penmoss/sync-client/note';
import { frontmatterTags, setFrontmatterTag } from '@penmoss/sync-client/tags';
import { createYjs14Replica, type Yjs14Replica } from '@penmoss/sync-client/yjs14';
import { pmnodeToDelta } from '@y/prosemirror';
import * as Y from '@y/y';
import { fromBase64, toBase64 } from 'lib0/buffer';
import { afterEach, describe, expect, it } from 'vitest';
import { EditorHost, INVALID_TAG } from '../src/host';
import type { FromEditor } from '../src/protocol';

const NOTE = '01JD2Z7Q8R4T6Y8W0E2R4T6YB1';
const NEW = '01JD2Z7Q8R4T6Y8W0E2R4T6YB4';
const NOW = new Date('2026-10-23T15:00:00Z');

const hosts: EditorHost[] = [];
afterEach(() => {
  for (const host of hosts.splice(0)) host.close();
  document.body.replaceChildren();
});

function page() {
  const root = document.createElement('main');
  root.hidden = true;
  const title = document.createElement('input');
  const body = document.createElement('div');
  const unsupported = document.createElement('pre');
  root.append(title, body, unsupported);
  document.body.append(root);
  const sent: FromEditor[] = [];
  const host = new EditorHost({ root, title, body, unsupported }, (message) => sent.push(message), {
    now: () => NOW,
  });
  hosts.push(host);
  return { host, sent, title };
}

/** A note on "the server", with frontmatter tags. */
function serverNote(tags: string[] = []): Yjs14Replica {
  const replica = createYjs14Replica();
  initNote(replica.doc, { id: NOTE, created: '2026-10-23T10:00:00-05:00', kind: 'note' }, 'Soup');
  for (const tag of tags) setFrontmatterTag(replica.doc, tag, true);
  return replica;
}

function opened(tags: string[] = [], editable = true) {
  const parts = page();
  const server = serverNote(tags);
  parts.host.handle({
    v: 1,
    type: 'open',
    noteId: NOTE,
    synced: [{ id: '1', update: toBase64(server.encodeStateAsUpdate()) }],
    pending: [],
    editable,
  });
  return { ...parts, server };
}

const ofType = <T extends FromEditor['type']>(sent: FromEditor[], type: T) =>
  sent.filter((message): message is Extract<FromEditor, { type: T }> => message.type === type);

/** The edits the page sent, applied to the server's copy, as the app's upload would be. */
function upload(sent: FromEditor[], server: Yjs14Replica): void {
  for (const message of ofType(sent, 'update'))
    Y.applyUpdate(server.doc, fromBase64(message.update));
}

describe('New note on the phone (T38)', () => {
  it('makes an empty note with the id the app gave, as the web makes one', () => {
    const { host, sent } = page();
    host.handle({ v: 1, type: 'create', noteId: NEW });
    const [created] = ofType(sent, 'created');
    expect(created).toMatchObject({ noteId: NEW, note: { id: NEW, title: '' } });
    const doc = new Y.Doc();
    Y.applyUpdate(doc, fromBase64(created!.note.update));
    const meta = doc.get(NOTE_META);
    expect(meta.getAttr('id')).toBe(NEW);
    expect(meta.getAttr('kind')).toBe('note');
    expect(String(meta.getAttr('created'))).toMatch(/^2026-10-2\dT\d\d:\d\d:\d\d[+-]\d\d:\d\d$/);
    expect(readTitle(doc)).toBe('');
    // No notebook said (an older app): none recorded.
    expect(meta.getAttr('notebook')).toBeUndefined();
  });

  it('records the notebook of the folder it is made in, with its identity (T43, A766)', () => {
    const { host, sent } = page();
    host.handle({ v: 1, type: 'create', noteId: NEW, notebook: '01JD2Z7Q8R4T6Y8W0E2R4T6YW1' });
    const [created] = ofType(sent, 'created');
    const doc = new Y.Doc();
    Y.applyUpdate(doc, fromBase64(created!.note.update));
    expect(doc.get(NOTE_META).getAttr('notebook')).toBe('01JD2Z7Q8R4T6Y8W0E2R4T6YW1');
    expect(doc.get(NOTE_META).getAttr('id')).toBe(NEW);
    // The default notebook's top level and folders say so too.
    host.handle({
      v: 1,
      type: 'create',
      noteId: '01JD2Z7Q8R4T6Y8W0E2R4T6YB6',
      notebook: 'default',
    });
    const [, again] = ofType(sent, 'created');
    const other = new Y.Doc();
    Y.applyUpdate(other, fromBase64(again!.note.update));
    expect(other.get(NOTE_META).getAttr('notebook')).toBe('default');
  });

  it('puts the caret in the title of the note it made once the app opens it', () => {
    const { host, sent, title } = page();
    host.handle({ v: 1, type: 'create', noteId: NEW });
    const [created] = ofType(sent, 'created');
    host.handle({
      v: 1,
      type: 'open',
      noteId: NEW,
      synced: [],
      pending: [{ id: '7', update: created!.note.update }],
      editable: true,
    });
    expect(ofType(sent, 'opened')).toHaveLength(1);
    expect(document.activeElement).toBe(title);
  });
});

describe('tags on the phone (T38)', () => {
  it('says the note’s frontmatter tags when it opens, sorted', () => {
    const { sent } = opened(['soup', 'area/cooking']);
    expect(ofType(sent, 'tags')).toEqual([
      { v: 1, type: 'tags', noteId: NOTE, tags: ['area/cooking', 'soup'] },
    ]);
  });

  it('adds a tag as the web does, normalised, as an edit the app stores and uploads', () => {
    const { host, sent, server } = opened(['soup']);
    host.handle({ v: 1, type: 'setTag', noteId: NOTE, tag: '#Area//Cooking', on: true });
    expect(ofType(sent, 'tags').at(-1)?.tags).toEqual(['area/cooking', 'soup']);
    host.flush();
    upload(sent, server);
    expect(frontmatterTags(server.doc)).toEqual(['area/cooking', 'soup']);
  });

  it('removes a tag, and another device’s tag added meanwhile stays', () => {
    const { host, sent, server } = opened(['soup', 'inbox']);
    // The Mac adds a tag while the phone removes one: both survive the merge (one attribute each).
    const before = server.encodeStateVector();
    setFrontmatterTag(server.doc, 'dinner', true);
    host.handle({ v: 1, type: 'setTag', noteId: NOTE, tag: 'inbox', on: false });
    host.flush();
    host.handle({
      v: 1,
      type: 'remote',
      noteId: NOTE,
      update: toBase64(Y.encodeStateAsUpdate(server.doc, before)),
    });
    upload(sent, server);
    expect(frontmatterTags(server.doc)).toEqual(['dinner', 'soup']);
    expect(ofType(sent, 'tags').at(-1)?.tags).toEqual(['dinner', 'soup']);
  });

  it('follows tags changed on another device', () => {
    const { host, sent, server } = opened(['soup']);
    const before = server.encodeStateVector();
    setFrontmatterTag(server.doc, 'soup', false);
    host.handle({
      v: 1,
      type: 'remote',
      noteId: NOTE,
      update: toBase64(Y.encodeStateAsUpdate(server.doc, before)),
    });
    expect(ofType(sent, 'tags').at(-1)?.tags).toEqual([]);
    // Taken from the app: never echoed back as an edit.
    host.flush();
    expect(ofType(sent, 'update')).toEqual([]);
  });

  it('says only when the tags changed', () => {
    const { host, sent } = opened(['soup']);
    host.handle({ v: 1, type: 'setTag', noteId: NOTE, tag: 'soup', on: true });
    host.editor!.editor.commands.insertContent('stock');
    expect(ofType(sent, 'tags')).toHaveLength(1);
  });

  it('refuses a name that is not a tag, saying why, and changes nothing', () => {
    const { host, sent } = opened();
    host.handle({ v: 1, type: 'setTag', noteId: NOTE, tag: 'two words', on: true });
    host.handle({ v: 1, type: 'setTag', noteId: NOTE, tag: '2026', on: true });
    expect(ofType(sent, 'notice').map((message) => message.message)).toEqual([
      INVALID_TAG,
      INVALID_TAG,
    ]);
    host.flush();
    expect(ofType(sent, 'update')).toEqual([]);
    expect(ofType(sent, 'tags')).toHaveLength(1);
  });

  it('leaves a note opened read-only alone', () => {
    const { host, sent } = opened(['soup'], false);
    host.handle({ v: 1, type: 'setTag', noteId: NOTE, tag: 'more', on: true });
    host.flush();
    expect(ofType(sent, 'update')).toEqual([]);
    expect(ofType(sent, 'notice')).toHaveLength(1);
    expect(ofType(sent, 'tags').at(-1)?.tags).toEqual(['soup']);
  });

  it('leaves a note that became read-only alone: content a later version wrote (A158)', () => {
    const { host, sent, server } = opened(['soup']);
    // A schema from a later version, with a block this one does not know.
    const Schema = coreSchema.constructor as new (spec: {
      nodes: Record<string, unknown>;
      marks: typeof markSpecs;
    }) => typeof coreSchema;
    const later = new Schema({
      nodes: { ...nodeSpecs, futureBlock: { group: 'block', content: 'text*' } },
      marks: markSpecs,
    });
    const before = server.encodeStateVector();
    setBody(
      server.doc,
      pmnodeToDelta(
        later.node('doc', null, [later.node('futureBlock', null, [later.text('from later')])]),
      ),
    );
    host.handle({
      v: 1,
      type: 'remote',
      noteId: NOTE,
      update: toBase64(Y.encodeStateAsUpdate(server.doc, before)),
    });
    expect(ofType(sent, 'unsupported')).toHaveLength(1);
    host.handle({ v: 1, type: 'setTag', noteId: NOTE, tag: 'more', on: true });
    host.flush();
    expect(ofType(sent, 'update')).toEqual([]);
    expect(ofType(sent, 'notice')).toHaveLength(1);
    expect(frontmatterTags(server.doc)).toEqual(['soup']);
    expect(ofType(sent, 'tags').at(-1)?.tags).toEqual(['soup']);
  });

  it('sets and removes a tag as long as the longest the app sends (A361)', () => {
    const { host, sent } = opened();
    const long = `a${'b'.repeat(998)}`;
    host.handle({ v: 1, type: 'setTag', noteId: NOTE, tag: long, on: true });
    expect(ofType(sent, 'tags').at(-1)?.tags).toEqual([long]);
    host.handle({ v: 1, type: 'setTag', noteId: NOTE, tag: long, on: false });
    expect(ofType(sent, 'tags').at(-1)?.tags).toEqual([]);
  });

  it('leaves a note that is not open alone', () => {
    const { host, sent } = opened(['soup']);
    host.handle({ v: 1, type: 'setTag', noteId: NEW, tag: 'more', on: true });
    host.flush();
    expect(ofType(sent, 'update')).toEqual([]);
  });
});
