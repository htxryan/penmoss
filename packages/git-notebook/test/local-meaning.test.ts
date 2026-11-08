/**
 * Search by meaning in a git notebook on this device (T74, A1154–A1156): `LocalNotebook.search`
 * with an embedder, a cache and an index, through the REST route and the MCP tool. A concept
 * embedder makes meaning deterministic: words of one concept land on one axis.
 */
import { parseMarkdown } from '@penmoss/core';
import type { DocJson } from '@penmoss/core/links';
import {
  MeaningIndex,
  MemoryVectorCache,
  chunkKey,
  chunkNote,
  normalize,
  noteSections,
  type Embedder,
} from '@penmoss/core/search';
import { describe, expect, it } from 'vitest';
import {
  LocalMcpServer,
  LocalNotebook,
  coverageNotice,
  localFetch,
  LOCAL_ORIGIN,
} from '../src/local';
import { testNotebook } from './support/notebooks';

const CONCEPTS: Readonly<Record<string, number>> = {
  cluster: 0,
  proxmox: 0,
  server: 0,
  servers: 0,
  upgrade: 0,
  milk: 1,
  eggs: 1,
  groceries: 1,
  shopping: 1,
  list: 1,
};
const embed = (text: string) => {
  const vector = new Float32Array(3);
  for (const word of text.toLowerCase().match(/[a-z]+/g) ?? []) {
    const concept = CONCEPTS[word];
    if (concept !== undefined) vector[concept]! += 1;
  }
  return normalize(vector);
};
const concepts: Embedder = {
  model: 'concepts/3',
  dimensions: 3,
  floor: 0.5,
  embedQuery: (text) => Promise.resolve(embed(text)),
  embedDocuments: (texts) => Promise.resolve(texts.map(embed)),
};

interface Result {
  id: string;
  title: string;
  heading: string | null;
  snippet: string;
  sources: string[];
}

