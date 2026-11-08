/**
 * Agent activity on a big notebook (#174 merge check): an undo mark is checked against one
 * snapshot of the workspace per list or undo, never a decode per part. 2,000 notes and 10 agent
 * commits of 100 moves each, all 10 marked undone by a client that skips the engine's check (so
 * every mark is checked and none believed): the list in under 300 ms, the first one too, and each undo in under
 * 500 ms, on the worker.
 */
import { readNoteState } from '@penmoss/editor/markdown';
import { readWorkspace } from '@penmoss/sync-client/workspace';
import { describe, expect, it } from 'vitest';
import { AgentActivity } from '../src';
import { testNotebook } from './support/notebooks';

const NOTES = 2000;
const COMMITS = 10;
const MOVES = 100;

describe('Agent activity on 2,000 notes (#174 merge check)', () => {
  it('lists 10 marked commits of 100 moves in under 300 ms, and undoes each in under 500 ms', async () => {
    const nb = testNotebook();
    const mac = await nb.open('Mac', { create: true });
    const from = mac.ops.createFolder({ name: 'Inbox', parentId: null });
    const to = mac.ops.createFolder({ name: 'Filed', parentId: null });
    const notes: string[] = [];
    for (let i = 0; i < NOTES; i++) {
      notes.push(mac.ops.createNote({ title: `Note ${i}`, markdown: `line ${i}`, folderId: from }));
    }
    await mac.engine.sync();
    nb.tick();
    const agent = await nb.open('Claude Code', { kind: 'agent' });
    await agent.engine.sync();
    for (let commit = 0; commit < COMMITS; commit++) {
      for (const note of notes.slice(commit * MOVES, (commit + 1) * MOVES)) {
        agent.ops.move(note, to);
      }
      await agent.engine.sync();
      nb.tick();
    }
    // Every one marked undone "by Ryan" from a client changed to skip the engine's own check
    // (an agent's engine refuses to commit one): checked, never believed.
    const commits = (await agent.engine.transport.log({})).slice(0, COMMITS);
    const modified = await nb.open('Claude Code, modified');
    await modified.engine.sync();
    for (const commit of commits) {
      modified.engine.replica.workspace
        .get('agentUndone')
        .setAttr(commit.id, { at: nb.clock(), by: 'Ryan' });
    }
    await modified.engine.sync();
    await mac.engine.sync();

    // As the apps make it (LocalNotebook): titles from this device's notes.
    const activity = new AgentActivity(mac.engine.transport, mac.engine.layout, (id) => {
      const doc = mac.ops.note(id);
      return doc ? readNoteState(doc).title : null;
    });
    const live = mac.engine.replica.workspace;
    // The first list reads the branch; asked again (as the screen does after each Undo), it
    // reads nothing it has read.
    let started = performance.now();
    await activity.list(live, nb.clock());
    const first = performance.now() - started;
    started = performance.now();
    const { entries } = await activity.list(live, nb.clock());
    const listed = performance.now() - started;
    expect(entries).toHaveLength(COMMITS);
    expect(entries.every((entry) => entry.undoneAt === null)).toBe(true);
    const undoes: number[] = [];
    for (const entry of entries) {
      const at = performance.now();
      expect(await activity.undo(live, entry.id, 'Ryan', nb.clock())).toMatchObject({
        ok: true,
        alreadyUndone: false,
      });
      undoes.push(performance.now() - at);
    }
    expect(readWorkspace(live).notes.every((note) => note.folderId === from)).toBe(true);
    const after = await activity.list(live, nb.clock());
    expect(after.entries.every((entry) => entry.undoneBy === 'Ryan')).toBe(true);
    const timings = `first list ${first.toFixed(0)} ms; list ${listed.toFixed(0)} ms; undo ${undoes.map((ms) => ms.toFixed(0)).join(', ')} ms`;
    process.stdout.write(`agent activity on ${NOTES} notes: ${timings}\n`);
    expect(first, timings).toBeLessThan(300);
    expect(listed, timings).toBeLessThan(300);
    expect(Math.max(...undoes), timings).toBeLessThan(500);
  }, 300_000);
});
