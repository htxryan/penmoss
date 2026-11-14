/**
 * Short note references (PEN-69): the local MCP server and the REST routes the CLI calls take a
 * note's short reference (`K7QD-9HTF2CXA`, any case) wherever they take its id, refuse one of
 * another notebook by naming that notebook's server, and list notes with their short ids.
 */
import { noteRefNamer, notebookTag, shortNoteRef } from '@penmoss/core/note-ref';
import { describe, expect, it } from 'vitest';
import { LocalMcpServer, LocalNotebook, localFetch, LOCAL_ORIGIN } from '../src/local';
import { NOTEBOOK_ID, testNotebook } from './support/notebooks';

interface ToolResult {
  isError?: boolean;
  content: { type: string; text: string }[];
  structuredContent: Record<string, unknown>;
}

const OTHER_NOTEBOOK = '01JQ7M1WQ3R4ZK3V8N2C5D6E7F';

async function setup() {
  const nb = testNotebook();
  const clone = await nb.open('Agent', { create: true, kind: 'agent' });
  const notebook = new LocalNotebook(clone.ops, nb.clock);
  const fetch = localFetch(notebook);
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${LOCAL_ORIGIN}${path}`, {
      method,
      headers: {},
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: JSON.parse(await response.text()) as never };
  };
  const mcp = new LocalMcpServer({ use: async (_write, run) => run(notebook) }, 'Work', () => {}, {
    notebookNamed: (tag) => (tag === notebookTag(OTHER_NOTEBOOK) ? 'Personal' : null),
  });
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
  const made = (await tool('create_note', { title: 'Roadmap', markdown: 'Ship short ids.' }))
    .structuredContent as { id: string };
  return { notebook, call, tool, id: made.id };
}

describe('short note references (PEN-69)', () => {
  it('read_note and the edit tools take a note’s short id, in any case', async () => {
    const { tool, notebook, id } = await setup();
    expect(notebook.notebookId).toBe(NOTEBOOK_ID);
    const ref = shortNoteRef(NOTEBOOK_ID, id);
    expect(ref).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{8}$/);
    const read = await tool('read_note', { id: ref });
    expect(read.isError).toBeUndefined();
    expect(read.structuredContent).toMatchObject({ id, title: 'Roadmap' });
    expect((await tool('read_note', { id: ref.toLowerCase() })).structuredContent).toMatchObject({
      id,
    });
    // The long id keeps working.
    expect((await tool('read_note', { id })).structuredContent).toMatchObject({ id });
    const appended = await tool('append_to_note', { id: ref, markdown: 'And soon.' });
    expect(appended.structuredContent).toMatchObject({ id, changed: true });
  });

  it('refuses another notebook’s short id, naming the server that reads it', async () => {
    const { tool, id } = await setup();
    const other = await tool('read_note', { id: shortNoteRef(OTHER_NOTEBOOK, id) });
    expect(other.isError).toBe(true);
    expect(other.content[0]!.text).toContain(
      'is a note of the notebook “Personal”, not of this one (Work). Read it with that notebook’s server: penmoss mcp --notebook "Personal".',
    );
    const unknown = await tool('read_note', { id: `${notebookTag('nowhere')}-${id.slice(-8)}` });
    expect(unknown.isError).toBe(true);
    expect(unknown.content[0]!.text).toContain('this machine has no notebook');
    const missing = await tool('read_note', { id: `${notebookTag(NOTEBOOK_ID)}-ZZZZZZZZ` });
    expect(missing.isError).toBe(true);
    expect(missing.content[0]!.text).toContain('not_found');
  });

  it('lists notes with their short ids next to their ids', async () => {
    const { tool, id } = await setup();
    const ref = shortNoteRef(NOTEBOOK_ID, id);
    const recent = (await tool('list_recent', {})).structuredContent as {
      notes: { id: string; shortId: string }[];
    };
    expect(recent.notes.find((note) => note.id === id)?.shortId).toBe(ref);
    const folder = (await tool('list_folder', {})).structuredContent as {
      notes: { id: string; shortId: string }[];
    };
    expect(folder.notes.find((note) => note.id === id)?.shortId).toBe(ref);
    const found = (await tool('search_notes', { query: 'Roadmap' })).structuredContent as {
      results: { id: string; shortId: string }[];
    };
    expect(found.results.find((hit) => hit.id === id)?.shortId).toBe(ref);
  });

  it('never resolves a short id to two notes: a clash gives the later note its whole id', async () => {
    const { notebook, tool } = await setup();
    // Two notes whose ids end alike, the later made first.
    const older = '01JBXYZ00000000000AB12CD34';
    const later = '01JBXYZ99999999999AB12CD34';
    notebook.ops.createNote({ id: later, title: 'Later' });
    notebook.ops.createNote({ id: older, title: 'Older' });
    const tag = notebookTag(NOTEBOOK_ID);
    const recent = (await tool('list_recent', {})).structuredContent as {
      notes: { id: string; shortId: string }[];
    };
    const shortOf = (id: string) => recent.notes.find((note) => note.id === id)?.shortId;
    expect(shortOf(older)).toBe(`${tag}-AB12CD34`);
    expect(shortOf(later)).toBe(`${tag}-${later}`);
    expect(noteRefNamer(NOTEBOOK_ID, [later, older])(later)).toBe(shortOf(later));
    const titleOf = async (id: string) =>
      ((await tool('read_note', { id })).structuredContent as { title: string }).title;
    expect(await titleOf(`${tag}-AB12CD34`)).toBe('Older');
    expect(await titleOf(`${tag}-${later}`)).toBe('Later');
  });

  it('the REST routes take a short id, and find a note by it for the CLI', async () => {
    const { call, id } = await setup();
    const ref = shortNoteRef(NOTEBOOK_ID, id);
    const content = await call('GET', `/api/notes/${ref}/content`);
    expect(content.status).toBe(200);
    expect(content.body).toMatchObject({ id });
    const listed = await call('GET', `/api/notes?ref=${ref.toLowerCase()}`);
    expect(listed.body).toMatchObject({ notes: [{ id, title: 'Roadmap' }] });
    const other = await call('GET', `/api/notes?ref=${shortNoteRef(OTHER_NOTEBOOK, id)}`);
    expect(other.status).toBe(404);
    expect(other.body).toMatchObject({ error: { code: 'other_notebook' } });
  });
});
