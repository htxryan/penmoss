/**
 * Which agent session made an edit (PEN-152, A1583): the MCP server takes the client from
 * `initialize` and the session from the request or Claude Code's environment, the commit names
 * them in `Penmoss-Session` trailers, and History labels the edit with them.
 */
import { describe, expect, it } from 'vitest';
import {
  callSession,
  clientName,
  commitMessage,
  commitSessions,
  NotebookHistory,
  sessionLabel,
  sessionTrailers,
} from '../src';
import { commitSessionsOf } from '../src/engine/build';
import { LocalMcpServer, LocalNotebook } from '../src/local';
import { testNotebook } from './support/notebooks';

const NOTE_A = '01JBNOTE00000000000000000A';
const NOTE_B = '01JBNOTE00000000000000000B';
const WRITER = { id: '01JBWRITER0000000000000001', kind: 'agent' as const, label: 'Agent' };

describe('the session of a call (A1583)', () => {
  const claude = { name: 'claude-code', version: '2.1.0' };
  const codex = { name: 'codex-mcp-client', title: 'Codex', version: '0.130.0' };

  it('names the client by its product name', () => {
    expect(clientName(claude)).toBe('Claude Code');
    expect(clientName(codex)).toBe('Codex');
    expect(clientName({ name: 'cursor-vscode', title: 'Cursor' })).toBe('Cursor');
    expect(clientName({ name: 'zed' })).toBe('zed');
    expect(clientName(null)).toBe('Agent');
  });

  it("takes Codex's thread id from the request", () => {
    const thread = '019a8c3e-7f10-7c21-b6aa-1f0e5d2c9b44';
    expect(
      callSession({ clientInfo: codex, meta: { threadId: thread }, env: {}, own: 'penmoss-x' }),
    ).toEqual({ client: 'Codex', session: thread, own: false });
    expect(
      callSession({
        clientInfo: codex,
        meta: { 'x-codex-turn-metadata': { session_id: thread, turn_id: 't1' } },
        env: {},
        own: 'penmoss-x',
      }),
    ).toEqual({ client: 'Codex', session: thread, own: false });
  });

  it("takes Claude Code's session from the environment, only for Claude Code", () => {
    const env = { CLAUDE_CODE_SESSION_ID: '7736c5e9-49e6-4c1b-8dca-a28bd1e13d07' };
    expect(callSession({ clientInfo: claude, meta: null, env, own: 'penmoss-x' })).toEqual({
      client: 'Claude Code',
      session: '7736c5e9-49e6-4c1b-8dca-a28bd1e13d07',
      own: false,
    });
    // Codex started from a Claude Code session inherits its environment: that is not its id.
    expect(callSession({ clientInfo: codex, meta: null, env, own: 'penmoss-x' })).toEqual({
      client: 'Codex',
      session: 'penmoss-x',
      own: true,
    });
  });

  it("falls back to the server's own id, and never lets an id break a trailer", () => {
    expect(callSession({ clientInfo: null, meta: {}, env: {}, own: 'penmoss-01J' })).toEqual({
      client: 'Agent',
      session: 'penmoss-01J',
      own: true,
    });
    const odd = callSession({
      clientInfo: codex,
      meta: { threadId: 'a b"c\nd' },
      env: {},
      own: 'penmoss-x',
    });
    expect(odd.session).toBe('abcd');
  });
});

describe('Penmoss-Session trailers', () => {
  it('round-trips the sessions a commit names', () => {
    const sessions = [
      { client: 'Claude Code', session: '7736c5e9-49e6', own: false, notes: [NOTE_A, NOTE_B] },
      { client: 'Agent', session: 'penmoss-01JBX', own: true, notes: [] },
    ];
    const message = commitMessage(2, WRITER, sessions);
    expect(message).toBe(
      [
        'Penmoss: 2 notes [skip ci]',
        '',
        `Penmoss-Writer: ${WRITER.id} (agent "Agent")`,
        `Penmoss-Session: 7736c5e9-49e6 "Claude Code" ${NOTE_A} ${NOTE_B}`,
        'Penmoss-Session: penmoss-01JBX "Agent" own',
        '',
      ].join('\n'),
    );
    expect(commitSessions(message)).toEqual(sessions);
    expect(sessionTrailers([])).toEqual([]);
    expect(commitMessage(1, WRITER)).toBe(
      `Penmoss: 1 note [skip ci]\n\nPenmoss-Writer: ${WRITER.id} (agent "Agent")\n`,
    );
  });

  it('names only the sessions whose edits the commit carries', () => {
    const recorded = {
      a: { client: 'Codex', session: 's1', own: false, notes: { [NOTE_A]: 1 }, workspace: false },
      b: { client: 'Codex', session: 's2', own: false, notes: { [NOTE_B]: 2 }, workspace: false },
      c: { client: 'Codex', session: 's3', own: false, notes: {}, workspace: true },
    };
    expect(commitSessionsOf(recorded, new Set([NOTE_A]), false)).toEqual([
      { client: 'Codex', session: 's1', own: false, notes: [NOTE_A] },
    ]);
    expect(commitSessionsOf(recorded, new Set(), true).map((s) => s.session)).toEqual(['s3']);
  });

  it('labels a session by its client and the start of its id', () => {
    expect(sessionLabel({ client: 'Claude Code', session: '7736c5e9-49e6-4c1b', own: false })).toBe(
      'Claude Code · 7736c5e9',
    );
    expect(sessionLabel({ client: 'Zed', session: 'penmoss-01JBXYZABCDEFGH', own: true })).toBe(
      'Zed · ABCDEFGH (Penmoss’s id)',
    );
  });
});

