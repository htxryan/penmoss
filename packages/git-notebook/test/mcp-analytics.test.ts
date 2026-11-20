/**
 * The local MCP server's usage analytics hook (PEN-137, AC21): each tool call is told to the
 * host's `onToolCall` with the tool's name, the agent from a fixed list, how it ended and how
 * long it took. Never its arguments or what it answered; and every tool the server has is in the
 * analytics catalogue.
 */
import { notebookTag } from '@penmoss/core/note-ref';
import { AGENT_CLIENTS, isCatalogued, TOOL_NAMES } from '@penmoss/core/analytics';
import { describe, expect, it } from 'vitest';
import {
  LocalMcpServer,
  LocalNotebook,
  localTools,
  refusalResult,
  type NotebookSet,
  type ToolCallRecord,
} from '../src/local';
import { testNotebook } from './support/notebooks';

const CANARY = 'slothcanary';

async function single(clientName?: string) {
  const nb = testNotebook();
  const clone = await nb.open('Agent', { create: true, kind: 'agent' });
  const notebook = new LocalNotebook(clone.ops, nb.clock);
  const calls: ToolCallRecord[] = [];
  const mcp = new LocalMcpServer({ use: async (_write, run) => run(notebook) }, 'Work', () => {}, {
    onToolCall: (call) => calls.push(call),
  });
  let next = 1;
  const rpc = async (method: string, params: unknown): Promise<unknown> =>
    JSON.parse((await mcp.line(JSON.stringify({ jsonrpc: '2.0', id: next++, method, params })))!);
  if (clientName !== undefined) {
    await rpc('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: clientName, version: '1' },
    });
  }
  const tool = (name: string, args: Record<string, unknown>) =>
    rpc('tools/call', { name, arguments: args }) as Promise<{
      result?: { isError?: boolean; structuredContent?: { id?: string } };
    }>;
  return { calls, tool, rpc };
}

