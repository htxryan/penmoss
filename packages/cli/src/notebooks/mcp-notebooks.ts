/**
 * `penmoss mcp` with no `--notebook` (PEN-139, PEN-151): one local MCP server for every git
 * notebook on this machine that has an agent copy, routed by `NotebookRouter` (A1584).
 *
 * Each notebook is a slot of its own: its agent copy's clone, opened on first use; its own queue,
 * so a sync of one notebook never delays a call to another; its edits, pushed a minute after they
 * settle; a sync when first opened, and a pull every two minutes while it is in use, skipped
 * when any process synced the clone within that time. A call takes the clone's lock only for as long as it runs, as
 * `--notebook` does, so several sessions share the clones. On exit, each notebook with edits not
 * pushed gets a detached `penmoss notebook sync` of its own (A847).
 */
import { notebookTag } from '@penmoss/core/note-ref';
import { NotebookOps } from '@penmoss/git-notebook';
import {
  CHANNEL_CHECK_MS,
  CommentChannel,
  HEARTBEAT_MS,
  LocalMcpServer,
  LocalNotebook,
  NotebookBusy,
  type LocalMeaning,
  type NotebookSet,
  type ServedNotebook,
} from '@penmoss/git-notebook/local';
import { FileStorage } from '@penmoss/git-notebook/node';
import { stat } from 'node:fs/promises';
import { hostname } from 'node:os';
import { basename, join } from 'node:path';
import { CliError } from '../errors';
import type { NotebookSyncSummary } from '../io';
import type { Clones, OpenedClone } from './clone';
import { SharedMeaning, type MeaningTarget } from './mcp-meaning';
import type { McpIo, McpSessionOptions } from './mcp-session';
import type { NotebookRegistry, StoredNotebook } from './registry';

/** How long a detached exit sync waits for the stopping server's lock (A847). */
const DETACHED_SYNC_WAIT_S = 120;
/** A notebook used this recently is pulled on the cadence; one idle longer is left alone. */
export const IN_USE_MS = 15 * 60_000;
/** How long a call waits for a clone's lock (as `--notebook`'s server). */
const LOCK_WAIT_MS = 30_000;

/** A served notebook: the name the agent passes, and the agent copy it is reached through. */
export interface ServedClone {
  readonly name: string;
  readonly entry: StoredNotebook;
}

/**
 * The clones `penmoss mcp` serves: for each notebook on this machine with an agent copy, that
 * copy, the app's own first, then the earliest added (A1097's order). A notebook with only a
 * person's clone is not served: its edits would look like the person's. Names are the notebook's
 * own, as the app shows them; two notebooks of one name are told apart by their clones' names.
 */
export function servedClones(all: readonly StoredNotebook[]): ServedClone[] {
  const groups = new Map<string, StoredNotebook[]>();
  for (const each of all) {
    const key = each.notebookId ?? `${each.remote}\u0000${each.branch}\u0000${each.dir}`;
    groups.set(key, [...(groups.get(key) ?? []), each]);
  }
  const rank = (each: StoredNotebook) => (each.automatic ? 0 : 1);
  const chosen = [...groups.values()].flatMap((clones) => {
    const agents = clones
      .filter((each) => each.writer.kind === 'agent')
      .sort((a, b) => rank(a) - rank(b) || a.added.localeCompare(b.added));
    return agents.length > 0 ? [agents[0]!] : [];
  });
  const nameOf = (entry: StoredNotebook) => entry.notebookName ?? entry.name;
  const count = new Map<string, number>();
  for (const entry of chosen) count.set(nameOf(entry), (count.get(nameOf(entry)) ?? 0) + 1);
  return chosen.map((entry) => ({
    name: count.get(nameOf(entry))! > 1 ? `${nameOf(entry)} (${entry.name})` : nameOf(entry),
    entry,
  }));
}

/** The clone as a slot holds it: re-opened whenever another process changed it on disk. */
interface Held extends OpenedClone {
  readonly notebook: LocalNotebook;
  generation: number;
}

