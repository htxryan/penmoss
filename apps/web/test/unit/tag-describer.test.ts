/**
 * A tag's AI description on the Mac (A1677): Generate AI Description sends the tag prompt with
 * the notes carrying the tag (their descriptions, read from the notes, or the start of their
 * text) and the other tags on them, through the provider Settings chose, and writes the answer
 * into the notebook's tag descriptions; nothing goes without a provider; Generate All describes
 * the tags with none (or every tag), two at a time; and its dialog says what it covers.
 */
import { setHandDescription } from '@penmoss/model/description';
import { initNote } from '@penmoss/model/note';
import { readTagDescriptions, readWorkspace, setTagDescription } from '@penmoss/model/workspace';
import * as Y from '@y/y';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  Describer,
  NO_PROVIDER,
  type AiBridge,
  type TagDescriberSource,
} from '../../src/notes/describer';
import { generateAllWords, generateGroups } from '../../src/tags/generate';

interface Listed {
  id: string;
  title: string;
  excerpt: string;
  updatedAt: number;
  tags: string[];
}

function fakeSource(id: string, list: Listed[]) {
  const docs = new Map<string, Y.Doc>();
  for (const note of list) {
    const doc = new Y.Doc();
    initNote(doc, { id: note.id, created: '2026-11-20T09:00:00Z', kind: 'note' }, note.title);
    docs.set(note.id, doc);
  }
  const workspaceDoc = new Y.Doc();
  let flushed = 0;
  let opened = 0;
  const source: TagDescriberSource = {
    id,
    name: id === 'nb' ? 'Personal' : 'Work',
    notes: {
      list: () => list,
      openCopies: () => [],
      openNote: (noteId) => {
        opened += 1;
        return {
          ready: Promise.resolve(),
          isLoaded: true,
          isClosed: false,
          replica: { doc: docs.get(noteId)! },
          close: () => undefined,
        };
      },
      editNote: () => Promise.resolve(),
      onStored: () => () => undefined,
      onPulled: () => () => undefined,
      subscribeSync: () => () => undefined,
      syncState: () => ({ phase: 'synced' }),
    },
    workspace: {
      settings: () => ({}),
      getState: () => ({ snapshot: readWorkspace(workspaceDoc) }),
      setTagDescription: (tag, text) => setTagDescription(workspaceDoc, tag, text),
      flush: () => {
        flushed += 1;
        return Promise.resolve();
      },
    },
  };
  return {
    source,
    docs,
    workspaceDoc,
    flushed: () => flushed,
    opened: () => opened,
  };
}

const NOTES: Listed[] = [
  {
    id: 'a',
    title: 'Beds',
    excerpt: 'Raised beds for tomatoes',
    updatedAt: 1,
    tags: ['garden', 'summer'],
  },
  {
    id: 'b',
    title: 'Seeds',
    excerpt: 'Order seeds',
    updatedAt: 3,
    tags: ['garden/seeds', 'shopping'],
  },
  { id: 'c', title: 'Phone', excerpt: 'The build', updatedAt: 2, tags: ['android'] },
];

let settings: Record<string, unknown>;
let calls: string[];
let answer: Awaited<ReturnType<AiBridge['describe']>>;
const bridge: AiBridge = {
  describe: (provider, model, prompt) => {
    calls.push(`${provider}|${model}|${prompt}`);
    return Promise.resolve(answer);
  },
};

beforeEach(() => {
  settings = { 'ai.provider': 'anthropic' };
  calls = [];
  answer = { ok: true, text: ' "What grows, and when." ' };
});

const describerOf = (sources: TagDescriberSource[], withBridge: AiBridge | null = bridge) =>
  new Describer({
    sources: () => sources,
    subscribeSources: () => () => undefined,
    settings: () => settings,
    bridge: withBridge,
    locks: null,
    today: () => '2026-11-24',
  });