describe('an MCP edit names its session in History (PEN-152)', () => {
  async function server(env: Record<string, string>) {
    const nb = testNotebook();
    const mac = await nb.open('Mac', { create: true });
    await mac.engine.sync();
    const agent = await nb.open('Agent', { kind: 'agent' });
    await agent.engine.sync();
    const notebook = new LocalNotebook(agent.ops, nb.clock);
    const mcp = new LocalMcpServer(
      { use: async (_write, run) => run(notebook) },
      'Work',
      () => {},
      { env },
    );
    let next = 1;
    const rpc = async (method: string, params: unknown) => {
      const reply = await mcp.line(JSON.stringify({ jsonrpc: '2.0', id: next++, method, params }));
      return (JSON.parse(reply!) as { result: { structuredContent: Record<string, unknown> } })
        .result;
    };
    return { nb, mac, agent, rpc };
  }

  it("labels Claude Code's edit with its session, and keeps each session's notes apart", async () => {
    const { nb, mac, agent, rpc } = await server({
      CLAUDE_CODE_SESSION_ID: '7736c5e9-49e6-4c1b-8dca-a28bd1e13d07',
    });
    await rpc('initialize', {
      protocolVersion: '2025-11-25',
      clientInfo: { name: 'claude-code', version: '2.1.0' },
    });
    const made = await rpc('tools/call', {
      name: 'create_note',
      arguments: { title: 'Plan', markdown: 'from Claude' },
    });
    const id = made.structuredContent['id'] as string;
    // A second session on the same server: its request names it.
    const other = await rpc('tools/call', {
      name: 'create_note',
      arguments: { title: 'Other', markdown: 'from another session' },
      _meta: { threadId: 'thread-2' },
    });
    const otherId = other.structuredContent['id'] as string;
    expect(Object.keys(agent.engine.replica.state.sessions)).toHaveLength(2);
    await agent.engine.sync();
    // Synced: nothing is left to name.
    expect(agent.engine.replica.state.sessions).toEqual({});
    nb.tick();
    await mac.engine.sync();

    const history = new NotebookHistory(mac.engine.transport, mac.engine.layout);
    const plan = (await history.versions(id)).versions[0]!;
    expect(plan.reason).toBe('edit');
    expect(plan.authors).toEqual([
      expect.objectContaining({
        kind: 'agent',
        label: 'Claude Code · 7736c5e9',
        session: { client: 'Claude Code', id: '7736c5e9-49e6-4c1b-8dca-a28bd1e13d07', own: false },
      }),
    ]);
    const second = (await history.versions(otherId)).versions[0]!;
    expect(second.authors.map((a) => a.label)).toEqual(['Claude Code · thread-2']);
  });

  it("names a client that gives no session by the server's own id", async () => {
    const { nb, mac, agent, rpc } = await server({});
    await rpc('initialize', {
      protocolVersion: '2025-11-25',
      clientInfo: { name: 'zed', version: '1.0' },
    });
    const made = await rpc('tools/call', {
      name: 'create_note',
      arguments: { title: 'Plan', markdown: 'x' },
    });
    await agent.engine.sync();
    nb.tick();
    await mac.engine.sync();
    const history = new NotebookHistory(mac.engine.transport, mac.engine.layout);
    const [version] = (await history.versions(made.structuredContent['id'] as string)).versions;
    expect(version!.authors[0]!.label).toMatch(/^zed · [0-9A-Z]{8} \(Penmoss’s id\)$/);
  });
});
