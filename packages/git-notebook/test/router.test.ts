/**
 * One local MCP server over several notebooks (PEN-139, PEN-150): calls go to the notebook their
 * ids name, reads with no id cover every notebook, and a write with neither needs `notebook`.
 */
import { notebookTag, shortNoteRef } from '@penmoss/core/note-ref';
import { describe, expect, it } from 'vitest';
import {
  LocalMcpServer,
  LocalNotebook,
  NotebookBusy,
  type NotebookSet,
  type ServedNotebook,
} from '../src/local';
import fixture from './fixtures/mcp-tool-list-notebooks.json';
import { testNotebook } from './support/notebooks';

interface ToolResult {
  isError?: boolean;
  content: { type: string; text: string }[];
  structuredContent: Record<string, unknown>;
}

const IDS: Record<string, string> = {
  Personal: '01JBNOTEBOOK00000000000P01',
  Work: '01JBNOTEBOOK00000000000W02',
  Garden: '01JBNOTEBOOK00000000000G03',
};

async function served(
  names: readonly string[],
  options: { readonly sameIds?: boolean; readonly busy?: Set<string> } = {},
) {
  const books = new Map<string, LocalNotebook>();
  for (const [index, name] of names.entries()) {
    const nb = testNotebook({
      id: IDS[name]!,
      name,
      firstId: options.sameIds ? 0 : index * 1000,
    });
    const clone = await nb.open('Agent', { create: true, kind: 'agent' });
    books.set(name, new LocalNotebook(clone.ops, nb.clock));
  }
  const used: Array<{ notebook: string; write: boolean; waitMs?: number }> = [];
  const set: NotebookSet = {
    notebooks: (): ServedNotebook[] =>
      [...books].map(([name, notebook]) => ({ name, tag: notebookTag(notebook.notebookId!) })),
    use: async (notebook, write, run, use = {}) => {
      used.push({ notebook, write, ...(use.waitMs === undefined ? {} : { waitMs: use.waitMs }) });
      if (options.busy?.has(notebook) && use.waitMs !== undefined) throw new NotebookBusy(notebook);
      return run(books.get(notebook)!);
    },
  };
  const mcp = new LocalMcpServer(set, 'Penmoss', () => {});
  let next = 1;
  const rpc = async (method: string, params: unknown) => {
    const reply = await mcp.line(JSON.stringify({ jsonrpc: '2.0', id: next++, method, params }));
    return (JSON.parse(reply!) as { result: unknown }).result;
  };
  const tool = async (name: string, args: Record<string, unknown>) =>
    (await rpc('tools/call', { name, arguments: args })) as ToolResult;
  const make = async (notebook: string, title: string, markdown = '') => {
    const made = await tool('create_note', { notebook, title, markdown });
    expect(made.isError).toBeUndefined();
    return (made.structuredContent as { id: string }).id;
  };
  const tag = (name: string) => notebookTag(IDS[name]!);
  return { books, used, rpc, tool, make, tag };
}

const text = (result: ToolResult) => result.content[0]!.text;

