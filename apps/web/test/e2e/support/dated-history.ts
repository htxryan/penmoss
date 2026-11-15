/**
 * A git notebook with known commits on known days (PEN-21's Time Machine): each writer has its
 * own clone and engine, and every commit it makes carries the date given (git's
 * `GIT_AUTHOR_DATE`), so a spec knows what the notebook held on any day.
 */
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import {
  GitNotebookEngine,
  MemorySecrets,
  MemoryStorage,
  NotebookOps,
  type WriterKind,
} from '@penmoss/git-notebook';
import { LocalNotebook } from '@penmoss/git-notebook/local';
import { NodeGitTransport } from '@penmoss/git-notebook/node';
import { setTitle } from '@penmoss/sync-client/note';

/** A writer (a device or an agent) that commits and pushes a change on the day it is given. */
export type DatedWriter = (iso: string, change: (ops: NotebookOps) => void) => Promise<void>;

export function datedWriter(
  /** Where the writer's clone goes, and git's environment (a test's own config). */
  host: { readonly root: string; readonly env: Readonly<Record<string, string>> },
  remote: string,
  who: { readonly label: string; readonly kind: WriterKind },
  /** The notebook to make, for the first writer of an empty remote. */
  create?: { readonly id: string; readonly name: string },
): DatedWriter {
  const dir = mkdtempSync(join(host.root, 'dated-'));
  const storage = new MemoryStorage();
  const secrets = new MemorySecrets();
  let made = false;
  return async (iso, change) => {
    const at = Date.parse(iso);
    const transport = new NodeGitTransport({
      gitDir: join(dir, 'repo.git'),
      remote,
      branch: 'main',
      root: '',
      author: { name: who.label, email: 'writer@example.invalid' },
      env: { ...host.env, GIT_AUTHOR_DATE: iso, GIT_COMMITTER_DATE: iso },
      sign: false,
    });
    await transport.init();
    const engine = await GitNotebookEngine.open({
      transport,
      storage,
      secrets,
      writer: who,
      clock: () => at,
      ...(create && !made ? { create } : {}),
    });
    made = true;
    await engine.sync();
    change(new NotebookOps(engine, () => at));
    await engine.save();
    const report = await engine.sync();
    if (!report.commit) throw new Error(`${who.label} made no commit on ${iso}.`);
  };
}

/** Who wrote the Time Machine's story (PEN-21). */
export const STORY_DEVICE = 'Work MacBook';
export const STORY_AGENT = 'Claude Code';

/** The notes of the story, by id. */
export interface Story {
  readonly roadmap: string;
  readonly groceries: string;
  readonly ideas: string;
}

/**
 * The Time Machine's story (PEN-21), pushed to `remote` by a device and an agent: Thursday 1
 * October, the device makes Projects, Roadmap in it and Groceries; Tuesday 13 October, the agent
 * adds a line to Roadmap and makes Ideas; Wednesday 14 October, the device renames Ideas, moves
 * Roadmap to the top level and puts Groceries in Trash. `create` makes the notebook first, on an
 * empty remote.
 */
export async function timeMachineStory(
  host: { readonly root: string; readonly env: Readonly<Record<string, string>> },
  remote: string,
  create?: { readonly id: string; readonly name: string },
): Promise<Story> {
  const device = datedWriter(host, remote, { label: STORY_DEVICE, kind: 'device' }, create);
  const agent = datedWriter(host, remote, { label: STORY_AGENT, kind: 'agent' });
  let roadmap = '';
  let groceries = '';
  let ideas = '';
  await device('2026-10-01T15:00:00Z', (ops) => {
    const projects = ops.createFolder({ name: 'Projects', parentId: null });
    roadmap = ops.createNote({
      title: 'Roadmap',
      markdown: 'Ship the scrubber',
      folderId: projects,
    });
    groceries = ops.createNote({ title: 'Groceries', markdown: 'Milk and eggs' });
  });
  await agent('2026-10-13T15:00:00Z', (ops) => {
    new LocalNotebook(ops).edit(roadmap, { op: 'append', markdown: 'Agent added replay' }, null);
    ideas = ops.createNote({ title: 'Ideas', markdown: 'A weekly review page' });
  });
  await device('2026-10-14T15:00:00Z', (ops) => {
    setTitle(ops.requireNote(ideas), 'Review ideas');
    ops.move(roadmap, null);
    ops.trash(groceries);
  });
  return { roadmap, groceries, ideas };
}
