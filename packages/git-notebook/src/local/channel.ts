/**
 * The channel of `penmoss mcp --channel` (T60, D50, A1063): comments Ryan sends from the apps
 * to this Claude Code session, through the notebook's repository and no server.
 *
 * - The session is this clone's writer plus a name (A1060). `heartbeat()` writes its entry in the
 *   WorkspaceDoc's `agentSessions` at start and every HEARTBEAT_MS, so Send to… offers it.
 * - `tick()` (every CHANNEL_CHECK_MS) asks the remote for the branch head (`remoteHead`, an
 *   `ls-remote`) and syncs when it moved; then, once the client said `notifications/initialized`
 *   (`start()`), it sends each comment due to this session (`dueComments`, A1066) as
 *   `notifications/claude/channel` with the old channel's content and meta (`deliveryPayload`),
 *   and writes `sent` for the newest one of each thread. A note in Trash holds its comments.
 *
 * Nothing here has a timer: the host runs `tick` and `heartbeat` on its own clock (tests call
 * them). Every read and write goes through the host's `use`, under the clone's lock; the host
 * saves and pushes writes (at once, in channel mode).
 */
import {
  HEARTBEAT_MS,
  recordAgentSession,
  sessionKey,
  type AgentSession,
} from '@penmoss/sync-client/agent-sessions';
import {
  readThread,
  readThreads,
  setThreadDelivery,
  type CommentDelivery,
} from '@penmoss/sync-client/comments';
import {
  deliveryAdvances,
  deliveryPayload,
  dueComments,
  type DeliveryPayload,
} from '@penmoss/sync-client/comment-delivery';
import { isDeleted, readTitle } from '@penmoss/sync-client/note';
import { readWorkspace } from '@penmoss/sync-client/workspace';
import { isPurged } from '../purge';
import type { NotebookAccess } from './mcp';
import type { LocalNotebook } from './notebook';

/** How often the channel asks the remote whether its head moved (A1063). */
export const CHANNEL_CHECK_MS = 10_000;
export { HEARTBEAT_MS };
/** The longest session name (the old hub's). */
export const MAX_SESSION_NAME = 200;
/** Claude Code's channel notification (the channels reference). */
export const CHANNEL_METHOD = 'notifications/claude/channel';

export interface ChannelHost {
  /** The notebook under the clone's lock; a write is saved and pushed after. */
  readonly use: NotebookAccess['use'];
  /** The branch's head at the remote now (`GitTransport.remoteHead`); throws when unreachable. */
  remoteHead(): Promise<string | null>;
  /** Syncs the clone (fetch, apply, commit and push what is left). */
  sync(why: string): Promise<unknown>;
  /** Writes one JSON-RPC message to Claude Code (a line of stdout). */
  notify(message: Record<string, unknown>): void;
  log?(text: string): void;
}

export interface ChannelOptions {
  /** `--name`: the session's name, `<host>:<cwd>` by default. */
  readonly name: string;
  /** What Send to… shows, e.g. "Claude Code · penmoss". */
  readonly label: string;
  /** This machine's name. */
  readonly host: string;
  readonly clock?: () => number;
}

/** A channel notification as Claude Code takes it: identifier keys and string values in meta. */
export function channelNotification(payload: DeliveryPayload): Record<string, unknown> {
  return {
    jsonrpc: '2.0',
    method: CHANNEL_METHOD,
    params: {
      content: payload.content,
      // Identifier keys and string values only: Claude Code drops anything else (the docs).
      meta: Object.fromEntries(
        Object.entries(payload.meta).filter(
          (entry): entry is [string, string] =>
            /^[A-Za-z0-9_]+$/.test(entry[0]) && typeof entry[1] === 'string',
        ),
      ),
    },
  };
}

interface Due {
  readonly noteId: string;
  readonly threadId: string;
  readonly payloads: readonly DeliveryPayload[];
}

export class CommentChannel {
  private session: { readonly key: string; readonly writer: string } | null = null;
  private ready = false;
  private stopped = false;
  private unreachable = false;
  /** Comments this process wrote to Claude Code: never twice, even before `sent` is saved. */
  private readonly written = new Set<string>();
  /** Each note's rev when it was last looked through: unchanged notes are skipped. */
  private readonly scanned = new Map<string, number>();
  /** Notes in Trash with comments due: looked at again on every tick (A774: Trash holds). */
  private readonly held = new Set<string>();
  private running: Promise<number> | null = null;
  private readonly clock: () => number;

  constructor(
    private readonly host: ChannelHost,
    private readonly options: ChannelOptions,
  ) {
    this.clock = options.clock ?? Date.now;
  }

  /** The session's key once its entry is written (null before: the writer is not known yet). */
  get key(): string | null {
    return this.session?.key ?? null;
  }

