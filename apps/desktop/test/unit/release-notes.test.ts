import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  NOTES_EVERY_MS,
  NOTES_FILE,
  parseNotes,
  ReleaseNotes,
  type ReleaseNotesFile,
} from '../../src/release-notes';
import { FEED_URLS, type UpdateMode } from '../../src/updater';

// Release notes for Settings → Updates (PEN-108): main fetches `release-notes.json` from beside
// the channel's update feed, at most once an hour, and keeps it in userData; a bad file keeps the
// cache, and a development build never fetches.

const FILE = {
  schema: 1,
  generated: '2026-11-20T00:00:00Z',
  head: 'abc',
  prs: [{ pr: 141, build: 1174 }],
  notes: [{ build: 1174, pr: 141, kind: 'new', platform: null, text: 'Release notes in the app.' }],
  releases: [{ version: '0.2.0', tag: 'v0.2.0', build: 1170, date: '2026-11-08' }],
};

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'penmoss-notes-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function setup(
  options: { mode?: UpdateMode; answers?: Array<{ status: number; body: string } | Error> } = {},
) {
  const urls: string[] = [];
  const changes: ReleaseNotesFile[] = [];
  const logs: string[] = [];
  const answers = [...(options.answers ?? [{ status: 200, body: JSON.stringify(FILE) }])];
  let clock = 1_000_000;
  const notes = new ReleaseNotes({
    dir,
    mode: () => options.mode ?? 'enabled',
    fetch: (url) => {
      urls.push(url);
      const answer = answers.shift() ?? { status: 200, body: JSON.stringify(FILE) };
      if (answer instanceof Error) return Promise.reject(answer);
      return Promise.resolve({
        ok: answer.status === 200,
        status: answer.status,
        text: () => Promise.resolve(answer.body),
      });
    },
    log: (message) => logs.push(message),
    onChange: (file) => changes.push(file),
    now: () => clock,
  });
  return {
    notes,
    urls,
    changes,
    logs,
    tick: (ms: number) => {
      clock += ms;
    },
  };
}

describe('parseNotes', () => {
  it('reads a schema 1 file, dropping what the page does not use', () => {
    expect(parseNotes(JSON.stringify(FILE))).toEqual({
      schema: 1,
      generated: FILE.generated,
      notes: FILE.notes,
      releases: FILE.releases,
    });
  });

  it('keeps only the number of a newer schema', () => {
    expect(parseNotes(JSON.stringify({ schema: 2, whatever: true }))).toEqual({
      schema: 2,
      generated: '',
      notes: [],
      releases: [],
    });
  });

  it('refuses what is not a notes file', () => {
    for (const text of [
      'not json',
      'null',
      '{}',
      JSON.stringify({ ...FILE, schema: 0 }),
      JSON.stringify({ ...FILE, notes: 'x' }),
      JSON.stringify({ ...FILE, notes: [{ ...FILE.notes[0], kind: 'changed' }] }),
      JSON.stringify({ ...FILE, notes: [{ ...FILE.notes[0], platform: 'windows' }] }),
      JSON.stringify({ ...FILE, releases: [{ version: '0.2.0' }] }),
    ]) {
      expect(parseNotes(text), text).toBeNull();
    }
  });
});

describe('ReleaseNotes', () => {
  it("fetches the channel's file from beside its feed and keeps it in userData", async () => {
    const { notes, urls, changes } = setup();
    expect(await notes.current()).toBeNull();
    await notes.refresh('alpha');
    expect(urls).toEqual([`${FEED_URLS.alpha}/${NOTES_FILE}`]);
    expect(changes).toHaveLength(1);
    expect((await notes.current())?.notes).toEqual(FILE.notes);
    expect(JSON.parse(await readFile(join(dir, NOTES_FILE), 'utf8'))).toEqual(FILE);
  });

  it('fetches at most once an hour per channel', async () => {
    const { notes, urls, tick } = setup();
    await notes.refresh('stable');
    await notes.refresh('stable');
    expect(urls).toHaveLength(1);
    // Another channel is another file: fetched at once.
    await notes.refresh('alpha');
    expect(urls).toHaveLength(2);
    tick(NOTES_EVERY_MS);
    await notes.refresh('stable');
    expect(urls).toEqual([
      `${FEED_URLS.stable}/${NOTES_FILE}`,
      `${FEED_URLS.alpha}/${NOTES_FILE}`,
      `${FEED_URLS.stable}/${NOTES_FILE}`,
    ]);
  });

  it('keeps the cache when the answer is bad, missing or fails', async () => {
    await writeFile(join(dir, NOTES_FILE), JSON.stringify(FILE));
    const { notes, changes, logs, tick } = setup({
      answers: [
        { status: 200, body: '{"schema":1}' },
        { status: 404, body: '' },
        new Error('offline'),
      ],
    });
    for (let i = 0; i < 3; i++) {
      await notes.refresh('stable');
      tick(NOTES_EVERY_MS);
    }
    expect(changes).toEqual([]);
    expect((await notes.current())?.notes).toEqual(FILE.notes);
    expect(JSON.parse(await readFile(join(dir, NOTES_FILE), 'utf8'))).toEqual(FILE);
    expect(logs).toEqual([
      "release notes: stable's file doesn't read; keeping the cache",
      'release notes: stable answered 404',
      'release notes: stable failed: offline',
    ]);
  });

  it('says nothing when the file has not changed', async () => {
    await writeFile(join(dir, NOTES_FILE), JSON.stringify(FILE));
    const { notes, changes } = setup();
    await notes.refresh('stable');
    expect(changes).toEqual([]);
  });

  it('never fetches in development, and reads the cache there', async () => {
    await writeFile(join(dir, NOTES_FILE), JSON.stringify(FILE));
    const { notes, urls } = setup({ mode: 'development' });
    await notes.refresh('stable');
    expect(urls).toEqual([]);
    expect((await notes.current())?.releases).toEqual(FILE.releases);
  });
});