describe('Generate AI Description for a tag', () => {
  it('sends the tag prompt with its notes and the other tags, and writes the answer', async () => {
    const fake = fakeSource('nb', NOTES);
    setHandDescription(fake.docs.get('b')!, 'What to sow in spring.');
    const describer = describerOf([fake.source]);
    const done = await describer.describeTag(fake.source, 'garden');
    expect(done).toEqual({ ok: true, text: 'What grows, and when.', before: '' });
    expect(readTagDescriptions(fake.workspaceDoc)).toEqual({ garden: 'What grows, and when.' });
    expect(fake.flushed()).toBe(1);
    expect(calls).toHaveLength(1);
    const [provider, model, prompt] = calls[0]!.split('|');
    expect([provider, model]).toEqual(['anthropic', 'claude-haiku-5-5']);
    expect(prompt).toContain('Tag: #garden\n');
    expect(prompt).toContain('Notebook: Personal\n');
    expect(prompt).toContain('Notes with it: 2\n');
    expect(prompt).toContain(
      'Other tags on these notes: #garden/seeds (1), #shopping (1), #summer (1)',
    );
    // Newest first; a note's description over the start of its text.
    expect(prompt).toContain('- Seeds: What to sow in spring.\n- Beds: Raised beds for tomatoes');
    expect(prompt).not.toContain('Phone');
    // Only the notes carrying it are opened.
    expect(fake.opened()).toBe(2);
  });

  it('uses the tag prompt from Settings, and says what it replaced', async () => {
    const fake = fakeSource('nb', NOTES);
    setTagDescription(fake.workspaceDoc, 'summer', 'Hot months.');
    settings = {
      'ai.provider': 'claude-code',
      'ai.description.tagPrompt':
        '#{{tag}} was “{{description}}” on {{date}} ({{count}}): {{notes}}',
    };
    const done = await describerOf([fake.source]).describeTag(fake.source, 'summer');
    expect(done).toMatchObject({ ok: true, before: 'Hot months.' });
    expect(calls).toEqual([
      'claude-code|haiku|#summer was “Hot months.” on 2026-11-24 (1): - Beds: Raised beds for tomatoes',
    ]);
  });

  it('sends nothing without a provider, and writes nothing when the provider fails', async () => {
    const fake = fakeSource('nb', NOTES);
    settings = {};
    expect(await describerOf([fake.source]).describeTag(fake.source, 'garden')).toEqual(
      NO_PROVIDER,
    );
    settings = { 'ai.provider': 'anthropic' };
    expect(await describerOf([fake.source], null).describeTag(fake.source, 'garden')).toEqual(
      NO_PROVIDER,
    );
    expect(calls).toEqual([]);
    answer = { ok: false, code: 'refused', message: 'Anthropic refused the API key.' };
    expect(await describerOf([fake.source]).describeTag(fake.source, 'garden')).toEqual(answer);
    answer = { ok: true, text: '   ' };
    expect(await describerOf([fake.source]).describeTag(fake.source, 'garden')).toMatchObject({
      ok: false,
      message: 'The AI provider answered with no description.',
    });
    expect(readTagDescriptions(fake.workspaceDoc)).toEqual({});
  });

  it('says which tags are being generated while it runs', async () => {
    const fake = fakeSource('nb', NOTES);
    let release: () => void = () => undefined;
    const slow: AiBridge = {
      describe: () =>
        new Promise((resolve) => {
          release = () => resolve({ ok: true, text: 'Done.' });
        }),
    };
    const describer = describerOf([fake.source], slow);
    let heard = 0;
    describer.subscribe(() => (heard += 1));
    const running = describer.describeTag(fake.source, 'garden');
    expect(describer.tagBusy('nb', 'garden')).toBe(true);
    expect(describer.tagsBusyIn('nb')).toEqual(['garden']);
    // Asked again meanwhile: the same run.
    expect(describer.describeTag(fake.source, 'garden')).toBe(running);
    await new Promise((resolve) => setTimeout(resolve, 0));
    release();
    await running;
    expect(describer.tagBusy('nb', 'garden')).toBe(false);
    expect(heard).toBeGreaterThanOrEqual(2);
  });
});

describe('Generate All', () => {
  it('covers the tags with no description, or every tag, in every notebook', () => {
    const one = fakeSource('nb', NOTES);
    const two = fakeSource('work', [
      { id: 'w', title: 'Plan', excerpt: '', updatedAt: 1, tags: ['work'] },
    ]);
    setTagDescription(one.workspaceDoc, 'garden', 'What grows.');
    setTagDescription(two.workspaceDoc, 'work', 'The job.');
    expect(
      generateGroups([one.source, two.source], false).map((group) => [group.source.id, group.tags]),
    ).toEqual([['nb', ['android', 'garden/seeds', 'shopping', 'summer']]]);
    expect(
      generateGroups([one.source, two.source], true).map((group) => group.tags.length),
    ).toEqual([5, 1]);
  });

  it('describes them two at a time, saying each one done and the last failure', async () => {
    const one = fakeSource('nb', NOTES);
    const two = fakeSource('work', [
      { id: 'w', title: 'Plan', excerpt: '', updatedAt: 1, tags: ['work'] },
    ]);
    const describer = describerOf([one.source, two.source]);
    const progress: number[] = [];
    const out = await describer.describeTags(generateGroups([one.source, two.source], false), {
      onProgress: (done) => progress.push(done),
    });
    expect(out).toEqual({ written: 6, failed: 0, message: null });
    expect(progress).toEqual([1, 2, 3, 4, 5, 6]);
    expect(Object.keys(readTagDescriptions(one.workspaceDoc)).sort()).toEqual([
      'android',
      'garden',
      'garden/seeds',
      'shopping',
      'summer',
    ]);
    expect(readTagDescriptions(two.workspaceDoc)).toEqual({ work: 'What grows, and when.' });
    // Each note's description is read once for the whole run.
    expect(one.opened()).toBe(3);

    answer = { ok: false, code: 'offline', message: 'No connection.' };
    const stop = new AbortController();
    stop.abort();
    expect(
      await describer.describeTags(generateGroups([one.source], true), { signal: stop.signal }),
    ).toEqual({
      written: 0,
      failed: 0,
      message: null,
    });
    expect(await describer.describeTags([{ source: two.source, tags: ['work'] }])).toEqual({
      written: 0,
      failed: 1,
      message: 'No connection.',
    });
  });

  it('says how many tags go and that each is sent to the AI provider', () => {
    expect(generateAllWords(0, false)).toBe('Every tag has a description already.');
    expect(generateAllWords(0, true)).toBe('There are no tags to describe.');
    expect(generateAllWords(1, false)).toBe(
      '1 tag has no description. Each goes to your AI provider with its notes’ titles and descriptions, two at a time.',
    );
    expect(generateAllWords(3, true)).toBe(
      '3 tags will be described, replacing any description they have. Each goes to your AI provider with its notes’ titles and descriptions, two at a time.',
    );
  });
});