  /**
   * Writes the session's `agentSessions` entry (at start and every HEARTBEAT_MS, A1060). Null
   * while the clone has no writer yet (before its first sync); the next tick tries again.
   */
  async heartbeat(): Promise<AgentSession | null> {
    const writer = await this.host.use(false, (notebook) => notebook.writerId);
    if (!writer) return null;
    const key = await sessionKey(writer, this.options.name);
    const entry = {
      key,
      writer,
      label: this.options.label,
      name: this.options.name,
      host: this.options.host,
      lastSeen: this.clock(),
    };
    await this.host.use(true, (notebook) => {
      recordAgentSession(notebook.ops.workspace, entry);
    });
    if (this.session?.key !== key) {
      // A new writer (a retired one, A850) is a new session: look through every note again.
      this.scanned.clear();
      this.host.log?.(`penmoss: comments sent to “${this.options.label}” arrive here`);
    }
    this.session = { key, writer };
    return { ...entry, startedAt: entry.lastSeen };
  }

  /** The client is ready (`notifications/initialized`): delivery may start. */
  start(): void {
    this.ready = true;
  }

  /** The server is stopping: a tick in hand does nothing more, and no new one starts. */
  stop(): void {
    this.stopped = true;
  }

  /** One check: sync when the remote's head moved, then send what is due. Never two at once. */
  tick(): Promise<number> {
    if (this.stopped) return Promise.resolve(0);
    this.running ??= this.check().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async check(): Promise<number> {
    let head: string | null | undefined;
    try {
      head = await this.host.remoteHead();
      this.unreachable = false;
    } catch (error) {
      // Said once until the remote answers again, not every 10 s.
      if (!this.unreachable) {
        this.host.log?.(
          `penmoss: could not ask the remote for its head: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      this.unreachable = true;
    }
    if (this.stopped) return 0;
    if (head !== undefined) {
      const synced = await this.host.use(
        false,
        (notebook) => notebook.engine.replica.state.lastHead,
      );
      if (head !== synced && !this.stopped) await this.host.sync('channel');
    }
    if (this.stopped) return 0;
    if (!this.session) await this.heartbeat();
    if (!this.ready || !this.session || this.stopped) return 0;
    return this.deliver(this.session.key);
  }

  /** Sends every comment due to `key` and writes `sent`; returns how many went. */
  private async deliver(key: string): Promise<number> {
    const due = await this.host.use(false, (notebook) => this.collect(notebook, key));
    if (due.length === 0) return 0;
    const sent: Array<{ noteId: string; threadId: string; commentId: string }> = [];
    let count = 0;
    for (const each of due) {
      for (const payload of each.payloads) {
        const once = `${key}:${payload.meta.comment_id}`;
        if (!this.written.has(once)) {
          this.host.notify(channelNotification(payload));
          this.written.add(once);
          count++;
        }
      }
      const newest = each.payloads.at(-1)!;
      sent.push({
        noteId: each.noteId,
        threadId: each.threadId,
        commentId: newest.meta.comment_id,
      });
    }
    // Written to Claude Code (which acknowledges nothing): the comments are sent (A774, A1061).
    await this.host.use(true, (notebook) => {
      for (const { noteId, threadId, commentId } of sent) {
        const doc = notebook.ops.note(noteId);
        const thread = doc ? readThread(doc, threadId) : null;
        if (!doc || !thread || thread.target?.session !== key) continue;
        const next: CommentDelivery = {
          state: 'sent',
          commentId,
          session: key,
          at: this.clock(),
        };
        if (deliveryAdvances(thread.delivery, next)) setThreadDelivery(doc, threadId, next);
      }
    });
    return count;
  }

  /** The comments due to `key`, by thread, from the notes that changed since last looked at. */
  private collect(notebook: LocalNotebook, key: string): Due[] {
    const out: Due[] = [];
    const workspace = notebook.ops.workspace;
    for (const entry of readWorkspace(workspace).notes) {
      const noteId = entry.id;
      const rev = notebook.engine.replica.rev(noteId);
      if (this.scanned.get(noteId) === rev && !this.held.has(noteId)) continue;
      const doc = notebook.ops.note(noteId);
      if (!doc || isPurged(workspace, noteId)) continue;
      const due: Due[] = [];
      for (const thread of readThreads(doc)) {
        const comments = dueComments(thread, key);
        if (comments.length === 0) continue;
        const title = readTitle(doc);
        due.push({
          noteId,
          threadId: thread.id,
          payloads: comments.map((comment) => deliveryPayload(noteId, title, thread, comment)),
        });
      }
      if (due.length > 0 && isDeleted(doc)) {
        // In Trash: held until the note is restored (A774).
        this.held.add(noteId);
        continue;
      }
      this.held.delete(noteId);
      this.scanned.set(noteId, rev);
      out.push(...due);
    }
    return out;
  }
}
