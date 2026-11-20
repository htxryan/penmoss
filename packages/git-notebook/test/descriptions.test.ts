/**
 * Note descriptions for agents (PEN-161 T7, A1656): search, list_recent, list_folder,
 * get_backlinks and read_note give a note's description, read_note gives those of the notes it
 * links to, and set_properties writes one by hand, which AI Descriptions asks before rewriting.
 */
import { describe, expect, it } from 'vitest';
import { descriptionAsks, descriptionAuthor } from '@penmoss/model/description';
import { setAiDescription } from '@penmoss/model/description';
import { LocalMcpServer, LocalNotebook } from '../src/local';
import { testNotebook } from './support/notebooks';

interface ToolResult {
  isError?: boolean;
  content: { type: string; text: string }[];
  structuredContent: Record<string, unknown>;
}

async function server() {
  const nb = testNotebook();
  const clone = await nb.open('Agent', { create: true, kind: 'agent' });
  const notebook = new LocalNotebook(clone.ops, nb.clock);
  const mcp = new LocalMcpServer({ use: async (_write, run) => run(notebook) }, 'work');
  let next = 1;
  const tool = async (name: string, args: Record<string, unknown>) => {
    const reply = await mcp.line(
      JSON.stringify({
        jsonrpc: '2.0',
        id: next++,
        method: 'tools/call',
        params: { name, arguments: args },
      }),
    );
    return (JSON.parse(reply!) as { result: ToolResult }).result;
  };
  const create = (title: string, markdown: string) =>
    notebook.create({ title, markdown, tags: [], folderId: null }).reply.id;
  return { clone, notebook, tool, create };
}

describe('note descriptions over MCP', () => {
  it('gives each note its description, and read_note those of its links', async () => {
    const { clone, notebook, tool, create } = await server();
    const garden = create('Garden plan', 'Raised beds and tomatoes');
    const shed = create('Shed', 'Fix the roof');
    const index = create('Home', 'See [[Garden plan]] and [[Shed]]');
    setAiDescription(clone.ops.note(garden)!, 'What goes in the raised beds this spring.', 'x');

    const recent = (await tool('list_recent', {})).structuredContent as {
      notes: Array<{ id: string; description?: string }>;
    };
    expect(recent.notes.find((n) => n.id === garden)?.description).toBe(
      'What goes in the raised beds this spring.',
    );
    expect(recent.notes.find((n) => n.id === shed)).not.toHaveProperty('description');

    const found = (await tool('search_notes', { query: 'tomatoes' })).structuredContent as {
      results: Array<{ id: string; description?: string }>;
    };
    expect(found.results[0]).toMatchObject({
      id: garden,
      description: 'What goes in the raised beds this spring.',
    });

    const folder = (await tool('list_folder', {})).structuredContent as {
      notes: Array<{ id: string; description?: string }>;
    };
    expect(folder.notes.find((n) => n.id === garden)?.description).toContain('raised beds');

    const back = (await tool('get_backlinks', { id: garden })).structuredContent as {
      linked: Array<{ id: string }>;
    };
    expect(back.linked.map((link) => link.id)).toEqual([index]);

    const read = (await tool('read_note', { id: index })).structuredContent as {
      links: Array<{ id: string; title: string; description?: string }>;
    };
    expect(read.links).toEqual([
      {
        id: garden,
        title: 'Garden plan',
        description: 'What goes in the raised beds this spring.',
      },
      { id: shed, title: 'Shed' },
    ]);
    expect(notebook.content(garden).description).toBe('What goes in the raised beds this spring.');
  });

  it('sets a description by hand with set_properties, and asks AI Descriptions to keep it', async () => {
    const { clone, tool, create } = await server();
    const id = create('Garden plan', 'Raised beds');
    const set = await tool('set_properties', { id, description: '  Beds   for spring. ' });
    expect(set.isError).toBeFalsy();
    const doc = clone.ops.note(id)!;
    expect(descriptionAuthor(doc)).toBe('hand');
    expect(descriptionAsks(doc)).toBe(true);
    const read = (await tool('read_note', { id })).structuredContent;
    expect(read['description']).toBe('Beds for spring.');

    const long = await tool('set_properties', { id, description: 'x'.repeat(601) });
    expect(long.isError).toBe(true);

    await tool('set_properties', { id, description: '' });
    expect((await tool('read_note', { id })).structuredContent).not.toHaveProperty('description');
  });
});
