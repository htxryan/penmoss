/**
 * Agent activity for git notebooks (#172, A920): what an agent's writer changed in the
 * notebook's folders, note places and settings, read from the commits its `Penmoss-Writer`
 * trailer names, each with an Undo that is a new change by the person (never a rewrite of
 * history, never a reversed purge). Over real engines and the in-memory transport: offline, with
 * no server; the shapes are the server's (`/api/agent-activity`), so the apps read them unchanged.
 */
import { createFolder, readSettings, readWorkspace } from '@penmoss/sync-client/workspace';
import { describe, expect, it } from 'vitest';
import { AgentActivity, isPurged, NOTEBOOK_SETTINGS, purgedIds } from '../src';
import { commitPurges } from '../src/purge-check';
import { LocalNotebook, localFetch, LOCAL_ORIGIN } from '../src/local';
import type { CommitInfo } from '../src/transport';
import { testNotebook, type TestClone } from './support/notebooks';

const activityOf = (clone: TestClone) =>
  new AgentActivity(clone.engine.transport, clone.engine.layout);

async function world() {
  const nb = testNotebook();
  const mac = await nb.open('Mac', { create: true });
  const projects = mac.ops.createFolder({ name: 'Projects', parentId: null });
  const archive = mac.ops.createFolder({ name: 'Archive', parentId: null });
  const note = mac.ops.createNote({ title: 'Plan', markdown: 'first line', folderId: projects });
  await mac.engine.sync();
  nb.tick();
  const agent = await nb.open('Claude Code', { kind: 'agent' });
  await agent.engine.sync();
  return { nb, mac, agent, projects, archive, note };
}

/** What `commit` changed against its parent, as a commit's changes reach main or the guard. */
async function changesIn(clone: TestClone, commit: CommitInfo) {
  const transport = clone.engine.transport;
  const [was, now] = await Promise.all([
    transport.list(commit.parents[0]!),
    transport.list(commit.id),
  ]);
  const paths = [...now.keys()].filter((path) => now.get(path) !== was.get(path));
  const bytes = await transport.read(commit.id, paths);
  const changes = new Map<string, Uint8Array | null>(paths.map((p) => [p, bytes.get(p)!]));
  for (const path of was.keys()) if (!now.has(path)) changes.set(path, null);
  return changes;
}

const folderNamed = (clone: TestClone, name: string) =>
  readWorkspace(clone.engine.replica.workspace).folders.find((folder) => folder.name === name);