describe('the local MCP server tells its host of each tool call (PEN-137)', () => {
  it('names the tool, the agent, the result and a duration, never the arguments', async () => {
    const { calls, tool } = await single('claude-code');
    const made = await tool('create_note', {
      title: `Zebra${CANARY} Title`,
      markdown: `pangolin${CANARY} body`,
    });
    const id = made.result!.structuredContent!.id!;
    await tool('search_notes', { query: CANARY });
    await tool('read_note', { id });
    expect(calls.map((call) => [call.tool, call.agentClient, call.result])).toEqual([
      ['create_note', 'claude-code', 'ok'],
      ['search_notes', 'claude-code', 'ok'],
      ['read_note', 'claude-code', 'ok'],
    ]);
    for (const call of calls) {
      expect(Object.keys(call).sort()).toEqual(['agentClient', 'result', 'tookMs', 'tool']);
      expect(call.tookMs).toBeGreaterThanOrEqual(0);
    }
    expect(JSON.stringify(calls).toLowerCase()).not.toContain(CANARY);
  });

  it('maps how a call ended: invalid, notFound, conflict', async () => {
    const { calls, tool } = await single('Cursor');
    await tool('read_note', {});
    await tool('read_note', { id: '01JQ7M1WQ3R4ZK3V8N2C5D6E7Z' });
    const made = await tool('create_note', { title: 'Plan', markdown: 'one' });
    const id = made.result!.structuredContent!.id!;
    await tool('replace_text', { id, baseVersion: 999, find: 'one', replace: 'two' });
    expect(calls.map((call) => [call.tool, call.agentClient, call.result])).toEqual([
      ['read_note', 'cursor', 'invalid'],
      ['read_note', 'cursor', 'notFound'],
      ['create_note', 'cursor', 'ok'],
      ['replace_text', 'cursor', 'conflict'],
    ]);
  });

  it('maps any client name to the fixed list, and none to other', async () => {
    for (const [name, expected] of [
      ['claude-code', 'claude-code'],
      ['Claude Desktop', 'claude-desktop'],
      ['codex-mcp-client', 'codex'],
      ['Visual Studio Code', 'vscode'],
      [`my-${CANARY}-agent`, 'other'],
    ] as const) {
      const { calls, tool } = await single(name);
      await tool('list_tags', {});
      expect(calls[0]!.agentClient).toBe(expected);
      expect(AGENT_CLIENTS).toContain(calls[0]!.agentClient);
    }
    const { calls, tool } = await single();
    await tool('list_tags', {});
    expect(calls[0]!.agentClient).toBe('other');
  });

  it('a call that throws is failed, and a hook that throws changes no answer', async () => {
    const nb = testNotebook();
    const clone = await nb.open('Agent', { create: true, kind: 'agent' });
    const notebook = new LocalNotebook(clone.ops, nb.clock);
    const calls: ToolCallRecord[] = [];
    let broken = true;
    const mcp = new LocalMcpServer(
      {
        use: async (_write, run) => {
          if (broken) throw new Error('disk on fire');
          return run(notebook);
        },
      },
      'Work',
      () => {},
      {
        onToolCall: (call) => {
          calls.push(call);
          throw new Error('analytics broke');
        },
      },
    );
    const call = async () =>
      JSON.parse(
        (await mcp.line(
          JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: { name: 'list_tags', arguments: {} },
          }),
        ))!,
      ) as { result: { isError?: boolean } };
    expect((await call()).result.isError).toBe(true);
    broken = false;
    expect((await call()).result.isError).toBeUndefined();
    expect(calls.map((each) => each.result)).toEqual(['failed', 'ok']);
  });

  it('over several notebooks: a notebook not served is notFound, a missing one invalid', async () => {
    const books = new Map<string, LocalNotebook>();
    for (const [index, name] of ['Personal', 'Work'].entries()) {
      const nb = testNotebook({ id: `01JBNOTEBOOK00000000000P0${index}`, name, firstId: index });
      const clone = await nb.open('Agent', { create: true, kind: 'agent' });
      books.set(name, new LocalNotebook(clone.ops, nb.clock));
    }
    const set: NotebookSet = {
      notebooks: () =>
        [...books].map(([name, notebook]) => ({ name, tag: notebookTag(notebook.notebookId!) })),
      use: async (name, _write, run) => run(books.get(name)!),
    };
    const calls: ToolCallRecord[] = [];
    const mcp = new LocalMcpServer(set, 'penmoss', () => {}, {
      onToolCall: (call) => calls.push(call),
    });
    let next = 1;
    const tool = (name: string, args: Record<string, unknown>) =>
      mcp.line(
        JSON.stringify({
          jsonrpc: '2.0',
          id: next++,
          method: 'tools/call',
          params: { name, arguments: args },
        }),
      );
    await tool('create_note', { notebook: `Wombat${CANARY}`, title: 'x' });
    await tool('create_note', { title: 'x' });
    await tool('create_note', { notebook: 'Work', title: `Zebra${CANARY}` });
    await tool('search_notes', { query: CANARY });
    expect(calls.map((call) => [call.tool, call.result])).toEqual([
      ['create_note', 'notFound'],
      ['create_note', 'invalid'],
      ['create_note', 'ok'],
      ['search_notes', 'ok'],
    ]);
    expect(JSON.stringify(calls).toLowerCase()).not.toContain(CANARY);
  });

  it('a refusal’s status and code map to a result', () => {
    expect(refusalResult(404, 'note_not_found')).toBe('notFound');
    expect(refusalResult(400, 'heading_not_found')).toBe('notFound');
    expect(refusalResult(409, 'version_conflict')).toBe('conflict');
    expect(refusalResult(422, 'unsupported_markdown')).toBe('invalid');
    expect(refusalResult(500, 'internal')).toBe('failed');
  });

  it('every tool the local server has is in the analytics catalogue', () => {
    const names = localTools().map((tool) => tool.name);
    expect(names.length).toBeGreaterThan(20);
    for (const name of names) expect(isCatalogued('tool', name), name).toBe(true);
    expect(TOOL_NAMES.length).toBeGreaterThanOrEqual(names.length);
  });
});

describe('the local MCP server has no window (PEN-174)', () => {
  it('tells its host only of tool calls, by a tool’s name: never a window or a layout', async () => {
    const { calls, tool } = await single('codex');
    await tool('list_tags', {});
    await tool('search_notes', { query: 'anything' });
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(Object.keys(call).sort()).toEqual(['agentClient', 'result', 'tookMs', 'tool']);
      expect(isCatalogued('tool', call.tool)).toBe(true);
      expect(['window', 'layout']).not.toContain(call.tool);
    }
  });
});