describe('one MCP server over several notebooks (PEN-150)', () => {
  it('lists every tool with an optional notebook, and says which notebooks it serves', async () => {
    const { rpc, tag } = await served(['Personal', 'Work']);
    const init = (await rpc('initialize', { protocolVersion: '2025-11-25' })) as {
      serverInfo: { name: string; title: string };
      instructions: string;
    };
    expect(init.serverInfo).toMatchObject({ name: 'penmoss-notebooks' });
    expect(init.instructions).toContain(`Personal (short ids ${tag('Personal')}-…)`);
    expect(init.instructions).toContain(`Work (short ids ${tag('Work')}-…)`);
    const { tools } = (await rpc('tools/list', {})) as {
      tools: Array<{
        name: string;
        description: string;
        inputSchema: { properties: Record<string, unknown>; required?: string[] };
      }>;
    };
    for (const each of tools) {
      expect(each.inputSchema.properties, each.name).toHaveProperty('notebook');
      expect(each.inputSchema.required ?? [], each.name).not.toContain('notebook');
      expect(each.description, each.name).not.toMatch(/this git notebook/i);
    }
    // The list agents see: a change to it is a change to every agent's calls.
    expect(JSON.parse(JSON.stringify(tools))).toEqual(fixture);
  });

  it('needs notebook for a new note when it serves several, and lists them', async () => {
    const { tool, tag } = await served(['Personal', 'Work']);
    const refused = await tool('create_note', { title: 'Where does this go?' });
    expect(refused.isError).toBe(true);
    expect(text(refused)).toContain('create_note needs notebook here');
    expect(text(refused)).toContain(`“Personal” (short ids ${tag('Personal')}-…)`);
    expect(text(refused)).toContain('“Work”');
    for (const name of ['get_daily_note', 'create_folder', 'set_settings', 'rename_tag']) {
      const args: Record<string, Record<string, unknown>> = {
        get_daily_note: {},
        create_folder: { name: 'Inbox' },
        set_settings: { set: { timeZone: 'UTC' } },
        rename_tag: { from: 'a', to: 'b' },
      };
      const answer = await tool(name, args[name]!);
      expect(answer.isError, name).toBe(true);
      expect(text(answer), name).toContain(`${name} needs notebook here`);
    }
    const made = await tool('create_note', { notebook: 'work', title: 'Standup' });
    expect(made.isError).toBeUndefined();
    expect(made.structuredContent).toMatchObject({ notebook: 'Work', created: true });
    // By its tag too.
    const byTag = await tool('create_note', { notebook: tag('Personal'), title: 'Groceries' });
    expect(byTag.structuredContent).toMatchObject({ notebook: 'Personal' });
    const unknown = await tool('create_note', { notebook: 'Nowhere', title: 'x' });
    expect(text(unknown)).toContain('No notebook here is called “Nowhere”');
  });

  it('serving one notebook, needs no notebook argument', async () => {
    const { tool } = await served(['Personal']);
    const made = await tool('create_note', { title: 'Only one' });
    expect(made.isError).toBeUndefined();
    expect(made.structuredContent).toMatchObject({ notebook: 'Personal' });
    expect((await tool('get_daily_note', {})).isError).toBeUndefined();
  });

  it('finds a note’s notebook by its short id or its full id', async () => {
    const { tool, make, used } = await served(['Personal', 'Work']);
    const groceries = await make('Personal', 'Groceries', 'Eggs.');
    const standup = await make('Work', 'Standup', 'Ship it.');
    const short = shortNoteRef(IDS['Work']!, standup);
    const read = await tool('read_note', { id: short });
    expect(read.isError).toBeUndefined();
    expect(read.structuredContent).toMatchObject({
      notebook: 'Work',
      id: standup,
      title: 'Standup',
    });
    // The metadata line says so too.
    expect(JSON.parse(text(read))).toMatchObject({ notebook: 'Work', id: standup });
    used.length = 0;
    const full = await tool('append_to_note', { id: groceries, markdown: 'Milk.' });
    expect(full.structuredContent).toMatchObject({ notebook: 'Personal', changed: true });
    expect(used.filter((each) => each.write).map((each) => each.notebook)).toEqual(['Personal']);
    // A notebook that contradicts the id.
    const wrong = await tool('read_note', { id: short, notebook: 'Personal' });
    expect(wrong.isError).toBe(true);
    expect(text(wrong)).toContain(`is in the notebook “Work”, not “Personal”`);
    // One that agrees is fine.
    expect((await tool('read_note', { id: short, notebook: 'Work' })).isError).toBeUndefined();
    // A short id of a notebook not served, and an id no notebook holds.
    const stranger = await tool('read_note', {
      id: `${notebookTag('elsewhere')}-${standup.slice(-8)}`,
    });
    expect(text(stranger)).toContain('a notebook this server does not serve');
    const missing = await tool('read_note', { id: '01JBZZZZZZZZZZZZZZZZZZZZZZ' });
    expect(text(missing)).toContain('in any notebook here');
  });

  it('asks which notebook when a full id is in more than one', async () => {
    const { tool, make } = await served(['Personal', 'Work'], { sameIds: true });
    const a = await make('Personal', 'Twin A');
    const b = await make('Work', 'Twin B');
    expect(a).toBe(b);
    const both = await tool('read_note', { id: a });
    expect(text(both)).toContain('is in more than one notebook (“Personal”, “Work”)');
    const one = await tool('read_note', { id: a, notebook: 'Work' });
    expect(one.structuredContent).toMatchObject({ notebook: 'Work', title: 'Twin B' });
  });

  it('searches every notebook, naming each result’s notebook; notebook narrows it', async () => {
    const { tool, make } = await served(['Personal', 'Work', 'Garden']);
    await make('Personal', 'Tomato soup', 'Tomatoes, basil.');
    await make('Work', 'Tomato project', 'Plan the tomato launch.');
    await make('Garden', 'Tomatoes', 'Plant tomatoes in May.');
    await make('Garden', 'Roses', 'Prune in March.');
    const found = await tool('search_notes', { query: 'tomato*' });
    expect(found.isError).toBeUndefined();
    const results = found.structuredContent['results'] as Array<{
      notebook: string;
      title: string;
    }>;
    expect(new Set(results.map((hit) => hit.notebook))).toEqual(
      new Set(['Personal', 'Work', 'Garden']),
    );
    // Each notebook's best first, in turn.
    expect(results.slice(0, 3).map((hit) => hit.notebook)).toEqual(['Personal', 'Work', 'Garden']);
    const narrowed = await tool('search_notes', { query: 'tomato*', notebook: 'Garden' });
    expect(narrowed.structuredContent).toMatchObject({ notebook: 'Garden' });
    expect(
      (narrowed.structuredContent['results'] as unknown[]).every(
        (hit) => !(hit as Record<string, unknown>)['notebook'],
      ),
    ).toBe(true);
    const limited = await tool('search_notes', { query: 'tomato*', limit: 2 });
    expect(limited.structuredContent['results']).toHaveLength(2);
  });

  it('lists recent notes, tags, settings and threads across notebooks', async () => {
    const { tool, make } = await served(['Personal', 'Work']);
    await make('Personal', 'Old');
    await make('Work', 'Newer');
    const recent = await tool('list_recent', {});
    const notes = recent.structuredContent['notes'] as Array<{ notebook: string; title: string }>;
    expect(notes.map((note) => `${note.notebook}/${note.title}`).sort()).toEqual([
      'Personal/Old',
      'Work/Newer',
    ]);
    await tool('tag_note', { id: (notes[0] as unknown as { id: string }).id, add: ['shared'] });
    await tool('tag_note', { id: (notes[1] as unknown as { id: string }).id, add: ['shared'] });
    const tags = await tool('list_tags', {});
    expect(tags.structuredContent['tags']).toEqual([
      { name: 'shared', notes: 2, notebooks: ['Personal', 'Work'] },
    ]);
    const settings = await tool('get_settings', {});
    expect(
      (settings.structuredContent['notebooks'] as Array<{ notebook: string }>).map(
        (each) => each.notebook,
      ),
    ).toEqual(['Personal', 'Work']);
    const threads = await tool('list_comment_threads', {});
    expect(threads.isError).toBeUndefined();
    expect(threads.structuredContent).toMatchObject({ threads: [] });
  });

  it('lists the top of every notebook, and a folder by its id or path', async () => {
    const { tool } = await served(['Personal', 'Work']);
    const journal = await tool('create_folder', { notebook: 'Personal', name: 'Journal' });
    const folderId = (journal.structuredContent as { id: string }).id;
    await tool('create_folder', { notebook: 'Work', name: 'Projects' });
    const top = await tool('list_folder', {});
    expect(top.structuredContent['notebooks']).toEqual([
      expect.objectContaining({ name: 'Personal' }),
      expect.objectContaining({ name: 'Work' }),
    ]);
    const folders = top.structuredContent['folders'] as Array<{ notebook: string; name: string }>;
    expect(folders.map((folder) => `${folder.notebook}/${folder.name}`)).toEqual([
      'Personal/Journal',
      'Work/Projects',
    ]);
    const byId = await tool('list_folder', { folderId });
    expect(byId.structuredContent).toMatchObject({ notebook: 'Personal' });
    const byPath = await tool('list_folder', { path: 'Projects' });
    expect(byPath.structuredContent).toMatchObject({ notebook: 'Work' });
    // A note made in a folder goes to the folder's notebook, with no notebook argument.
    const inFolder = await tool('create_note', { title: 'Today', folderId });
    expect(inFolder.structuredContent).toMatchObject({ notebook: 'Personal' });
  });

  it('refuses to move a note or folder into another notebook', async () => {
    const { tool, make } = await served(['Personal', 'Work']);
    const note = await make('Personal', 'Recipe');
    const work = await tool('create_folder', { notebook: 'Work', name: 'Archive' });
    const workFolder = (work.structuredContent as { id: string }).id;
    const moved = await tool('move_note', { id: note, folderId: workFolder });
    expect(moved.isError).toBe(true);
    expect(text(moved)).toContain('cross_notebook');
    expect(text(moved)).toContain(
      'a folder of the notebook “Work”, and this note is in “Personal”',
    );
    const home = await tool('create_folder', { notebook: 'Personal', name: 'Home' });
    const homeId = (home.structuredContent as { id: string }).id;
    const folderMove = await tool('move_folder', { folderId: homeId, parentId: workFolder });
    expect(text(folderMove)).toContain('cross_notebook');
    // Within its own notebook it moves.
    const kitchen = await tool('create_folder', { notebook: 'Personal', name: 'Kitchen' });
    const kitchenId = (kitchen.structuredContent as { id: string }).id;
    expect((await tool('move_note', { id: note, folderId: kitchenId })).isError).toBeUndefined();
  });

  it('leaves out a notebook that stays busy, and says so', async () => {
    const { tool, make } = await served(['Personal', 'Work'], { busy: new Set(['Work']) });
    await make('Personal', 'Tomato soup', 'Tomatoes.');
    const found = await tool('search_notes', { query: 'tomato*' });
    expect(found.isError).toBeUndefined();
    expect(found.structuredContent['skipped']).toEqual([
      { notebook: 'Work', reason: 'busy syncing' },
    ]);
    expect(found.structuredContent['results']).toHaveLength(1);
  });
});