describe('Agent activity in a git notebook (#172, A920)', () => {
  it("lists an agent's folder, note-place and settings changes, newest first, never a person's", async () => {
    const { nb, mac, agent, projects, archive, note } = await world();
    // A person's change is never listed.
    mac.ops.renameFolder(archive, 'Old things');
    await mac.engine.sync();
    nb.tick();
    await agent.engine.sync();
    // The agent: one change per sync, as a CLI command or an MCP burst commits.
    const ideas = agent.ops.createFolder({ name: 'Ideas', parentId: null });
    await agent.engine.sync();
    nb.tick();
    agent.ops.renameFolder(projects, 'Work');
    agent.ops.moveFolder(projects, archive);
    await agent.engine.sync();
    nb.tick();
    agent.ops.move(note, ideas);
    await agent.engine.sync();
    nb.tick();
    agent.ops.setSetting('timeZone', 'Europe/Paris');
    await agent.engine.sync();
    nb.tick();
    agent.ops.deleteFolder(archive);
    await agent.engine.sync();
    await mac.engine.sync();

    const { entries } = await activityOf(mac).list(mac.engine.replica.workspace, nb.clock());
    expect(entries.map((entry) => entry.summary)).toEqual([
      'Deleted the folder “Old things” (it is in Trash)',
      'Set timeZone to “Europe/Paris”',
      'Moved “Plan” from “Old things/Work” to “Ideas”',
      'Renamed the folder “Projects” to “Work”; Moved the folder “Work” into “Old things”',
      'Made the folder “Ideas”',
    ]);
    expect(entries.map((entry) => entry.kinds)).toEqual([
      ['folder.delete'],
      ['settings'],
      ['note.move'],
      ['folder.rename', 'folder.move'],
      ['folder.create'],
    ]);
    for (const entry of entries) {
      expect(entry.actor).toEqual({ id: agent.engine.writer!.id, label: 'Claude Code' });
      expect(entry).toMatchObject({ undoneAt: null, undoneBy: null });
      expect(Number.isSafeInteger(entry.id) && entry.id > 0).toBe(true);
    }
    // The same entries, with the same ids, on any clone: they come from the branch.
    const pixel = await nb.open('Pixel');
    await pixel.engine.sync();
    const again = await activityOf(pixel).list(pixel.engine.replica.workspace, nb.clock());
    expect(again.entries.map((entry) => entry.id)).toEqual(entries.map((entry) => entry.id));
  });

  it('undoes each as a new change by the person that syncs, history left as it was', async () => {
    const { nb, mac, agent, projects, archive, note } = await world();
    const ideas = agent.ops.createFolder({ name: 'Ideas', parentId: null });
    agent.ops.move(note, ideas);
    agent.ops.renameFolder(projects, 'Work');
    agent.ops.moveFolder(projects, archive);
    agent.ops.setSetting('timeZone', 'Europe/Paris');
    await agent.engine.sync();
    nb.tick();
    agent.ops.deleteFolder(archive);
    await agent.engine.sync();
    await mac.engine.sync();
    const before = await mac.engine.transport.log({});
    const activity = activityOf(mac);
    const live = mac.engine.replica.workspace;
    const [deleted, changed] = (await activity.list(live, nb.clock())).entries;

    const restored = await activity.undo(live, deleted!.id, 'Ryan', nb.clock());
    expect(restored).toEqual({ ok: true, alreadyUndone: false, notice: null });
    expect(folderNamed(mac, 'Archive')).toBeDefined();
    // The other one in a single step: the note, the folder's name and place, the setting, and
    // the new folder (empty again once the note is back, so it goes to Trash).
    expect(await activity.undo(live, changed!.id, 'Ryan', nb.clock())).toMatchObject({ ok: true });
    const tree = readWorkspace(live);
    expect(tree.folders.find((folder) => folder.id === projects)).toMatchObject({
      name: 'Projects',
      parentId: null,
    });
    expect(tree.folders.find((folder) => folder.id === ideas)).toBeUndefined();
    expect(tree.notes.find((entry) => entry.id === note)?.folderId).toBe(projects);
    expect(readSettings(live, NOTEBOOK_SETTINGS)['timeZone']).toBeUndefined();
    // Undone twice: said, nothing more changed.
    expect(await activity.undo(live, changed!.id, 'Ryan', nb.clock())).toEqual({
      ok: true,
      alreadyUndone: true,
      notice: null,
    });

    // It syncs as an ordinary commit of the person's writer: a fast-forward on what was there.
    nb.tick();
    await mac.engine.sync();
    const after = await mac.engine.transport.log({});
    expect(after.slice(after.length - before.length).map((c) => c.id)).toEqual(
      before.map((c) => c.id),
    );
    expect(after[0]!.message).toContain(`Penmoss-Writer: ${mac.engine.writer!.id} (device "Mac")`);
    const pixel = await nb.open('Pixel');
    await pixel.engine.sync();
    expect(folderNamed(pixel, 'Projects')?.parentId).toBeNull();
    const seen = await activityOf(pixel).list(pixel.engine.replica.workspace, nb.clock());
    expect(seen.entries.map((entry) => entry.undoneBy)).toEqual(['Ryan', 'Ryan']);
    // The person's undo is never listed itself.
    expect(seen.entries).toHaveLength(2);
  });

  it('changes nothing when something changed since, and says what', async () => {
    const { nb, mac, agent, projects } = await world();
    agent.ops.renameFolder(projects, 'Work');
    await agent.engine.sync();
    nb.tick();
    const made = agent.ops.createFolder({ name: 'Ideas', parentId: null });
    await agent.engine.sync();
    await mac.engine.sync();
    mac.ops.renameFolder(projects, 'Mine');
    mac.ops.createNote({ title: 'Inside', markdown: 'x', folderId: made });
    const live = mac.engine.replica.workspace;
    const activity = activityOf(mac);
    const [create, rename] = (await activity.list(live, nb.clock())).entries;
    const shot = JSON.stringify(readWorkspace(live));
    expect(await activity.undo(live, rename!.id, 'Ryan', nb.clock())).toEqual({
      ok: false,
      status: 409,
      code: 'changed_since',
      message: 'The folder “Work” was renamed “Mine” since. Nothing was undone.',
    });
    expect(await activity.undo(live, create!.id, 'Ryan', nb.clock())).toMatchObject({
      ok: false,
      code: 'changed_since',
      message:
        'The folder “Ideas” has notes or folders in it now; delete it yourself if you want it gone. Nothing was undone.',
    });
    expect(JSON.stringify(readWorkspace(live))).toBe(shot);
    expect(await activity.undo(live, 12345, 'Ryan', nb.clock())).toMatchObject({
      ok: false,
      status: 404,
      code: 'not_found',
    });
  });

  it('never brings back a note deleted for good, and the guard still refuses a reversed purge', async () => {
    const { nb, mac, agent, projects, archive, note } = await world();
    agent.ops.move(note, archive);
    await agent.engine.sync();
    nb.tick();
    agent.ops.deleteFolder(projects);
    await agent.engine.sync();
    await mac.engine.sync();
    // The person deletes the note for good, and the purge lands.
    mac.ops.purge(note);
    await mac.engine.sync();
    const live = mac.engine.replica.workspace;
    const activity = activityOf(mac);
    const [deleted, moved] = (await activity.list(live, nb.clock())).entries;
    // Its move: the note stays deleted for good, and the undo says so (#174 review).
    expect(await activity.undo(live, moved!.id, 'Ryan', nb.clock())).toEqual({
      ok: true,
      alreadyUndone: false,
      notice: '“Plan” is already deleted for good, so it stays deleted.',
    });
    expect(await activity.undo(live, deleted!.id, 'Ryan', nb.clock())).toMatchObject({ ok: true });
    expect(folderNamed(mac, 'Projects')).toBeDefined();
    expect(isPurged(live, note)).toBe(true);
    expect(readWorkspace(live).notes.some((entry) => entry.id === note)).toBe(false);
    const head = await mac.engine.transport.fetch();
    nb.tick();
    await mac.engine.sync();
    const next = await mac.engine.transport.fetch();
    expect(next).not.toBe(head);
    // The undo's commit, as the Mac's main and Android's guard check it.
    const [was, now] = await Promise.all([
      mac.engine.transport.list(head!),
      mac.engine.transport.list(next!),
    ]);
    const paths = [...now.keys()].filter((path) => now.get(path) !== was.get(path));
    const bytes = await mac.engine.transport.read(next!, paths);
    const changes = new Map<string, Uint8Array | null>(paths.map((p) => [p, bytes.get(p)!]));
    for (const path of was.keys()) if (!now.has(path)) changes.set(path, null);
    expect(changes.size).toBeGreaterThan(0);
    const checked = await commitPurges(mac.engine.transport, mac.engine.layout.root, head, changes);
    expect(checked.reversed).toEqual([]);
    expect([...purgedIds(mac.engine.replica.workspace)]).toEqual([note]);
  });

  it('is for the person: an agent writer is refused, over the same REST shapes as the server', async () => {
    const { nb, mac, agent, projects } = await world();
    agent.ops.renameFolder(projects, 'Work');
    await agent.engine.sync();
    await mac.engine.sync();
    const fetchAs = (clone: TestClone) => localFetch(new LocalNotebook(clone.ops, nb.clock));
    const asAgent = fetchAs(agent);
    const refused = await asAgent(`${LOCAL_ORIGIN}/api/agent-activity`, {
      method: 'GET',
      headers: {},
    });
    expect(refused.status).toBe(403);
    expect(JSON.parse(await refused.text())).toMatchObject({
      error: { code: 'agent_not_allowed' },
    });

    const asMac = fetchAs(mac);
    const listed = await asMac(`${LOCAL_ORIGIN}/api/agent-activity`, {
      method: 'GET',
      headers: {},
    });
    const { entries } = JSON.parse(await listed.text()) as { entries: Array<{ id: number }> };
    expect(entries).toHaveLength(1);
    const undone = await asMac(`${LOCAL_ORIGIN}/api/agent-activity/${entries[0]!.id}/undo`, {
      method: 'POST',
      headers: {},
      body: '{}',
    });
    expect(undone.status).toBe(200);
    expect(JSON.parse(await undone.text())).toEqual({
      id: entries[0]!.id,
      undone: true,
      alreadyUndone: false,
      notice: null,
    });
    expect(folderNamed(mac, 'Projects')).toBeDefined();
    const byAgent = await asAgent(`${LOCAL_ORIGIN}/api/agent-activity/${entries[0]!.id}/undo`, {
      method: 'POST',
      headers: {},
      body: '{}',
    });
    expect(byAgent.status).toBe(403);
  });
  it('never files again a note deleted for good, here or at head: skipped, and said (#174 review)', async () => {
    const { nb, mac, agent, note } = await world();
    // A notebook (A750): deleting it puts its notes in Trash with it, and Restore files them.
    const work = 'NOTEBOOKWORK00000000000001';
    createFolder(mac.ops.workspace, { id: work, name: 'Work', parentId: null, notebook: true });
    mac.ops.move(note, work);
    const other = mac.ops.createNote({ title: 'Other', markdown: 'kept', folderId: work });
    await mac.engine.sync();
    nb.tick();
    await agent.engine.sync();
    agent.ops.deleteFolder(work);
    await agent.engine.sync();
    nb.tick();
    await mac.engine.sync();
    const pixel = await nb.open('Pixel');
    await pixel.engine.sync();
    // On the Mac, Plan is deleted for good here (not synced yet); on the Pixel, Other is, and
    // that lands at head before the Mac has merged it.
    mac.ops.purge(note);
    pixel.ops.purge(other);
    await pixel.engine.sync();
    nb.tick();
    await mac.engine.transport.fetch();
    const live = mac.engine.replica.workspace;
    const activity = activityOf(mac);
    const [deleted] = (await activity.list(live, nb.clock())).entries;
    const result = await activity.undo(live, deleted!.id, 'Ryan', nb.clock());
    expect(result).toMatchObject({ ok: true, alreadyUndone: false });
    expect(result.ok && result.notice).toContain('“Plan” is already deleted for good');
    expect(result.ok && result.notice).toContain('“Other” is already deleted for good');
    expect(folderNamed(mac, 'Work')).toBeDefined();
    const filed = readWorkspace(live).notes.map((entry) => entry.id);
    expect(filed).not.toContain(note);
    expect(filed).not.toContain(other);
    // Nothing of a purge goes back: the sync's commit reverses none.
    const head = await mac.engine.transport.fetch();
    await mac.engine.sync();
    const next = await mac.engine.transport.fetch();
    const [was, now] = await Promise.all([
      mac.engine.transport.list(head!),
      mac.engine.transport.list(next!),
    ]);
    const paths = [...now.keys()].filter((path) => now.get(path) !== was.get(path));
    const bytes = await mac.engine.transport.read(next!, paths);
    const changes = new Map<string, Uint8Array | null>(paths.map((p) => [p, bytes.get(p)!]));
    for (const path of was.keys()) if (!now.has(path)) changes.set(path, null);
    const checked = await commitPurges(mac.engine.transport, mac.engine.layout.root, head, changes);
    expect(checked.reversed).toEqual([]);
    expect(
      readWorkspace(mac.engine.replica.workspace).notes.map((entry) => entry.id),
    ).not.toContain(other);
  });

  it('a person restoring a notebook from Trash never files a note deleted for good either', async () => {
    const { mac, note } = await world();
    const work = 'NOTEBOOKWORK00000000000001';
    createFolder(mac.ops.workspace, { id: work, name: 'Work', parentId: null, notebook: true });
    mac.ops.move(note, work);
    mac.ops.deleteFolder(work);
    mac.ops.purge(note);
    expect(mac.ops.restoreFolder(work)).toMatchObject({ restored: true, keptOut: [note] });
    expect(
      readWorkspace(mac.engine.replica.workspace).notes.map((entry) => entry.id),
    ).not.toContain(note);
  });

  it("an agent's own mark of its change as undone by Ryan is not believed: Undo still puts it back (#174 delta review)", async () => {
    const { nb, mac, agent, projects } = await world();
    agent.ops.renameFolder(projects, 'Pwned');
    await agent.engine.sync();
    const [renamed] = await agent.engine.transport.log({});
    nb.tick();
    // The reviewer's probe: the agent marks its own change undone, by Ryan. Its engine never
    // commits that (#174 merge check)...
    agent.engine.replica.workspace
      .get('agentUndone')
      .setAttr(renamed!.id, { at: nb.clock(), by: 'Ryan' });
    await expect(agent.engine.sync()).rejects.toThrow(
      /only a person marks an agent’s change undone/,
    );
    expect((await agent.engine.transport.log({}))[0]!.id).toBe(renamed!.id);
    // ...but a client changed to skip that check gets one onto the branch, and Agent activity
    // must not believe it.
    const modified = await nb.open('Claude Code, modified');
    await modified.engine.sync();
    modified.engine.replica.workspace
      .get('agentUndone')
      .setAttr(renamed!.id, { at: nb.clock(), by: 'Ryan' });
    await modified.engine.sync();
    const [marking] = await modified.engine.transport.log({});
    expect(marking!.id).not.toBe(renamed!.id);
    await mac.engine.sync();

    const activity = activityOf(mac);
    const live = mac.engine.replica.workspace;
    const [entry] = (await activity.list(live, nb.clock())).entries;
    expect(entry).toMatchObject({
      summary: 'Renamed the folder “Projects” to “Pwned”',
      undoneAt: null,
      undoneBy: null,
    });
    expect(await activity.undo(live, entry!.id, 'Ryan', nb.clock())).toEqual({
      ok: true,
      alreadyUndone: false,
      notice: null,
    });
    expect(folderNamed(mac, 'Projects')?.id).toBe(projects);
    // Undone for real, it is shown so.
    const [after] = (await activity.list(live, nb.clock())).entries;
    expect(after).toMatchObject({ undoneBy: 'Ryan' });

    // The commit check sees the mark the agent's commit added, for main and Android's guard to
    // refuse from an agent writer; a commit that leaves the marks alone shows none.
    const check = async (commit: CommitInfo) =>
      commitPurges(
        modified.engine.transport,
        modified.engine.layout.root,
        commit.parents[0]!,
        await changesIn(modified, commit),
      );
    expect((await check(marking!)).undoneMarks).toEqual([renamed!.id]);
    expect((await check(renamed!)).undoneMarks).toEqual([]);
  });

  it('is refused to every agent, the one that made the change too, and to the CLI and MCP', async () => {
    const { nb, mac, agent, projects } = await world();
    agent.ops.renameFolder(projects, 'Work');
    await agent.engine.sync();
    await mac.engine.sync();
    const [entry] = (await activityOf(mac).list(mac.engine.replica.workspace, nb.clock())).entries;
    const undo = (notebook: LocalNotebook) =>
      localFetch(notebook)(`${LOCAL_ORIGIN}/api/agent-activity/${entry!.id}/undo`, {
        method: 'POST',
        headers: {},
        body: '{}',
      });
    // The agent that made it, after it has synced the change.
    await agent.engine.sync();
    const own = await undo(new LocalNotebook(agent.ops, nb.clock));
    expect(own.status).toBe(403);
    // A person's clone, served to the CLI or an MCP client (agents' sides): refused as well.
    for (const side of ['cli', 'mcp'] as const) {
      const served = await undo(new LocalNotebook(mac.ops, nb.clock, undefined, { side }));
      expect(served.status).toBe(403);
      expect(JSON.parse(await served.text())).toMatchObject({
        error: { code: 'agent_not_allowed' },
      });
    }
    expect(folderNamed(mac, 'Work')).toBeDefined();
    expect(readWorkspace(mac.engine.replica.workspace).folders).toHaveLength(2);
  });
  it("reads each commit from the one before: a person's changes between an agent's are never its, and marks and renames still hold (#174 merge check)", async () => {
    const nb = testNotebook();
    const mac = await nb.open('Mac', { create: true });
    const inbox = mac.ops.createFolder({ name: 'Inbox', parentId: null });
    const filed = mac.ops.createFolder({ name: 'Filed', parentId: null });
    const [one, two, three] = ['One', 'Two', 'Three'].map((title) =>
      mac.ops.createNote({ title, markdown: title, folderId: inbox }),
    );
    await mac.engine.sync();
    nb.tick();
    const agent = await nb.open('Claude Code', { kind: 'agent' });
    await agent.engine.sync();
    // Agent, person, agent, person, agent: the Mac's file changes between the agent's commits.
    agent.ops.move(one!, filed);
    await agent.engine.sync();
    nb.tick();
    await mac.engine.sync();
    mac.ops.renameFolder(inbox, 'Incoming');
    mac.ops.move(three!, filed);
    await mac.engine.sync();
    nb.tick();
    await agent.engine.sync();
    agent.ops.move(two!, filed);
    await agent.engine.sync();
    nb.tick();
    await mac.engine.sync();
    mac.ops.setSetting('timeZone', 'Europe/Paris');
    await mac.engine.sync();
    nb.tick();
    await agent.engine.sync();
    agent.ops.renameFolder(filed, 'Done');
    await agent.engine.sync();
    nb.tick();
    await mac.engine.sync();

    // Titles as this device has them, renamed below.
    const titles = new Map([
      [one!, 'One'],
      [two!, 'Two'],
      [three!, 'Three'],
    ]);
    const activityHere = () =>
      new AgentActivity(mac.engine.transport, mac.engine.layout, (id) => titles.get(id) ?? null);
    const activity = activityHere();
    const live = mac.engine.replica.workspace;
    const { entries } = await activity.list(live, nb.clock());
    expect(entries.map((entry) => entry.summary)).toEqual([
      'Renamed the folder “Filed” to “Done”',
      'Moved “Two” from “Incoming” to “Filed”',
      'Moved “One” from “Inbox” to “Filed”',
    ]);
    // Two lists at once on one instance read the same.
    const [x, y] = await Promise.all([
      activityHere().list(live, nb.clock()),
      activity.list(live, nb.clock()),
    ]);
    expect(x).toEqual({ entries });
    expect(y).toEqual({ entries });

    // Undone, then the Mac commits it: the next list reads the Mac's grown file over its own.
    expect(await activity.undo(live, entries[1]!.id, 'Ryan', nb.clock())).toMatchObject({
      ok: true,
      alreadyUndone: false,
    });
    nb.tick();
    await mac.engine.sync();
    const marked = await activity.list(live, nb.clock());
    expect(marked.entries.map((entry) => entry.undoneBy)).toEqual([null, 'Ryan', null]);
    expect(readWorkspace(live).notes.find((note) => note.id === two)?.folderId).toBe(inbox);

    // A note renamed here: the oldest commit is worded again, read back from where the list
    // left off, and it reads as a list made from nothing does.
    titles.set(one!, 'One, renamed');
    const renamed = await activity.list(live, nb.clock());
    expect(renamed.entries.map((entry) => entry.summary)).toEqual([
      'Renamed the folder “Filed” to “Done”',
      'Moved “Two” from “Incoming” to “Filed”',
      'Moved “One, renamed” from “Inbox” to “Filed”',
    ]);
    expect(renamed).toEqual(await activityHere().list(live, nb.clock()));
    // And the rest still undoes, all of it.
    expect(await activity.undo(live, entries[2]!.id, 'Ryan', nb.clock())).toMatchObject({
      ok: true,
    });
    expect(await activity.undo(live, entries[0]!.id, 'Ryan', nb.clock())).toMatchObject({
      ok: true,
    });
    const tree = readWorkspace(live);
    expect(tree.folders.find((folder) => folder.id === filed)?.name).toBe('Filed');
    expect(tree.notes.find((note) => note.id === one)?.folderId).toBe(inbox);
  });
});
