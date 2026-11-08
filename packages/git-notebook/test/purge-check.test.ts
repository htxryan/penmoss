/**
 * What main lets a page's commit do to other writers' files (T50, A828, A855): delete a note for
 * good only once confirmed, and never empty or cut a writer's log.
 */
import * as Y from '@y/y';
import { describe, expect, it } from 'vitest';
import { setTitle } from '@penmoss/sync-client/note';
import { commitPurges } from '../src/purge-check';
import { Layout } from '../src/layout';
import { markRecoveredFrom } from '../src/purge';
import { testNotebook } from './support/notebooks';

describe('commitPurges', () => {
  it('reports a log replaced with less than the head holds (emptied, or cut)', async () => {
    const nb = testNotebook();
    const cli = await nb.open('CLI', { create: true });
    const id = cli.ops.createNote({ title: 'Theirs', markdown: 'not yours to empty' });
    await cli.engine.sync();
    const mac = nb.transport('Mac');
    const head = await mac.fetch();
    const files = await mac.list(head!);
    const log = [...files.keys()].find((path) => path.includes(`/notes/${id}/`))!;
    const workspace = [...files.keys()].find((path) => path.includes('workspace'))!;
    const empty = Y.encodeStateAsUpdate(new Y.Doc());
    const emptied = await commitPurges(mac, '', head, new Map([[log, empty]]));
    expect(emptied.shrunk).toEqual([log]);
    expect(emptied.added).toEqual([]);
    const folders = await commitPurges(mac, '', head, new Map([[workspace, empty]]));
    expect(folders.shrunk).toEqual([workspace]);
    // The same log, grown (the CLI edits the note again): fine.
    setTitle(cli.engine.replica.note(id)!, 'Theirs, renamed');
    await cli.engine.sync();
    const later = await mac.fetch();
    const next = (await mac.read(later!, [log])).get(log)!;
    const grown = await commitPurges(mac, '', head, new Map([[log, next]]));
    expect(grown.shrunk).toEqual([]);
  });

  it('reports a copy a commit adds whose original was deleted for good at head, never one on the branch or one whose original this commit deletes (A886)', async () => {
    const nb = testNotebook();
    const cli = await nb.open('CLI', { create: true });
    const original = cli.ops.createNote({ title: 'Passwords', markdown: 'hunter2' });
    const earlier = cli.ops.createNote({ title: 'Groceries', markdown: 'milk' });
    const stale = cli.ops.createNote({ title: 'Plans', markdown: 'old plans' });
    // A copy of Groceries brought back and pushed while Groceries was there.
    const pushed = cli.ops.createNote({ title: 'Groceries (recovered)', markdown: 'milk, eggs' });
    markRecoveredFrom(cli.engine.replica.workspace, pushed, earlier);
    await cli.engine.sync();
    cli.ops.purge(original);
    cli.ops.purge(earlier);
    await cli.engine.sync();
    // A page script adds a copy of Passwords with its link, past the engine.
    const copy = cli.ops.createNote({ title: 'Passwords (recovered)', markdown: 'hunter2' });
    markRecoveredFrom(cli.engine.replica.workspace, copy, original);
    setTitle(cli.engine.replica.note(pushed)!, 'Groceries (recovered), renamed');
    // A copy of Plans, and Plans deleted for good in this same commit: the person's own choice.
    const own = cli.ops.createNote({ title: 'Plans (recovered)', markdown: 'new plans' });
    markRecoveredFrom(cli.engine.replica.workspace, own, stale);
    cli.ops.purge(stale);
    const layout = new Layout('');
    const writer = cli.engine.writer!.id;
    const encode = (doc: Y.Doc) => Y.encodeStateAsUpdate(doc);
    const mac = nb.transport('Mac');
    const head = await mac.fetch();
    const purges = await commitPurges(
      mac,
      '',
      head,
      new Map([
        [layout.workspace(writer), encode(cli.engine.replica.workspace)],
        [layout.note(copy, writer), encode(cli.engine.replica.note(copy)!)],
        [layout.note(pushed, writer), encode(cli.engine.replica.note(pushed)!)],
        [layout.note(own, writer), encode(cli.engine.replica.note(own)!)],
      ]),
    );
    expect(purges.raced).toEqual([copy]);
    expect(purges.added).toEqual([stale]);
    expect(purges.reversed).toEqual([]);
  });
});