interface SlotHost {
  readonly clones: Clones;
  readonly io: McpIo;
  readonly pushDelayMs: number;
  readonly pullEveryMs: number;
  readonly now: () => number;
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
const late = (ms: number) =>
  new Promise<'late'>((resolve) => {
    const timer = setTimeout(() => resolve('late'), ms);
    timer.unref?.();
  });

/** One notebook of the server: its clone, queue, pending edits and timers. */
class Slot implements MeaningTarget {
  private held: Held | null = null;
  /** Search by meaning, given to every clone it opens (PEN-153). */
  private meaning: LocalMeaning | null = null;
  /** Edits not pushed yet: this server's, or a stopped one's left on disk. */
  pending = false;
  private queue: Promise<unknown> = Promise.resolve();
  /** Calls and syncs queued or running. */
  private queued = 0;
  private started: Promise<void> | null = null;
  private push: ReturnType<typeof setTimeout> | null = null;
  /** When an agent's call last used it. */
  lastUsed = 0;
  /** A sync went through: only then is the remote asked for its head (the channel). */
  syncedOnce = false;
  /** Comments sent to the session from this notebook (PEN-154), with --channel. */
  channel: CommentChannel | null = null;

  constructor(
    readonly name: string,
    readonly entry: StoredNotebook,
    private readonly host: SlotHost,
  ) {}

  get key(): string {
    return this.entry.localId;
  }

  get owner(): string {
    return this.host.clones.dir(this.entry);
  }

  /** Reads under the clone's lock for indexing: not an agent's use, so no pull follows. */
  read<T>(run: (notebook: LocalNotebook) => T | Promise<T>): Promise<T> {
    return this.exclusive('penmoss mcp (meaning)', async (current) => run(current.notebook));
  }

  give(meaning: LocalMeaning | null): void {
    this.meaning = meaning;
    this.held?.notebook.useMeaning(meaning);
  }

  get tag(): string | null {
    const id = this.held?.notebook.notebookId ?? this.entry.notebookId;
    return id ? notebookTag(id) : null;
  }

  /** Its first sync, once: what other writers pushed, and what a stopped server left behind. */
  start(): Promise<void> {
    this.started ??= (async () => {
      const storage = new FileStorage(this.host.clones.dir(this.entry));
      const saved = (await storage.load().catch(() => null))?.meta;
      this.pending = saved ? Object.keys(saved.dirty).length > 0 || saved.workspaceDirty : false;
      await this.sync('start');
    })();
    return this.started;
  }

  /** Whether any process synced the clone within a pull's interval. */
  async syncedRecently(): Promise<boolean> {
    const at = await this.host.clones.syncedAt(this.entry);
    return at !== null && this.host.now() - at < this.host.pullEveryMs;
  }

  /** Runs a tool's work on the notebook, under the clone's lock. */
  async use<T>(
    write: boolean,
    run: (notebook: LocalNotebook) => Promise<T> | T,
    waitMs?: number,
  ): Promise<T> {
    this.lastUsed = this.host.now();
    const starting = this.start();
    if (waitMs === undefined) await starting;
    else if ((await Promise.race([starting.then(() => 'ready' as const), late(waitMs)])) === 'late')
      throw new NotebookBusy(this.name);
    return this.exclusive(
      'penmoss mcp',
      async (current) => {
        const out = await run(current.notebook);
        if (write) {
          this.pending = true;
          this.schedulePush();
        }
        return out;
      },
      waitMs,
    );
  }

  private schedulePush(): void {
    if (this.push) clearTimeout(this.push);
    this.push = setTimeout(() => {
      this.push = null;
      void this.sync('push');
    }, this.host.pushDelayMs);
  }

