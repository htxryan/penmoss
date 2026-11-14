/**
 * The Time Machine on a big notebook (PEN-21): 2,000 commits by a Mac over 300 notes.
 * Opening (the log and the tree at the newest commit) in under 1 s, scrubbing to another commit
 * in under 300 ms, and a week's changes in under 1 s, on the worker. A wall-clock budget
 * (A1244): `task budgets` runs it, never `task check`; timeline.test.ts covers what it reads.
 */
import { describe, expect, it } from 'vitest';
import { Layout, liveTree, NotebookTimeline } from '../src';
import { testNotebook } from './support/notebooks';

const NOTES = 300;
const COMMITS = 2000;
const HOUR = 60 * 60 * 1000;

describe('the Time Machine on 2,000 commits (PEN-21)', () => {
  it('opens, scrubs and lists a week quickly', async () => {
    const nb = testNotebook();
    const mac = await nb.open('Mac', { create: true });
    const folder = mac.ops.createFolder({ name: 'Projects', parentId: null });
    const notes: string[] = [];
    for (let i = 0; i < NOTES; i++) {
      notes.push(
        mac.ops.createNote({ title: `Note ${i}`, markdown: `line ${i}`, folderId: folder }),
      );
    }
    await mac.engine.sync();
    for (let commit = 0; commit < COMMITS; commit++) {
      nb.tick(HOUR);
      const doc = mac.engine.replica.note(notes[commit % NOTES]!)!;
      doc.get('meta').setAttr('touched', commit);
      await mac.engine.sync();
    }

    const timeline = new NotebookTimeline(mac.transport, new Layout(''));
    let started = performance.now();
    const commits = await timeline.commits();
    const tree = liveTree(await timeline.tree(commits.at(-1)!.id));
    const open = performance.now() - started;
    expect(commits.length).toBeGreaterThan(COMMITS);
    expect(tree.folders[0]!.notes).toHaveLength(NOTES);
    expect(open).toBeLessThan(1000);

    started = performance.now();
    await timeline.tree(commits[Math.floor(commits.length / 2)]!.id);
    expect(performance.now() - started).toBeLessThan(300);

    const end = commits.at(-1)!.at;
    started = performance.now();
    const week = await timeline.changes(end - 7 * 24 * HOUR, end + 1);
    expect(week.commits).toBeGreaterThan(100);
    expect(performance.now() - started).toBeLessThan(1000);
  }, 120_000);
});
