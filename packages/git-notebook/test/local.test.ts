/**
 * The notes API on this device (T50 G2): the REST routes the CLI's `--notebook` calls and the
 * local MCP server's tools, over a notebook in memory. Shapes and codes are the server's.
 */
import { commentToolDefinitions, toolDefinitions } from '@penmoss/core/mcp';
import { periodicNoteId } from '@penmoss/core/periodic';
import { describe, expect, it } from 'vitest';
import {
  LocalMcpServer,
  localTools,
  ABSENT_TOOLS,
  LocalNotebook,
  localFetch,
  LOCAL_ORIGIN,
} from '../src/local';
import { NOTEBOOK_ID, testNotebook } from './support/notebooks';

/** A route's JSON reply: the fields these tests read past `toMatchObject` are typed. */
interface Reply {
  [field: string]: unknown;
  error: { code: string; details?: unknown };
  notes: { id: string }[];
  results: { title: string; snippet: string }[];
}

/** A `tools/call` result, as the MCP server answers it. */
interface ToolResult {
  isError?: boolean;
  content: { type: string; text: string }[];
  structuredContent: Record<string, unknown>;
}

async function setup() {
  const nb = testNotebook();
  const clone = await nb.open('Agent', { create: true, kind: 'agent' });
  const notebook = new LocalNotebook(clone.ops, nb.clock);
  let writes = 0;
  const fetch = localFetch(notebook, () => {
    writes++;
  });
  const call = async (
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) => {
    const response = await fetch(`${LOCAL_ORIGIN}${path}`, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return {
      status: response.status,
      body: JSON.parse(await response.text()) as Reply,
    };
  };
  return { nb, clone, notebook, call, writes: () => writes };
}

describe('the REST routes, locally', () => {
  it('creates, finds, reads and edits notes as the server does', async () => {
    const { call, nb, clone } = await setup();
    const made = await call(
      'POST',
      '/api/notes',
      {
        title: 'Garden plan',
        markdown: '## Beds\n\nTomatoes\n\n## Log\n',
        tags: ['garden'],
        folderId: null,
      },
      { 'Idempotency-Key': 'k1' },
    );
    expect(made.status).toBe(201);
    expect(made.body).toMatchObject({
      id: expect.any(String) as string,
      changed: true,
      baseVersion: expect.any(Number) as number,
      version: null,
    });
    expect(made.body['summary']).toMatch(/^Created · \+\d+ −0 lines?$/);
    const again = await call(
      'POST',
      '/api/notes',
      { title: 'Garden plan', markdown: 'other', tags: [], folderId: null },
      { 'Idempotency-Key': 'k1' },
    );
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ id: made.body['id'], changed: false });
    const id = made.body['id'] as string;

    const found = await call('GET', '/api/notes?title=garden%20PLAN&limit=21');
    expect(found.body['notes'].map((n: { id: string }) => n.id)).toEqual([id]);
    expect(found.body['notes'][0]).toMatchObject({
      title: 'Garden plan',
      kind: 'note',
      tags: ['garden'],
      excerpt: 'Beds Tomatoes Log',
    });

    const content = await call('GET', `/api/notes/${id}/content`);
    expect(content.body).toMatchObject({
      id,
      title: 'Garden plan',
      tags: ['garden'],
      headings: ['## Beds', '## Log'],
      deleted: false,
    });
    expect(content.body['markdown']).toMatch(
      new RegExp(`^---\\nid: ${id}\\ntitle: Garden plan\\n`),
    );
    expect(content.body['body']).toBe('## Beds\n\nTomatoes\n\n## Log\n');
    const base = content.body['baseVersion'] as number;

    const appended = await call('POST', `/api/notes/${id}/append`, {
      markdown: '- watered',
      heading: 'Log',
    });
    expect(appended.body).toMatchObject({
      id,
      changed: true,
      summary: 'Added to “Log” · +1 −0 line',
    });
    // The section changed since `base`: refused, with the text as it is now.
    const stale = await call('POST', `/api/notes/${id}/section`, {
      heading: 'Log',
      markdown: 'new',
      mode: 'replace',
      baseVersion: base,
    });
    expect(stale.status).toBe(409);
    expect(stale.body['error']).toMatchObject({
      code: 'conflict',
      details: { current: expect.stringContaining('- watered') as string },
    });
    // Beds did not change since `base`: allowed.
    const beds = await call('POST', `/api/notes/${id}/section`, {
      heading: 'Beds',
      markdown: 'Peppers',
      baseVersion: base,
    });
    expect(beds.status).toBe(200);
    expect(
      (await call('POST', `/api/notes/${id}/section`, { heading: 'Beds', markdown: 'x' })).status,
    ).toBe(428);
    expect(
      (
        await call('POST', `/api/notes/${id}/section`, {
          heading: 'Beds',
          markdown: 'x',
          baseVersion: 999,
        })
      ).body['error'].code,
    ).toBe('base_unknown');
    const missing = await call('POST', `/api/notes/${id}/section`, {
      heading: 'Nope',
      markdown: 'x',
      baseVersion: beds.body['baseVersion'],
    });
    expect(missing.body['error']).toMatchObject({
      code: 'heading_not_found',
      details: { headings: ['## Beds', '## Log'] },
    });
    const twice = await call('POST', `/api/notes/${id}/append`, { markdown: '- watered' });
    expect(twice.status).toBe(200);
    const ambiguous = await call('POST', `/api/notes/${id}/replace`, {
      find: 'watered',
      replace: 'fed',
      all: false,
      scope: 'text',
      baseVersion: twice.body['baseVersion'],
    });
    expect(ambiguous.body['error'].code).toBe('text_ambiguous');
    const all = await call('POST', `/api/notes/${id}/replace`, {
      find: 'watered',
      replace: 'fed',
      all: true,
      scope: 'text',
      baseVersion: twice.body['baseVersion'],
    });
    expect(all.body).toMatchObject({ changed: true });
    const tagged = await call('POST', `/api/notes/${id}/tags`, {
      add: ['projects/2027'],
      remove: ['garden'],
    });
    expect(tagged.body['changed']).toBe(true);
    expect((await call('GET', `/api/notes/${id}/content`)).body['tags']).toEqual(['projects/2027']);
    // Everything is in the docs the next sync commits.
    await clone.engine.sync();
    expect(nb.rendered().get('Garden plan.md')).toContain('- fed');
  });

  it('moves, trashes and restores notes; folders and their preconditions', async () => {
    const { call } = await setup();
    const id = (
      await call('POST', '/api/notes', { title: 'Plan', markdown: 'x', tags: [], folderId: null })
    ).body['id'] as string;
    const folderId = '01JBAAAAAA0000000000000001';
    expect(
      (await call('POST', '/api/folders', { id: folderId, name: 'Projects', parentId: null }))
        .status,
    ).toBe(201);
    expect(
      (await call('POST', '/api/folders', { id: folderId, name: 'Projects', parentId: null }))
        .status,
    ).toBe(200);
    expect(
      (
        await call('POST', '/api/folders', {
          id: '01JBAAAAAA0000000000000002',
          name: 'projects',
          parentId: null,
          reuseName: true,
        })
      ).body['id'],
    ).toBe(folderId);
    expect((await call('POST', `/api/notes/${id}/move`, { folderId })).body).toEqual({
      id,
      folderId,
    });
    const listing = await call('GET', '/api/folders?path=projects');
    expect(listing.body).toMatchObject({
      folder: { id: folderId, name: 'Projects', path: 'Projects' },
      notes: [{ id, title: 'Plan' }],
    });
    expect((await call('GET', '/api/folders?path=nope')).body['error'].code).toBe(
      'folder_not_found',
    );
    const renamed = await call('PATCH', `/api/folders/${folderId}`, {
      name: 'Work',
      from: { name: 'Elsewhere' },
    });
    expect(renamed.body['error'].code).toBe('folder_changed');
    expect(
      (
        await call('PATCH', `/api/folders/${folderId}`, {
          name: 'Work',
          from: { name: 'Projects' },
        })
      ).body,
    ).toMatchObject({ id: folderId, name: 'Work' });
    expect(
      (await call('PATCH', `/api/folders/${folderId}`, { sortMode: 'alpha' })).body['sortMode'],
    ).toBe('alpha');
    expect((await call('PATCH', '/api/folders/root', { sortMode: 'modified' })).body).toEqual({
      sortMode: 'modified',
    });

    const trashed = await call('POST', `/api/notes/${id}/trash`, {});
    expect(trashed.body).toMatchObject({ id, inTrash: true, alreadyInTrash: false, folderId });
    expect(trashed.body['deletedAt']).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect((await call('POST', `/api/notes/${id}/trash`, {})).body['alreadyInTrash']).toBe(true);
    expect(
      (await call('POST', `/api/notes/${id}/append`, { markdown: 'x' })).body['error'].code,
    ).toBe('in_trash');
    expect((await call('GET', '/api/notes?title=Plan')).body['notes']).toEqual([]);
    expect((await call('POST', `/api/notes/${id}/restore`, {})).body).toEqual({
      id,
      restored: true,
      folderId,
    });
    expect((await call('DELETE', `/api/folders/${folderId}`)).body).toEqual({
      id: folderId,
      deleted: true,
      inTrash: true,
    });
    expect((await call('DELETE', `/api/folders/${folderId}`)).body['deleted']).toBe(false);
    expect((await call('GET', `/api/notes/${id}/content`)).status).toBe(200);
    expect((await call('GET', '/api/notes/01JBNOPE000000000000000000/content')).status).toBe(404);
    expect((await call('GET', '/api/notes/01JBNOPE000000000000000000/backlinks')).status).toBe(405);
    expect((await call('GET', '/api/history')).body['error'].code).toBe('not_available');
  });

  it('gets the notebook’s own daily note, from its template and with a salted id (A820, A827)', async () => {
    const { call } = await setup();
    const settings = await call('PUT', '/api/settings', {
      set: { 'template.daily': '## Plan\n\n## Log\n' },
      base: { 'template.daily': null },
    });
    expect(settings.body).toMatchObject({
      settings: { 'template.daily': '## Plan\n\n## Log\n' },
      changed: true,
    });
    const day = await call('POST', '/api/daily', { period: 'daily', date: '2026-10-29' });
    expect(day.body).toMatchObject({
      kind: 'daily',
      date: '2026-10-29',
      timeZone: 'America/Chicago',
      created: true,
      headings: ['## Plan', '## Log'],
    });
    expect(day.body['id']).toBe(periodicNoteId('daily', '2026-10-29', NOTEBOOK_ID));
    expect(
      (await call('POST', '/api/daily', { period: 'daily', date: '2026-10-29' })).body['created'],
    ).toBe(false);
    const week = await call('POST', '/api/daily', { period: 'weekly', date: '2026-10-29' });
    expect(week.body).toMatchObject({ kind: 'weekly', week: '2026-W44' });
    const journal = await call('GET', '/api/folders?path=Journal/2026/10');
    expect(journal.body['notes'].map((n: { id: string }) => n.id)).toEqual([day.body['id']]);
  });

  it('keeps only the notebook’s settings, and refuses a change made since its base', async () => {
    const { call } = await setup();
    expect((await call('GET', '/api/settings')).body).toEqual({ settings: {} });
    expect(
      (
        await call('PUT', '/api/settings', {
          set: { 'theme.mode': 'dark' },
          base: { 'theme.mode': null },
        })
      ).body['error'].code,
    ).toBe('setting_not_allowed');
    expect(
      (
        await call('PUT', '/api/settings', {
          set: { timeZone: 'Mars/Base' },
          base: { timeZone: null },
        })
      ).body['error'].code,
    ).toBe('invalid_setting');
    await call('PUT', '/api/settings', {
      set: { timeZone: 'Europe/Paris' },
      base: { timeZone: null },
    });
    const stale = await call('PUT', '/api/settings', {
      set: { timeZone: 'Asia/Tokyo' },
      base: { timeZone: null },
    });
    expect(stale.status).toBe(409);
    expect(stale.body['error'].code).toBe('setting_changed');
  });

  it('searches words only: hybrid falls back with a notice, semantic is refused (A101)', async () => {
    const { call } = await setup();
    await call('POST', '/api/notes', {
      title: 'Proxmox upgrade',
      markdown: 'Upgrade the cluster to 9.1',
      tags: ['homelab'],
      folderId: null,
    });
    await call('POST', '/api/notes', {
      title: 'Shopping',
      markdown: 'Milk and eggs',
      tags: [],
      folderId: null,
    });
    const hybrid = await call('GET', '/api/search?q=cluster&mode=hybrid&limit=10');
    expect(hybrid.body['mode']).toBe('full-text');
    expect(hybrid.body['notice']).toMatch(/words only/);
    expect(hybrid.body['results'].map((r: { title: string }) => r.title)).toEqual([
      'Proxmox upgrade',
    ]);
    expect(hybrid.body['results'][0]!['snippet']).toContain('\u0002cluster\u0003');
    expect(
      (await call('GET', '/api/search?q=cluster&mode=full-text&tag=homelab')).body['results'],
    ).toHaveLength(1);
    expect(
      (await call('GET', '/api/search?q=cluster&mode=full-text&tag=other')).body['results'],
    ).toHaveLength(0);
    const semantic = await call('GET', '/api/search?q=cluster&mode=semantic');
    expect(semantic.status).toBe(422);
    expect(semantic.body['error'].code).toBe('semantic_unavailable');
    expect((await call('GET', '/api/tags')).body).toEqual({
      tags: [{ name: 'homelab', notes: 1 }],
    });
    expect((await call('GET', '/api/tags?tag=homelab')).body['notes']).toHaveLength(1);
    const renamed = await call('POST', '/api/tags/rename', { from: 'homelab', to: 'lab' });
    expect(renamed.status).toBe(202);
    expect(renamed.body['notes']).toHaveLength(1);
    expect((await call('GET', '/api/tags')).body).toEqual({ tags: [{ name: 'lab', notes: 1 }] });
  });

  it('keeps attachments for the next sync, which commits them (A828)', async () => {
    const { call, clone, nb } = await setup();
    const id = (
      await call('POST', '/api/notes', {
        title: 'Pic',
        markdown: '## Photos\n',
        tags: [],
        folderId: null,
      })
    ).body['id'] as string;
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    const data = Buffer.from(png).toString('base64');
    const attached = await call('POST', `/api/notes/${id}/attachments`, {
      name: 'bed.png',
      data,
      alt: 'Bed',
      heading: 'Photos',
    });
    expect(attached.body).toMatchObject({
      id,
      contentType: 'image/png',
      added: true,
      markdown: expect.stringMatching(/^!\[Bed\]\(attachments\/[0-9a-f]{64}\.png\)$/) as string,
    });
    expect(
      (await call('POST', `/api/notes/${id}/attachments`, { name: 'bed.png', data })).body['added'],
    ).toBe(false);
    await clone.engine.sync();
    expect(nb.files()).toContain(attached.body['path']);
  });
});

