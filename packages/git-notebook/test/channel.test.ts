/**
 * The channel of `penmoss mcp --channel` (T60, A1060–A1063, A1066) over an in-memory remote: a
 * Mac sends a thread to the session (target and `waiting`, pushed), the channel notices the new
 * head within one tick, notifies Claude Code once and writes `sent`; reading marks it seen and
 * replying replied, which the Mac sees after its sync. A note in Trash holds its comments, and a
 * restarted channel sends nothing again.
 */
import { offeredSessions, readAgentSession } from '@penmoss/sync-client/agent-sessions';
import { addComment, readThread, setThreadDelivery } from '@penmoss/sync-client/comments';
import { describe, expect, it } from 'vitest';
import { CHANNEL_METHOD, CommentChannel, LocalNotebook, type ChannelHost } from '../src/local';
import { deliveryOn, macAndAgent, RYAN, sendFromMac } from './support/comments';
import type { TestClone } from './support/notebooks';

const NAME = 'mac:/Users/ryan/src/penmoss';
const LABEL = 'Claude Code · penmoss';

function channelOn(agent: TestClone, notebook: LocalNotebook, clock: () => number) {
  const notified: Array<Record<string, unknown>> = [];
  let syncs = 0;
  const host: ChannelHost = {
    use: async (write, run) => {
      const out = await run(notebook);
      // Channel mode pushes the clone's own writes at once.
      if (write) await agent.engine.sync();
      return out;
    },
    remoteHead: () => agent.transport.remoteHead(),
    sync: async () => {
      syncs++;
      return agent.engine.sync();
    },
    notify: (message) => notified.push(message),
  };
  const channel = new CommentChannel(host, { name: NAME, label: LABEL, host: 'mac', clock });
  return { channel, notified, syncs: () => syncs };
}

