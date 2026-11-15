/**
 * The Time Machine (PEN-21): a notebook built with known commits on known days, by a Mac
 * and an agent; the tree and a note's text at a past date, and what changed in a week, with who
 * changed it. Over the real engine and the in-memory transport.
 */
import { NOTE_ROOT } from '@penmoss/sync-client/replica';
import { setTitle } from '@penmoss/sync-client/note';
import * as Y from '@y/y';
import { describe, expect, it } from 'vitest';
import { commitAt, Layout, liveTree, NotebookTimeline } from '../src';
import { testNotebook, type TestClone } from './support/notebooks';

const DAY = 24 * 60 * 60 * 1000;
/** The notebook's clock starts on Thursday 29 October 2026, 14:00 UTC. */
const START = Date.UTC(2026, 9, 29, 14, 0, 0);

function append(clone: TestClone, noteId: string, text: string): void {
  const doc = clone.engine.replica.note(noteId)!;
  doc.transact(() => {
    const p = new Y.Node('paragraph');
    doc.get(NOTE_ROOT).insert(doc.get(NOTE_ROOT).length, [p]);
    p.insert(0, text);
  });
}

/**
 * Thu 29 Oct: the Mac makes Projects, Plan in it and Old. Mon 2 Nov: an agent adds a line to
 * Plan and makes Ideas. Wed 4 Nov: the Mac renames Ideas, moves Plan to the top level and puts
 * Old in Trash.
 */
async function story() {
  const nb = testNotebook();
  const mac = await nb.open('Mac', { create: true });
  const projects = mac.ops.createFolder({ name: 'Projects', parentId: null });
  const plan = mac.ops.createNote({ title: 'Plan', markdown: 'first line', folderId: projects });
  const old = mac.ops.createNote({ title: 'Old', markdown: 'stale' });
  await mac.engine.sync();

  nb.tick(4 * DAY);
  const agent = await nb.open('Claude Code', { kind: 'agent' });
  await agent.engine.sync();
  append(agent, plan, 'agent line');
  const ideas = agent.ops.createNote({ title: 'Ideas', markdown: 'an idea' });
  await agent.engine.sync();

  nb.tick(2 * DAY);
  await mac.engine.sync();
  setTitle(mac.engine.replica.note(ideas)!, 'Better ideas');
  mac.ops.move(plan, null);
  mac.ops.trash(old);
  await mac.engine.sync();

  const timeline = new NotebookTimeline(mac.transport, new Layout(''));
  return { nb, mac, agent, timeline, projects, plan, old, ideas };
}

