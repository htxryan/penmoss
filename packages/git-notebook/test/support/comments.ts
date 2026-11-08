/** A Mac and an agent's clone of one notebook, for the comment tools and the channel (T60). */
import {
  anchorForQuote,
  createThread,
  readThread,
  setThreadDelivery,
  type CommentAuthor,
  type CommentTarget,
} from '@penmoss/sync-client/comments';
import { LocalMcpServer, LocalNotebook, type LocalServerPresentation } from '../../src/local';
import type { GitNotebookEngine, NotebookOps } from '../../src';
import { testNotebook } from './notebooks';

/** A `tools/call` result, as the MCP server answers it. */
export interface ToolResult {
  isError?: boolean;
  content: { type: string; text: string }[];
  structuredContent: Record<string, unknown>;
}

/** What the helpers need of a clone: its notes and its sync. */
export interface Clone {
  readonly ops: NotebookOps;
  readonly engine: GitNotebookEngine;
}

export { readAgentSessions } from '@penmoss/sync-client/agent-sessions';

export const RYAN: CommentAuthor = { id: 'device:mac', kind: 'device', label: 'Ryan' };

export async function macAndAgent() {
  const nb = testNotebook();
  const mac = await nb.open('Mac', { create: true });
  await mac.engine.sync();
  const agent = await nb.open('Claude Code', { kind: 'agent' });
  await agent.engine.sync();
  const notebook = new LocalNotebook(agent.ops, nb.clock, undefined, { side: 'mcp' });
  /** The agent's server: every write synced at once, as in channel mode. */
  const serve = (presentation: LocalServerPresentation = {}) => {
    const mcp = new LocalMcpServer(
      {
        use: async (write, run) => {
          const out = await run(notebook);
          if (write) await agent.engine.sync();
          return out;
        },
      },
      'work',
      () => undefined,
      presentation,
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
    return { mcp, rpc, tool };
  };
  /** A note the Mac made and pushed; the agent has it after its next sync. */
  const macNote = async (title: string, markdown: string) => {
    const id = mac.ops.createNote({ title, markdown });
    await mac.engine.sync();
    await agent.engine.sync();
    return id;
  };
  return { nb, mac, agent, notebook, serve, macNote };
}

/**
 * Ryan's thread on the Mac, sent to `target` with delivery `waiting` (what Send to writes,
 * A1061), and pushed at once.
 */
export async function sendFromMac(
  mac: Clone,
  noteId: string,
  quote: string,
  target: CommentTarget,
  options: { readonly id?: string; readonly body?: string; readonly at?: number } = {},
): Promise<{ threadId: string; commentId: string }> {
  const doc = mac.ops.note(noteId)!;
  const match = anchorForQuote(doc, quote);
  if ('error' in match) throw new Error(`no ${quote}`);
  const threadId = options.id ?? `t${Math.random().toString(36).slice(2, 10)}`;
  const commentId = `${threadId}c1`;
  const at = options.at ?? Date.UTC(2026, 10, 4, 12);
  createThread(doc, {
    id: threadId,
    anchor: match.anchor,
    quote: match.quote,
    author: RYAN,
    at,
    comment: { id: commentId, body: options.body ?? 'make this tighter' },
    target,
  });
  setThreadDelivery(doc, threadId, { state: 'waiting', commentId, session: target.session, at });
  await mac.engine.sync();
  return { threadId, commentId };
}

export const deliveryOn = (clone: Clone, noteId: string, threadId: string) =>
  readThread(clone.ops.note(noteId)!, threadId)?.delivery?.state;