  /** One thing at a time, under the clone's lock, on the latest state on disk. */
  private async exclusive<T>(
    what: string,
    run: (current: Held) => Promise<T>,
    waitMs?: number,
  ): Promise<T> {
    if (waitMs !== undefined && this.queued > 0) {
      const ahead = this.queue.then(() => 'ready' as const);
      if ((await Promise.race([ahead, late(waitMs)])) === 'late') throw new NotebookBusy(this.name);
    }
    const { clones } = this.host;
    const entry = this.entry;
    this.queued++;
    const next = this.queue.then(() =>
      clones
        .withLock(
          entry,
          what,
          async () => {
            const storage = new FileStorage(clones.dir(entry));
            const generation = await storage.generation();
            if (!this.held || this.held.generation !== generation) {
              const opened = await clones.open(entry);
              this.held = {
                ...opened,
                // save_version commits now (G6), through the same checks as any sync (A841).
                notebook: new LocalNotebook(
                  new NotebookOps(opened.engine),
                  Date.now,
                  async () => {
                    await clones.sync(entry, opened);
                  },
                  { side: 'mcp' },
                ),
                generation,
              };
              if (this.meaning) this.held.notebook.useMeaning(this.meaning);
            }
            const current = this.held;
            try {
              return await run(current);
            } finally {
              await current.engine.save();
              current.generation = await current.storage.generation();
            }
          },
          waitMs ?? LOCK_WAIT_MS,
        )
        .catch((error: unknown) => {
          // Another process holds the clone for longer than a read across notebooks waits.
          if (waitMs !== undefined && error instanceof CliError && error.code === 'notebook_busy')
            throw new NotebookBusy(this.name);
          throw error;
        }),
    );
    this.queue = next.then(
      () => (this.queued -= 1),
      () => (this.queued -= 1),
    );
    return next;
  }

  /** Syncs under the lock and logs what it found; a failure is logged, never thrown. */
  sync(why: string): Promise<NotebookSyncSummary | undefined> {
    const { io, clones } = this.host;
    return this.exclusive(`penmoss mcp (${why})`, async (current) => {
      const done = await clones.sync(this.entry, current);
      this.syncedOnce = true;
      const meta = current.engine.replica.state;
      this.pending = Object.keys(meta.dirty).length > 0 || meta.workspaceDirty;
      for (const warning of done.warnings) io.log(`penmoss: ${this.name}: ${warning}`);
      for (const [path, reason] of Object.entries(done.skipped)) {
        io.log(`penmoss: ${this.name}: skipped ${path}: ${reason}`);
      }
      if (done.copies.length > 0) {
        io.log(
          `penmoss: ${this.name}: left alone, copies of notes made by hand: ${done.copies.join(', ')}`,
        );
      }
      return done;
    }).catch((error: unknown) => {
      io.log(`penmoss: could not sync ${this.name}: ${message(error)}`);
      return undefined;
    });
  }

  /** The pull's turn: only while in use, and only when no process synced it just now. */
  async pull(): Promise<void> {
    if (!this.started || this.host.now() - this.lastUsed > IN_USE_MS) return;
    if (await this.syncedRecently()) return;
    await this.sync('pull');
  }

  stopTimers(): void {
    if (this.push) clearTimeout(this.push);
    this.push = null;
    this.channel?.stop();
  }

  /** Waits for its first sync and what is queued: a call, a sync. */
  async idle(): Promise<void> {
    await this.started;
    await this.queue;
  }
}

/** `penmoss mcp` over every notebook: the slots, the registry they come from, the stdio. */
export class McpNotebooks {
  /** By the clone's local id: a slot outlives a rename, and a removed notebook's pending edits. */
  private readonly slots = new Map<string, Slot>();
  private served: readonly Slot[] = [];
  private registryStamp: number | null = -1;
  private readonly host: SlotHost;
  /** The model, once for every notebook (PEN-153), while Search by Meaning is on. */
  private meaning: SharedMeaning | null = null;

  constructor(
    private readonly clones: Clones,
    private readonly registry: NotebookRegistry,
    private readonly home: string,
    private readonly io: McpIo,
    private readonly options: McpSessionOptions,
    /** `--channel` (PEN-154): comments sent to this session from any served notebook. */
    private readonly channelOptions?: { readonly name?: string },
  ) {
    this.host = {
      clones,
      io,
      // In channel mode a notebook's own writes go at once (A1063): a reply is waited for.
      pushDelayMs: channelOptions !== undefined ? 0 : (options.pushDelayMs ?? 60_000),
      pullEveryMs: options.pullEveryMs ?? 120_000,
      now: Date.now,
    };
  }

