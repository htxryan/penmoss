/**
 * History on a long history in a big notebook (Ryan's review of #192, finding 10): one note with
 * 120 versions, by a Mac and an agent, among 2,000 other notes (4,000+ files), read through system
 * git on a fresh partial clone, as the Mac reads it. The panel's list (the newest 100, from the log
 * alone) in under 300 ms; every summary, the note's old blobs fetched first, in under 2 s; opened
 * again, under 300 ms. A wall-clock budget (A1244): `task budgets` runs it, never `task check`;
 * history-reads.test.ts covers what it reads.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { Layout, NotebookHistory } from '../src';
import { longHistory, type LongHistory } from './support/long-history';

let fixture: LongHistory | null = null;
afterAll(() => fixture?.box.cleanup());

describe('History of a note with 120 versions in a notebook of 2,000 notes', () => {
  it('lists at once, summarises quickly, and reads nothing twice', async () => {
    fixture = await longHistory({ notes: 2000, edits: 120 });
    const reader = await fixture.reader();
    const history = new NotebookHistory(reader, new Layout(''));

    let started = performance.now();
    const listed = await history.versions(fixture.noteId, { limit: 100 });
    const list = performance.now() - started;
    expect(listed.versions).toHaveLength(100);

    started = performance.now();
    const summaries = await history.summaries(fixture.noteId, listed.versions);
    const summarise = performance.now() - started;
    expect(summaries.size).toBe(100);
    expect([...summaries.values()].every((summary) => summary === '+1 −0 line')).toBe(true);

    started = performance.now();
    await history.history(fixture.noteId, { limit: 100 });
    const again = performance.now() - started;

    console.log(
      `History: list ${Math.round(list)} ms, summaries ${Math.round(summarise)} ms, again ${Math.round(again)} ms`,
    );
    expect(list).toBeLessThan(300);
    expect(summarise).toBeLessThan(2000);
    expect(again).toBeLessThan(300);
  }, 600_000);
});