describe('the local MCP server', () => {
  async function server() {
    const ctx = await setup();
    let saves = 0;
    const mcp = new LocalMcpServer(
      {
        use: async (write, run) => {
          const out = await run(ctx.notebook);
          if (write) saves++;
          return out;
        },
      },
      'work',
    );
    let next = 1;
    const rpc = async (method: string, params?: unknown) => {
      const reply = await mcp.line(
        JSON.stringify({ jsonrpc: '2.0', id: next++, method, ...(params ? { params } : {}) }),
      );
      return JSON.parse(reply!) as { result?: unknown; error?: { code: number; message: string } };
    };
    const tool = async (name: string, args: Record<string, unknown>) =>
      (await rpc('tools/call', { name, arguments: args })).result as ToolResult;
    return { ...ctx, mcp, rpc, tool, saves: () => saves };
  }

  it("lists the remote server's tools and schemas, minus the documented absences", async () => {
    const { rpc } = await server();
    const init = await rpc('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 't', version: '1' },
    });
    expect(init.result).toMatchObject({
      protocolVersion: '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'penmoss-notebook' },
    });
    const { tools } = (await rpc('tools/list')).result as {
      tools: Array<{ name: string; inputSchema: unknown; annotations: unknown }>;
    };
    const remote = [
      ...toolDefinitions({ attachmentMaxBytes: 700 * 1024 }),
      ...commentToolDefinitions(),
    ];
    const expected = remote.filter((tool) => !ABSENT_TOOLS.has(tool.name));
    expect(tools.map((tool) => tool.name)).toEqual(expected.map((tool) => tool.name));
    for (const tool of tools) {
      const same = remote.find((each) => each.name === tool.name)!;
      expect(tool.inputSchema).toEqual(same.inputSchema);
      expect(tool.annotations).toEqual(same.annotations);
    }
    expect(
      remote
        .map((tool) => tool.name)
        .filter((name) => ABSENT_TOOLS.has(name))
        .sort(),
    ).toEqual([]);
    // G6 (A858): the four history tools are here now; T60 (A1064): the five comment tools too.
    expect(localTools().length).toBe(34);
    expect(ABSENT_TOOLS.size).toBe(0);
    expect((await rpc('nope/nope')).error!.code).toBe(-32601);
    for (const name of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      const reply = await rpc('tools/call', { name, arguments: {} });
      expect(reply.error?.message).toBe(`Unknown tool: ${name}`);
    }
    expect(
      await (async () =>
        (await server()).mcp.line('{"jsonrpc":"2.0","method":"notifications/initialized"}'))(),
    ).toBeNull();
  });

  it('shows a drawing as its image link, linked to its scene, and keeps it through edits (PEN-28)', async () => {
    const { tool } = await server();
    const drawing = `[![Drawing](attachments/${'a'.repeat(64)}.svg)](attachments/${'b'.repeat(64)}.excalidraw)`;
    const markdown = `## Sketch\n\n${drawing}\n\n## Notes\n\nDraft\n`;
    const made = await tool('create_note', { title: 'Whiteboard', markdown });
    const id = made.structuredContent.id as string;
    const read = await tool('read_note', { id });
    expect(read.content[1]!.text).toBe(markdown);
    const edited = await tool('replace_text', {
      id,
      find: 'Draft',
      replace: 'Final',
      baseVersion: read.structuredContent.baseVersion,
    });
    expect(edited.isError).toBeUndefined();
    expect((await tool('read_note', { id })).content[1]!.text).toBe(
      `## Sketch\n\n${drawing}\n\n## Notes\n\nFinal\n`,
    );
  });

  it('creates, searches, reads and edits notes, and refuses what it cannot do', async () => {
    const { tool, saves } = await server();
    const made = await tool('create_note', {
      title: 'Standup',
      markdown: '## Notes\n\nShip the CLI\n',
      tags: ['work'],
    });
    expect(made.isError).toBeUndefined();
    expect(made.structuredContent).toMatchObject({ changed: true, created: true });
    const id = made.structuredContent.id as string;
    // A retried identical call returns the same note.
    expect(
      (
        await tool('create_note', {
          title: 'Standup',
          markdown: '## Notes\n\nShip the CLI\n',
          tags: ['work'],
        })
      ).structuredContent,
    ).toMatchObject({ id, created: false });
    const found = await tool('search_notes', { query: 'ship' });
    expect(found.structuredContent).toMatchObject({
      mode: 'full-text',
      results: [{ id, title: 'Standup', snippet: expect.stringContaining('**Ship**') as string }],
    });
    expect((await tool('search_notes', { query: 'ship', mode: 'semantic' })).isError).toBe(true);
    const read = await tool('read_note', { id });
    expect(read.content[1]!.text).toBe('## Notes\n\nShip the CLI\n');
    const base = read.structuredContent.baseVersion as number;
    const updated = await tool('update_section', {
      id,
      heading: 'Notes',
      markdown: 'Shipped',
      baseVersion: base,
    });
    expect(updated.structuredContent).toMatchObject({ id, changed: true });
    const conflict = await tool('replace_text', {
      id,
      find: 'Ship the CLI',
      replace: 'x',
      baseVersion: base,
    });
    expect(conflict.isError).toBe(true);
    expect(conflict.content[0]!.text).toMatch(/conflict|text_not_found/);
    const noBase = await tool('update_section', { id, heading: 'Notes', markdown: 'x' });
    expect(noBase.content[0]!.text).toMatch(
      /^Invalid arguments for update_section: baseVersion is required/,
    );
    // Nothing committed yet: no versions, and the edits made here are unversioned (G6).
    const history = await tool('get_history', { id });
    expect(history.isError).toBeUndefined();
    expect(history.structuredContent).toMatchObject({
      id,
      versions: [],
      unversioned: { authors: ['Agent'] },
    });
    // No slice names, no server-only advice: what an agent reads fits a git notebook.
    for (const [, why] of ABSENT_TOOLS) expect(why).not.toMatch(/\bG\d+\b/);
    const missing = await tool('read_note', { id: '0'.repeat(26) });
    expect(missing.content[0]!.text).toContain('in this git notebook');
    const comments = await tool('list_comment_threads', {});
    expect(comments.structuredContent).toEqual({ status: 'open', threads: [] });
    const daily = await tool('get_daily_note', { date: '2026-10-29' });
    expect(daily.structuredContent).toMatchObject({
      kind: 'daily',
      date: '2026-10-29',
      created: true,
    });
    const backlinks = await tool('get_backlinks', { id });
    expect(backlinks.structuredContent).toMatchObject({ id, title: 'Standup', linked: [] });
    expect(saves()).toBeGreaterThanOrEqual(4);
  });
});