  /** The served notebooks, re-read when `notebooks.json` changed. */
  private async refresh(): Promise<readonly Slot[]> {
    const registryFile = join(this.home, 'notebooks.json');
    const stamp = (await stat(registryFile).catch(() => null))?.mtimeMs ?? null;
    if (stamp === this.registryStamp) return this.served;
    this.registryStamp = stamp;
    const next: Slot[] = [];
    for (const { name, entry } of servedClones((await this.registry.read()).notebooks)) {
      let slot = this.slots.get(entry.localId);
      if (!slot || slot.name !== name) {
        const before = slot;
        before?.channel?.stop();
        const made = new Slot(name, entry, this.host);
        slot = made;
        made.channel = this.openChannel(made);
        this.slots.set(entry.localId, made);
        // Synced at once, as `--notebook`'s server syncs its one (#165), after what the slot
        // of its former name still had queued; a channel then lists its session (A1060).
        void (before?.idle() ?? Promise.resolve())
          .then(() => made.start())
          .then(() => this.heartbeat(made));
      }
      next.push(slot);
    }
    this.served = next;
    this.meaning?.served();
    return next;
  }

  /** Whether the client said `notifications/initialized`: channels deliver from then on. */
  private initialized = false;

  /**
   * The notebook's channel (PEN-154, amends A1063): the session listed under this server's one
   * name, the head checked every 10 s, and each comment sent as an event naming the notebook.
   */
  private openChannel(slot: Slot): CommentChannel | null {
    if (!this.channelOptions) return null;
    const cwd = process.cwd();
    const name = this.channelOptions.name ?? `${hostname()}:${cwd}`;
    const heads = this.clones.transportFor(slot.entry);
    const io = this.io;
    const channel = new CommentChannel(
      {
        use: (write, run) => this.use(slot, write, run),
        remoteHead: () =>
          slot.syncedOnce
            ? heads.remoteHead()
            : Promise.reject(new Error('the notebook has not synced yet')),
        sync: (why) => slot.sync(why),
        notify: (note) => io.write(JSON.stringify(withNotebook(note, slot.name))),
        log: (text) => io.log(text.replace(/^penmoss: /, `penmoss: ${slot.name}: `)),
      },
      {
        name,
        label: `${slot.entry.writer.label} · ${this.channelOptions.name ?? (basename(cwd) || cwd)}`,
        host: hostname(),
      },
    );
    if (this.initialized) channel.start();
    return channel;
  }

  private async heartbeat(slot: Slot): Promise<void> {
    await slot.channel?.heartbeat().catch((error: unknown) => {
      this.io.log(`penmoss: could not list this session in ${slot.name}: ${message(error)}`);
    });
  }

  /** A call on one notebook: the model first, then the slot; an edit is indexed soon after. */
  private async use<T>(
    slot: Slot,
    write: boolean,
    run: (notebook: LocalNotebook) => Promise<T> | T,
    waitMs?: number,
  ): Promise<T> {
    await this.modelOpened;
    await this.meaning?.stillOn();
    const out = await slot.use(write, run, waitMs);
    if (write) this.meaning?.edited(slot.key);
    return out;
  }

  private modelOpened: Promise<void> = Promise.resolve();

  private slotNamed(name: string): Slot {
    const slot = this.served.find((each) => each.name === name);
    if (!slot) throw new Error(`no notebook named ${name} is served`);
    return slot;
  }