async function setup(budgetMs = 10_000) {
  const nb = testNotebook();
  const clone = await nb.open('Agent', { create: true, kind: 'agent' });
  const notebook = new LocalNotebook(clone.ops, nb.clock);
  const meaning = new MeaningIndex(concepts, new MemoryVectorCache());
  notebook.useMeaning({ index: meaning, budgetMs });
  const fetch = localFetch(notebook, () => undefined);
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${LOCAL_ORIGIN}${path}`, {
      method,
      headers: {},
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return {
      status: response.status,
      body: JSON.parse(await response.text()) as {
        mode: string;
        results: Result[];
        coverage?: { indexed: number; total: number };
        notice?: string;
        id: string;
        error: { code: string };
      },
    };
  };
  const proxmox = await call('POST', '/api/notes', {
    title: 'Proxmox upgrade',
    markdown: 'Upgrade the cluster to 9.1',
    tags: ['homelab'],
    folderId: null,
  });
  const shopping = await call('POST', '/api/notes', {
    title: 'Saturday',
    markdown: 'Some intro.\n\n## Market\n\nMilk and eggs',
    tags: [],
    folderId: null,
  });
  return {
    nb,
    clone,
    notebook,
    meaning,
    call,
    ids: { proxmox: proxmox.body.id, shopping: shopping.body.id },
  };
}

describe('search by meaning in a git notebook (A1156)', () => {
  it('hybrid finds a note by meaning alone, at its best section', async () => {
    const { call, ids } = await setup();
    const found = await call('GET', '/api/search?q=groceries');
    expect(found.body.mode).toBe('hybrid');
    expect(found.body.coverage).toEqual({ indexed: 2, total: 2 });
    expect(found.body.notice).toBeUndefined();
    expect(found.body.results).toEqual([
      expect.objectContaining({
        id: ids.shopping,
        title: 'Saturday',
        heading: 'Market',
        snippet: 'Milk and eggs',
        sources: ['semantic'],
      }),
    ]);
  });

  it('fuses a note found both ways, and keeps unrelated meaning out by the floor', async () => {
    const { call, ids } = await setup();
    const both = await call('GET', '/api/search?q=cluster');
    expect(both.body.results.map((r) => [r.id, r.sources])).toEqual([
      [ids.proxmox, ['full-text', 'semantic']],
    ]);
    expect(both.body.results[0]!.snippet).toContain('\u0002cluster\u0003');
    expect((await call('GET', '/api/search?q=zebra')).body.results).toEqual([]);
  });

  it('answers semantic by meaning, with the filters', async () => {
    const { call, ids } = await setup();
    const semantic = await call('GET', '/api/search?q=servers&mode=semantic');
    expect(semantic.body.mode).toBe('semantic');
    expect(semantic.body.results.map((r) => r.id)).toEqual([ids.proxmox, ids.shopping]);
    const tagged = await call('GET', '/api/search?q=servers&mode=semantic&tag=homelab');
    expect(tagged.body.results.map((r) => r.id)).toEqual([ids.proxmox]);
    expect(
      (await call('GET', '/api/search?q=servers&mode=semantic&limit=1')).body.results,
    ).toHaveLength(1);
    // Full-text stays words only.
    const words = await call('GET', '/api/search?q=groceries&mode=full-text');
    expect(words.body).toMatchObject({ mode: 'full-text', results: [] });
  });

  it('says how far meaning covers while it is indexing, and still answers by words', async () => {
    const { call, ids } = await setup(0);
    const found = await call('GET', '/api/search?q=cluster');
    expect(found.body.coverage).toEqual({ indexed: 0, total: 2 });
    expect(found.body.notice).toBe(coverageNotice({ indexed: 0, total: 2 }));
    expect(found.body.notice).toBe('Meaning covers 0 of 2 notes so far.');
    expect(found.body.results.map((r) => [r.id, r.sources])).toEqual([
      [ids.proxmox, ['full-text']],
    ]);
  });

  it('follows edits and Trash', async () => {
    const { call, notebook, ids } = await setup();
    await call('POST', `/api/notes/${ids.shopping}/trash`);
    expect((await call('GET', '/api/search?q=groceries')).body.results).toEqual([]);
    expect(notebook.meaningNotes().map((n) => n.id)).toEqual([ids.proxmox]);
  });

  it('chunks a note exactly as the page does (A1154)', async () => {
    const { notebook, ids } = await setup();
    const markdown = 'Some intro.\n\n## Market\n\nMilk and eggs';
    const page = chunkNote(
      'Saturday',
      noteSections(parseMarkdown(markdown).doc.toJSON() as DocJson),
    );
    const engine = notebook.meaningNotes().find((n) => n.id === ids.shopping)!;
    const keys = (chunks: ReturnType<typeof chunkNote>) =>
      Promise.all(chunks.map((chunk) => chunkKey(concepts.model, chunk.text)));
    expect(await keys(chunkNote(engine.title, engine.sections))).toEqual(await keys(page));
    expect(page.map((chunk) => chunk.heading)).toEqual([null, 'Market']);
  });

  it('without meaning, behaves as before', async () => {
    const { call, notebook } = await setup();
    notebook.useMeaning(null);
    const hybrid = await call('GET', '/api/search?q=cluster');
    expect(hybrid.body).toMatchObject({
      mode: 'full-text',
      notice: expect.stringMatching(/words only/) as string,
    });
    expect(hybrid.body.coverage).toBeUndefined();
    expect((await call('GET', '/api/search?q=cluster&mode=semantic')).status).toBe(422);
  });
});

describe('the MCP tool with meaning (A1156)', () => {
  async function server(meaning: boolean) {
    const ctx = await setup();
    const mcp = new LocalMcpServer(
      { use: async (_write, run) => await run(ctx.notebook) },
      'work',
      () => undefined,
      {
        meaning,
      },
    );
    let next = 1;
    const rpc = async (method: string, params?: unknown) =>
      JSON.parse(
        (await mcp.line(
          JSON.stringify({ jsonrpc: '2.0', id: next++, method, ...(params ? { params } : {}) }),
        ))!,
      ) as { result: Record<string, unknown> };
    return { ...ctx, rpc };
  }

  it('describes meaning, and answers with the heading, foundBy and coverage', async () => {
    const { rpc, ids } = await server(true);
    const init = await rpc('initialize', { protocolVersion: '2025-06-18' });
    expect(init.result['instructions']).toMatch(/by their words and their meaning/);
    const tools = (await rpc('tools/list')).result['tools'] as Array<{
      name: string;
      description: string;
    }>;
    expect(tools.find((t) => t.name === 'search_notes')!.description).toMatch(
      /"semantic" by meaning alone/,
    );
    const found = await rpc('tools/call', {
      name: 'search_notes',
      arguments: { query: 'groceries' },
    });
    expect(found.result['structuredContent']).toEqual({
      mode: 'hybrid',
      results: [
        expect.objectContaining({ id: ids.shopping, heading: 'Market', foundBy: ['semantic'] }),
      ],
      coverage: { indexed: 2, total: 2 },
    });
  });

  it('keeps the words-only wording where the host has no meaning (the relay)', async () => {
    const { rpc } = await server(false);
    const init = await rpc('initialize', { protocolVersion: '2025-06-18' });
    expect(init.result['instructions']).toMatch(/words only here/);
    const tools = (await rpc('tools/list')).result['tools'] as Array<{
      name: string;
      description: string;
    }>;
    expect(tools.find((t) => t.name === 'search_notes')!.description).toMatch(/no meaning search/);
  });
});