describe('the Time Machine (PEN-21)', () => {
  it('lists the notebook’s commits oldest first, each with its writer', async () => {
    const { timeline } = await story();
    const commits = await timeline.commits();
    expect(commits.length).toBeGreaterThanOrEqual(3);
    expect(commits.map((commit) => commit.at)).toEqual(
      [...commits.map((commit) => commit.at)].sort((a, b) => a - b),
    );
    expect(commits[0]!.author).toMatchObject({ kind: 'device', label: 'Mac' });
    expect(commits.some((commit) => commit.author.label === 'Claude Code')).toBe(true);
    expect(commits.at(-1)!.author.label).toBe('Mac');
  });

  it('shows the tree and a note’s text as they were on a past day', async () => {
    const { timeline, plan, old, ideas } = await story();
    const commits = await timeline.commits();
    // Saturday 31 October: the first day's notebook.
    const then = commitAt(commits, START + 2 * DAY)!;
    const tree = liveTree(await timeline.tree(then.id));
    expect(tree.folders.map((folder) => folder.name)).toEqual(['Projects']);
    expect(tree.folders[0]!.notes.map((note) => note.title)).toEqual(['Plan']);
    expect(tree.notes.map((note) => note.title)).toEqual(['Old']);
    const text = await timeline.note(plan, then.id);
    expect(text?.markdown).toContain('first line');
    expect(text?.markdown).not.toContain('agent line');
    expect(await timeline.note(ideas, then.id)).toBeNull();

    // Now: Plan at the top level with the agent's line, Ideas renamed, Old in Trash.
    const now = liveTree(await timeline.tree(commits.at(-1)!.id));
    expect(now.folders[0]!.notes).toEqual([]);
    expect(now.notes.map((note) => note.title).sort()).toEqual(['Better ideas', 'Plan']);
    expect((await timeline.note(plan, commits.at(-1)!.id))?.markdown).toContain('agent line');
    expect((await timeline.note(old, commits.at(-1)!.id))?.deleted).toBe(true);
    // Before the first commit, there was nothing.
    expect(commitAt(commits, START - DAY)).toBeNull();
    expect((await timeline.tree(null)).notes).toEqual([]);
  });

  it('lists what changed in a week, with who changed it and a diff', async () => {
    const { timeline, plan, old, ideas } = await story();
    // Monday 2 November to Sunday 8 November.
    const monday = Date.UTC(2026, 10, 2);
    const week = await timeline.changes(monday, monday + 7 * DAY);
    expect(week.commits).toBeGreaterThanOrEqual(2);
    const byId = new Map(week.notes.map((note) => [note.noteId, note]));

    const madeIdeas = byId.get(ideas)!;
    expect(madeIdeas.kinds).toEqual(['created', 'edited']);
    expect(madeIdeas.title).toBe('Better ideas');
    expect(madeIdeas.authors.map((author) => author.label)).toEqual(['Claude Code', 'Mac']);

    const movedPlan = byId.get(plan)!;
    expect(movedPlan.kinds).toEqual(['moved', 'edited']);
    expect(movedPlan.previousFolder).toBe('Projects');
    expect(movedPlan.folder).toBe('');
    expect(movedPlan.authors.map((author) => author.label)).toEqual(['Claude Code', 'Mac']);
    expect(movedPlan.authors.find((author) => author.label === 'Claude Code')?.kind).toBe('agent');

    const trashed = byId.get(old)!;
    expect(trashed.kinds).toEqual(['deleted']);
    expect(trashed.live).toBe(false);
    expect(trashed.authors.map((author) => author.label)).toEqual(['Mac']);

    const diff = await timeline.diff(plan, week.from, week.to);
    const added = diff.diff.filter((op) => op.op === 'add').map((op) => op.line);
    expect(added.filter(Boolean)).toEqual(['agent line']);
    expect(diff.diff.some((op) => op.op === 'del')).toBe(false);

    // The week before: everything was made then, by the Mac.
    const before = await timeline.changes(monday - 7 * DAY, monday);
    expect(before.notes.map((note) => [note.title, note.kinds])).toEqual([
      ['Old', ['created', 'edited']],
      ['Plan', ['created', 'edited']],
    ]);
    // A week with no commits.
    expect((await timeline.changes(monday + 7 * DAY, monday + 14 * DAY)).notes).toEqual([]);
  });

  it('a rename alone is not an edit, and a restore from Trash says so', async () => {
    const { nb, mac, timeline, old, ideas } = await story();
    nb.tick(7 * DAY);
    mac.ops.restore(old);
    await mac.engine.sync();
    const commits = await timeline.commits(true);
    const last = commits.at(-1)!;
    const week = await timeline.changes(last.at - DAY, last.at + DAY);
    expect(week.notes.map((note) => [note.noteId, note.kinds])).toEqual([[old, ['restored']]]);
    // Wednesday's commit alone: Ideas was renamed, not edited.
    const wednesday = commits.find((commit) => commit.at === START + 6 * DAY)!;
    const day = await timeline.changes(wednesday.at, wednesday.at + 1);
    expect(day.notes.find((note) => note.noteId === ideas)?.kinds).toEqual(['renamed']);
    expect(day.notes.find((note) => note.noteId === ideas)?.previousTitle).toBe('Ideas');
  });
});