describe('the channel (A1063)', () => {
  it('lists the session, notices a Send to within one tick, notifies once and writes sent; then seen and replied reach the Mac', async () => {
    const { nb, mac, agent, notebook, serve, macNote } = await macAndAgent();
    const { channel, notified, syncs } = channelOn(agent, notebook, nb.clock);
    const session = (await channel.heartbeat())!;
    expect(session).toMatchObject({ writer: notebook.writerId, name: NAME, label: LABEL });
    expect(channel.key).toMatch(/^[0-9a-f]{24}$/);
    // The Mac's Send to… offers it once the Mac pulls.
    const id = await macNote('Garden', 'We should plant the garden in spring.\n');
    expect(offeredSessions(mac.engine.replica.workspace, nb.clock()).map((s) => s.key)).toEqual([
      channel.key,
    ]);
    // Nothing goes before Claude Code said it is ready.
    channel.start();
    expect(await channel.tick()).toBe(0);
    expect(notified).toEqual([]);

    // A quiet tick asks for the head and does not fetch.
    const fetches = agent.transport.stats.fetches;
    const before = syncs();
    expect(await channel.tick()).toBe(0);
    expect(agent.transport.stats.fetches).toBe(fetches);
    expect(syncs()).toBe(before);
    expect(agent.transport.stats.heads).toBeGreaterThan(0);

    const target = { writer: session.writer, session: session.key, label: LABEL };
    const sent = await sendFromMac(mac, id, 'plant the garden', target, { body: 'Which month?' });
    expect(await channel.tick()).toBe(1);
    expect(syncs()).toBe(before + 1);
    expect(notified).toEqual([
      {
        jsonrpc: '2.0',
        method: CHANNEL_METHOD,
        params: {
          content:
            'Ryan commented on the note “Garden”.\n\nOn this text:\n> plant the garden\n\nComment:\nWhich month?',
          meta: { thread_id: sent.threadId, note_id: id, comment_id: sent.commentId },
        },
      },
    ]);
    expect(deliveryOn(agent, id, sent.threadId)).toBe('sent');
    await mac.engine.sync();
    expect(deliveryOn(mac, id, sent.threadId)).toBe('sent');
    // Once.
    expect(await channel.tick()).toBe(0);
    expect(notified).toHaveLength(1);

    // Claude reads the thread (seen) and answers (replied), each pushed at once.
    const { tool } = serve();
    await tool('read_comment_thread', { id, threadId: sent.threadId });
    await mac.engine.sync();
    expect(deliveryOn(mac, id, sent.threadId)).toBe('seen');
    await tool('reply_to_comment_thread', { id, threadId: sent.threadId, body: 'May.' });
    await mac.engine.sync();
    expect(deliveryOn(mac, id, sent.threadId)).toBe('replied');
    expect(readThread(mac.ops.note(id)!, sent.threadId)!.comments.map((c) => c.body)).toEqual([
      'Which month?',
      'May.',
    ]);
    // Its own writes are not delivered to itself.
    expect(await channel.tick()).toBe(0);

    // Ryan answers back: that comment is due, the earlier ones are not.
    const doc = mac.ops.note(id)!;
    addComment(doc, sent.threadId, { id: 'r2', author: RYAN, body: 'Thanks!', at: nb.clock() });
    setThreadDelivery(doc, sent.threadId, {
      state: 'waiting',
      commentId: 'r2',
      session: session.key,
      at: nb.clock(),
    });
    await mac.engine.sync();
    expect(await channel.tick()).toBe(1);
    expect(notified.at(-1)).toMatchObject({ params: { meta: { comment_id: 'r2' } } });
  });

  it('holds a thread in Trash and sends it once the note is restored', async () => {
    const { nb, mac, agent, notebook, macNote } = await macAndAgent();
    const { channel, notified } = channelOn(agent, notebook, nb.clock);
    const session = (await channel.heartbeat())!;
    channel.start();
    const id = await macNote('Trash and back', 'Trash and back.\n');
    const target = { writer: session.writer, session: session.key, label: LABEL };
    const sent = await sendFromMac(mac, id, 'Trash', target);
    mac.ops.trash(id);
    await mac.engine.sync();
    expect(await channel.tick()).toBe(0);
    expect(notified).toEqual([]);
    expect(deliveryOn(agent, id, sent.threadId)).toBe('waiting');
    // Still held on the next tick, though nothing changed.
    expect(await channel.tick()).toBe(0);
    mac.ops.restore(id);
    await mac.engine.sync();
    expect(await channel.tick()).toBe(1);
    expect(notified[0]).toMatchObject({ params: { meta: { thread_id: sent.threadId } } });
    expect(deliveryOn(agent, id, sent.threadId)).toBe('sent');
  });

  it('sends nothing again after a restart, and keeps its session and startedAt', async () => {
    const { nb, mac, agent, notebook, macNote } = await macAndAgent();
    const first = channelOn(agent, notebook, nb.clock);
    const session = (await first.channel.heartbeat())!;
    first.channel.start();
    const id = await macNote('Once', 'Only once.\n');
    const target = { writer: session.writer, session: session.key, label: LABEL };
    await sendFromMac(mac, id, 'Only once', target);
    expect(await first.channel.tick()).toBe(1);
    await agent.engine.save();

    // The process ends; a new one opens the same clone (its storage and writer secret).
    nb.tick(60_000);
    const again = await nb.open('Claude Code', {
      kind: 'agent',
      storage: agent.storage,
      secrets: agent.secrets,
      transport: agent.transport,
    });
    const reopened = new LocalNotebook(again.ops, nb.clock, undefined, { side: 'mcp' });
    expect(reopened.writerId).toBe(session.writer);
    const second = channelOn(again, reopened, nb.clock);
    const restarted = (await second.channel.heartbeat())!;
    expect(restarted.key).toBe(session.key);
    second.channel.start();
    expect(await second.channel.tick()).toBe(0);
    expect(second.notified).toEqual([]);
    await mac.engine.sync();
    expect(readAgentSession(mac.engine.replica.workspace, session.key)).toMatchObject({
      startedAt: session.lastSeen,
      lastSeen: session.lastSeen + 60_000,
    });
  });

  it('declares the claude/channel capability only in channel mode, and hears initialized', async () => {
    const { serve } = await macAndAgent();
    let ready = 0;
    const channel = serve({ channel: true, onInitialized: () => ready++ });
    const init = (await channel.rpc('initialize', { protocolVersion: '2025-06-18' })).result as {
      capabilities: Record<string, unknown>;
    };
    expect(init.capabilities).toEqual({
      tools: { listChanged: false },
      experimental: { 'claude/channel': {} },
    });
    expect(
      await channel.mcp.line('{"jsonrpc":"2.0","method":"notifications/initialized"}'),
    ).toBeNull();
    expect(ready).toBe(1);
    const plain = (await serve().rpc('initialize', {})).result as {
      capabilities: Record<string, unknown>;
    };
    expect(plain.capabilities).toEqual({ tools: { listChanged: false } });
  });
});