  async serve(): Promise<void> {
    const io = this.io;
    await this.refresh();
    const status = this.options.meaning
      ? await this.options.meaning.status().catch(() => null)
      : null;
    const meaningOn = status?.enabled === true && status.state === 'ready';
    if (meaningOn && this.options.meaning) {
      this.meaning = new SharedMeaning(
        this.options.meaning,
        () => this.served,
        (text) => io.log(text),
        this.options,
      );
      this.modelOpened = this.meaning.open();
    }
    const set: NotebookSet = {
      notebooks: async (): Promise<ServedNotebook[]> =>
        (await this.refresh()).map((slot) => ({ name: slot.name, tag: slot.tag })),
      // Calls wait for the model to open (once), so meaning answers from the first.
      use: (name, write, run, use = {}) => this.use(this.slotNamed(name), write, run, use.waitMs),
    };
    const channels = this.channelOptions !== undefined;
    const server = new LocalMcpServer(set, 'penmoss', (text) => io.log(text), {
      env: this.options.env ?? {},
      meaning: meaningOn,
      ...(io.onToolCall ? { onToolCall: (call) => io.onToolCall?.(call) } : {}),
      ...(channels
        ? {
            channel: true,
            onInitialized: () => {
              this.initialized = true;
              for (const slot of this.served) {
                slot.channel?.start();
                void slot.channel?.tick();
              }
            },
          }
        : {}),
    });
    const pulls = setInterval(() => {
      for (const slot of this.served) void slot.pull();
    }, this.host.pullEveryMs);
    const ticks = channels
      ? setInterval(() => {
          for (const slot of this.served) {
            void slot.channel
              ?.tick()
              .catch((error: unknown) => io.log(`penmoss: ${String(error)}`));
          }
        }, this.options.channelCheckMs ?? CHANNEL_CHECK_MS)
      : null;
    const heartbeats = channels
      ? setInterval(() => {
          for (const slot of this.served) void this.heartbeat(slot);
        }, this.options.heartbeatMs ?? HEARTBEAT_MS)
      : null;
    // Set by the signal's callback, so not narrowed to its first value.
    let stoppedBy = null as string | null;
    const stop = io.stopped?.then((signal) => {
      stoppedBy = signal;
      return null;
    });
    const lines = io.lines[Symbol.asyncIterator]();
    try {
      for (;;) {
        const next = await (stop ? Promise.race([lines.next(), stop]) : lines.next());
        if (next === null || next.done) break;
        // A signal waits for the call in hand: its reply, and its edit marked pending.
        const reply = await server.line(next.value);
        if (reply !== null) io.write(reply);
      }
    } finally {
      if (stoppedBy !== null) void lines.return?.();
      clearInterval(pulls);
      if (ticks) clearInterval(ticks);
      if (heartbeats) clearInterval(heartbeats);
      for (const slot of this.slots.values()) slot.stopTimers();
      await this.meaning?.close();
    }
    // On exit, what is left goes (A825, A847): each notebook's edits to a detached sync of its
    // own, since the client kills this process moments after stopping it. The edits are on disk
    // either way; only where nothing can be detached does this process push itself.
    const how = stoppedBy !== null ? `stopped by ${stoppedBy}` : 'stdin closed';
    const left: Slot[] = [];
    for (const slot of this.slots.values()) {
      if (!slot.pending) continue;
      const log = join(this.clones.dir(slot.entry), 'detached-sync.log');
      const args = ['notebook', 'sync', slot.entry.name, '--wait', String(DETACHED_SYNC_WAIT_S)];
      if (io.detach?.(args, log)) {
        io.log(`penmoss: ${how}: syncing ${slot.name} in the background (log: ${log})`);
      } else {
        left.push(slot);
      }
    }
    await Promise.all([...this.slots.values()].map((slot) => slot.idle()));
    for (const slot of left) if (slot.pending) await slot.sync('exit');
  }
}

/** A channel event names the notebook its thread is in (PEN-154): `notebook` in its meta. */
function withNotebook(note: Record<string, unknown>, notebook: string): Record<string, unknown> {
  const params = note['params'] as { content: string; meta: Record<string, string> } | undefined;
  if (!params) return note;
  return { ...note, params: { ...params, meta: { ...params.meta, notebook } } };
}
