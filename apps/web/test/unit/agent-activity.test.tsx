import { renderToString } from 'react-dom/server';
import type { ReactElement } from 'react';
import { describe, expect, it } from 'vitest';
import { ActivityList } from '../../src/agents/AgentActivity';
import { gitUndoMessage, type ActivityEntry } from '../../src/agents/activity';
import type { NotebookActivity } from '../../src/sources/agent-activity-list';
import { DeletedFolderList } from '../../src/trash/DeletedFolders';
import { folderContents, restoredMessage } from '../../src/trash/deleted-folders';

const render = (element: ReactElement) => renderToString(element).replace(/<!-- -->/g, '');
/** The rendered text, without markup. */
const text = (html: string) => html.replace(/<[^>]+>/g, '');

const entry = (over: Partial<ActivityEntry> = {}): ActivityEntry => ({
  id: 7,
  at: 1_761_220_000_000,
  actor: { id: 'agent:t1', label: 'Claude Code' },
  kinds: ['folder.rename'],
  summary: 'Renamed the folder “Garden” to “Yard”',
  undoneAt: null,
  undoneBy: null,
  ...over,
});

const item = (over: Partial<ActivityEntry> = {}): NotebookActivity => ({
  notebookId: 'nb1',
  notebook: 'Personal',
  entry: entry(over),
});

// T42 (A561), PEN-146: Settings → Agent Activity lists what agents changed, each with Undo.
describe('agent activity', () => {
  it('lists each change with the agent that made it, its notebook and an Undo', () => {
    const html = render(
      <ActivityList items={[item()]} busy={false} canUndo={() => true} onUndo={() => {}} />,
    );
    expect(html).toContain('Renamed the folder “Garden” to “Yard”');
    expect(text(html)).toContain('✦ Claude Code · Personal · ');
    expect(html).toContain('data-notebook-id="nb1"');
    // The Undo button is named Undo and described by the change it undoes.
    expect(html).toMatch(/id="agent-activity-nb1-7"[^>]*>Renamed the folder “Garden” to “Yard”/);
    expect(html).toContain('aria-describedby="agent-activity-nb1-7"');
    expect(html).toContain('data-event="settings.agent-activity.undo"');
  });

  it('shows who undid a change instead of its Undo', () => {
    const html = render(
      <ActivityList
        items={[item({ undoneAt: 1_761_230_000_000, undoneBy: 'Ryan’s Mac' })]}
        busy={false}
        canUndo={() => true}
        onUndo={() => {}}
      />,
    );
    expect(html).toContain('Undone by Ryan’s Mac');
    expect(html).toContain('data-undone="true"');
    expect(html).not.toContain('aria-describedby');
  });

  it('offers no Undo for a notebook no longer on this Mac, and waits while one runs', () => {
    expect(
      render(
        <ActivityList items={[item()]} busy={false} canUndo={() => false} onUndo={() => {}} />,
      ),
    ).not.toContain('aria-describedby');
    expect(
      render(<ActivityList items={[item()]} busy canUndo={() => true} onUndo={() => {}} />),
    ).toMatch(/<button[^>]*disabled=""/);
  });

  // #172 (A920): a git notebook's list, from its branch; Undo answers in the server's words.
  it('says what Undo did in the server’s words', () => {
    expect(gitUndoMessage({ ok: true, alreadyUndone: false, notice: null }, entry())).toBe(
      'Undone: Renamed the folder “Garden” to “Yard”.',
    );
    expect(gitUndoMessage({ ok: true, alreadyUndone: true, notice: null }, entry())).toBe(
      'That change was undone already.',
    );
    expect(gitUndoMessage({ ok: true, alreadyUndone: false, notice: 'Restored.' }, entry())).toBe(
      'Restored.',
    );
    expect(
      gitUndoMessage(
        { ok: false, message: 'The folder “Yard” was renamed “Lawn” since. Nothing was undone.' },
        entry(),
      ),
    ).toBe('The folder “Yard” was renamed “Lawn” since. Nothing was undone.');
  });
});

// T42 (A560): a deleted folder waits in Trash with what it held, and comes back with Restore.
describe('deleted folders in Trash', () => {
  const folder = {
    id: 'garden',
    name: 'Garden',
    parentId: 'home',
    deletedAt: 1_761_220_000_000,
    deletedBy: { label: 'Claude Code', kind: 'agent' as const },
    folders: 2,
    notes: 1,
    notebook: false,
  };

  it('lists a folder with its contents, where it was, who deleted it and its days left', () => {
    const html = render(
      <DeletedFolderList
        folders={[folder]}
        now={folder.deletedAt + 2 * 24 * 60 * 60 * 1000}
        busy={false}
        folderName={(id) => (id === 'home' ? '“Home”' : 'the top level')}
        onRestore={() => {}}
      />,
    );
    expect(html).toContain('Garden');
    expect(html).toContain('1 note, 2 subfolders');
    // Named as Trash names a note's deleter (A574): an agent with ✦ on the accent tint.
    expect(text(html)).toContain('from “Home” by Claude Code✦ (agent)');
    expect(html).toContain('data-kind="agent"');
    expect(html).toContain('28 days left');
    expect(html).toContain('aria-label="Restore the folder Garden"');
    expect(folderContents({ ...folder, folders: 0, notes: 3 })).toBe('3 notes');
    // A device by name, without the agent mark.
    const byPhone = render(
      <DeletedFolderList
        folders={[{ ...folder, deletedBy: { label: 'Ryan’s phone', kind: 'device' } }]}
        now={folder.deletedAt}
        busy={false}
        folderName={() => 'the top level'}
        onRestore={() => {}}
      />,
    );
    expect(text(byPhone)).toContain('by Ryan’s phone ·');
    expect(byPhone).not.toContain('✦');
  });

  // B9: deleted by a device whose clock runs ahead, or after the page read the clock.
  it('never shows more days left than a folder is kept for', () => {
    const ahead = render(
      <DeletedFolderList
        folders={[{ ...folder, deletedAt: folder.deletedAt + 3 * 24 * 60 * 60 * 1000 }]}
        now={folder.deletedAt}
        busy={false}
        folderName={() => 'the top level'}
        onRestore={() => {}}
      />,
    );
    expect(text(ahead)).toContain('· 30 days left');
    const gone = render(
      <DeletedFolderList
        folders={[folder]}
        now={folder.deletedAt + 31 * 24 * 60 * 60 * 1000}
        busy={false}
        folderName={() => 'the top level'}
        onRestore={() => {}}
      />,
    );
    expect(text(gone)).toContain('· 0 days left');
  });

  it('says what a restore did, and which notes it left where they are', () => {
    expect(
      restoredMessage('Garden', { restored: true, parentGone: false, notes: 3, skipped: [] }),
    ).toBe('Restored “Garden”.');
    expect(
      restoredMessage('Garden', {
        restored: true,
        parentGone: true,
        notes: 1,
        skipped: ['a', 'b'],
      }),
    ).toBe(
      'Restored “Garden” at the top level. The folder it was in is gone. 2 notes were moved or deleted since, so they stay where they are.',
    );
    expect(
      restoredMessage('Garden', { restored: false, parentGone: false, notes: 0, skipped: [] }),
    ).toBe('“Garden” is not in Trash any more.');
  });
});
