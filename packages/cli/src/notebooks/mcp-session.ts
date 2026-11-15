/**
 * `penmoss mcp --notebook <name>` (A830): the local MCP server over one clone, for as long as
 * stdin is open. Every tool call runs under the clone's lock on its latest state on disk; edits
 * push a minute after they settle (at once with `--channel`), other writers' changes are pulled
 * every two minutes, and with the model here the lease holder indexes for meaning in the
 * background. On exit what is left syncs, detached when it can be (A825, A847).
 */
import { notebookTag } from '@penmoss/core/note-ref';
import { MeaningIndex } from '@penmoss/core/search';
import { LEASE_RETRY_MS, LeaseKeeper } from '@penmoss/embed/lease-keeper';
import { NotebookOps } from '@penmoss/git-notebook';
import {
  CHANNEL_CHECK_MS,
  CHANNEL_INSTRUCTIONS,
  CommentChannel,
  HEARTBEAT_MS,
  LOCAL_INSTRUCTIONS,
  LOCAL_MEANING_INSTRUCTIONS,
  LocalMcpServer,
  LocalNotebook,
  type NotebookAccess,
} from '@penmoss/git-notebook/local';
import { FileStorage } from '@penmoss/git-notebook/node';
import { hostname } from 'node:os';
import { basename, join } from 'node:path';
import type { MeaningIo, NotebookIo, NotebookSyncSummary, OpenedMeaning } from '../io';
import type { Clones, OpenedClone } from './clone';
import type { NotebookRegistry, StoredNotebook } from './registry';

/** How long a detached exit sync waits for the stopping server's lock (A847). */
const DETACHED_SYNC_WAIT_S = 120;
/** A search without the lease embeds at most this long of the chunks the cache lacks (A1157). */
export const MCP_MEANING_BUDGET_MS = 300;
/** The holder indexes a slice at a time, so a query waits for one small batch at most (A1160). */
export const INDEX_SLICE_MS = 5_000;
/** How long after an agent's edit the holder indexes it. */
export const EDIT_INDEX_DELAY_MS = 1_000;
export const INDEX_EVERY_MS = 30_000;
/** How often an MCP server renews its notebook's claim on the vectors it uses (PEN-134). */
export const CLAIM_EVERY_MS = 10 * 60_000;

/** What `serveMcp` is given: the stdio and the signal, as `NotebookIo.serveMcp` takes them. */
export type McpIo = Parameters<NotebookIo['serveMcp']>[1];

export interface McpSessionOptions {
  /** Push this long after edits settle (A825), and pull this often. */
  readonly pushDelayMs?: number;
  readonly pullEveryMs?: number;
  /** `--channel`'s cadence (A1063): the head check (10 s) and the session's heartbeat (hourly). */
  readonly channelCheckMs?: number;
  readonly heartbeatMs?: number;
  readonly meaning?: MeaningIo;
  readonly indexEveryMs?: number;
  readonly leaseRetryMs?: number;
  readonly claimEveryMs?: number;
  /** The server's environment: Claude Code's `CLAUDE_CODE_SESSION_ID` names its session (PEN-152). */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

/** The clone as the server holds it: re-opened whenever another process changed it on disk. */
interface Held extends OpenedClone {
  readonly notebook: LocalNotebook;
  generation: number;
}

/** The model while it is open, and whether this process holds the indexing lease. */
interface Meaning {
  readonly opened: OpenedMeaning;
  readonly index: MeaningIndex;
  /** Tries for the indexing lease for as long as the model is open (A1350). */
  readonly keeper: LeaseKeeper;
  holder: boolean;
}

/** Timers by name: setting one replaces the last of that name, and `clear` stops them all. */
export class Timers {
  private readonly timers = new Map<string, { stop(): void }>();

  later(name: string, ms: number, run: () => void, unref = false): void {
    this.cancel(name);
    const timer = setTimeout(run, ms);
    if (unref) timer.unref?.();
    this.timers.set(name, { stop: () => clearTimeout(timer) });
  }

  every(name: string, ms: number, run: () => void, unref = false): void {
    this.cancel(name);
    const timer = setInterval(run, ms);
    if (unref) timer.unref?.();
    this.timers.set(name, { stop: () => clearInterval(timer) });
  }

  cancel(name: string): void {
    this.timers.get(name)?.stop();
    this.timers.delete(name);
  }

  clear(): void {
    for (const timer of this.timers.values()) timer.stop();
    this.timers.clear();
  }
}

export class McpSession {
  private readonly name: string;
  private readonly pushDelay: number;
  private held: Held | null = null;
  /** Edits not pushed yet: this server's, or a stopped one's left on disk. */
  private pending = false;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly timers = new Timers();
  /** With the model here and the setting on, the tools say so from the start (A1156). */
  private meaningOn = false;
  private meaning: Meaning | null = null;
  /** Tool calls wait for the model to open (once, about two seconds), so meaning answers. */
  private modelOpened: Promise<void> = Promise.resolve();
  private opening: Promise<void> | null = null;
  private channel: CommentChannel | null = null;
  /** A sync went through: only then is the remote asked. */
  private syncedOnce = false;
  private serving = true;
  private readonly access: NotebookAccess;

  constructor(
    private readonly entry: StoredNotebook,
    private readonly clones: Clones,
    private readonly registry: NotebookRegistry,
    private readonly io: McpIo,
    private readonly options: McpSessionOptions,
    private readonly channelOptions: { readonly name?: string } | undefined,
  ) {
    this.name = entry.name;
    // In channel mode the clone's own writes go at once (A1063): a reply is waited for.
    this.pushDelay = channelOptions !== undefined ? 0 : (options.pushDelayMs ?? 60_000);
    this.access = {
      use: async (write, run) => {
        await this.modelOpened;
        await this.meaningStillOn();
        return this.exclusive('penmoss mcp', async (current) => {
          const out = await run(current.notebook);
          if (write) {
            this.pending = true;
            this.timers.later('push', this.pushDelay, () => void this.sync('push'));
            // An agent's edit is found by meaning a moment after it settles (A1160).
            this.indexSoon(EDIT_INDEX_DELAY_MS);
          }
          return out;
        });
      },
    };
  }

  /** Serves the tools on `io.lines` until they end or a signal stops it, then syncs once more. */
  async serve(): Promise<void> {
    const entry = this.entry;
    const io = this.io;
    // Edits a stopped server left unsynced (its detached sync may have failed) go first.
    const saved = (await new FileStorage(this.clones.dir(entry)).load().catch(() => null))?.meta;
    this.pending = saved ? Object.keys(saved.dirty).length > 0 || saved.workspaceDirty : false;
    const meaningStatus = this.options.meaning
      ? await this.options.meaning.status().catch(() => null)
      : null;
    this.meaningOn = meaningStatus?.enabled === true && meaningStatus.state === 'ready';
    this.channel = this.openChannel();
    const channel = this.channel;
    const server = new LocalMcpServer(this.access, this.name, (text) => io.log(text), {
      meaning: this.meaningOn,
      env: this.options.env ?? {},
      // A short reference of another notebook on this machine (PEN-69): its name, for the
      // refusal to say which server reads it.
      notebookNamed: async (tag) => {
        const other = (await this.registry.read()).notebooks.find(
          (each) => each.notebookId !== undefined && notebookTag(each.notebookId) === tag,
        );
        return other ? (other.notebookName ?? other.name) : null;
      },
      ...(channel
        ? {
            channel: true,
            instructions: `${this.meaningOn ? LOCAL_MEANING_INSTRUCTIONS : LOCAL_INSTRUCTIONS}\n${CHANNEL_INSTRUCTIONS}`,
            onInitialized: () => {
              channel.start();
              void channel.tick();
            },
          }
        : {}),
    });
    // A sync at once, so the agent starts from what other writers pushed (#165); a channel then
    // lists its session (A1060).
    void this.sync('start').then(async (done) => {
      if (done) this.syncedOnce = true;
      await channel?.heartbeat().catch((error: unknown) => {
        io.log(`penmoss: could not list this session in ${this.name}: ${message(error)}`);
      });
    });
    if (this.meaningOn) {
      this.opening = this.openMeaning();
      this.modelOpened = this.opening;
    }
    this.timers.every('pull', this.options.pullEveryMs ?? 120_000, () => void this.sync('pull'));
    if (channel) {
      this.timers.every(
        'check',
        this.options.channelCheckMs ?? CHANNEL_CHECK_MS,
        () => void channel.tick().catch((error: unknown) => io.log(`penmoss: ${String(error)}`)),
      );
      this.timers.every(
        'heartbeat',
        this.options.heartbeatMs ?? HEARTBEAT_MS,
        () =>
          void channel.heartbeat().catch((error: unknown) => io.log(`penmoss: ${String(error)}`)),
      );
    }
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
      await this.close();
    }
    // On exit, what is left goes (A825). An agent's client stops its server by closing stdin or
    // with a signal, and kills it moments later (Claude Code: stdin closed, SIGINT, SIGTERM, then
    // SIGKILL within half a second), too soon to push, so a detached `penmoss notebook sync`
    // does it, once this process lets go of the lock or dies holding it (A847). The edits are on
    // disk either way. Only where nothing can be detached does this process push itself.
    // Detached first: waiting for queued work (a lock, a sync) could outlast the kill.
    if (this.pending) {
      const log = join(this.clones.dir(entry), 'detached-sync.log');
      const args = ['notebook', 'sync', this.name, '--wait', String(DETACHED_SYNC_WAIT_S)];
      if (io.detach?.(args, log)) {
        io.log(
          `penmoss: ${stoppedBy !== null ? `stopped by ${stoppedBy}` : 'stdin closed'}: syncing ${this.name} in the background (log: ${log})`,
        );
        await this.queue;
        return;
      }
    }
    await this.queue;
    if (this.pending) await this.sync('exit');
  }

  /** Stops every timer and the channel, and closes the model once it has opened. */
  private async close(): Promise<void> {
    this.serving = false;
    this.timers.clear();
    this.channel?.stop();
    await this.opening;
    await this.meaning?.keeper.stop();
    await this.meaning?.opened.close();
  }

  /** The channel (T60, A1063): its session entry, the head check and delivery. */
  private openChannel(): CommentChannel | null {
    if (!this.channelOptions) return null;
    const cwd = process.cwd();
    const sessionName = this.channelOptions.name ?? `${hostname()}:${cwd}`;
    const heads = this.clones.transportFor(this.entry);
    return new CommentChannel(
      {
        use: (write, run) => this.access.use(write, run),
        remoteHead: () =>
          this.syncedOnce
            ? heads.remoteHead()
            : Promise.reject(new Error('the notebook has not synced yet')),
        sync: (why) => this.sync(why),
        notify: (note) => this.io.write(JSON.stringify(note)),
        log: (text) => this.io.log(text),
      },
      {
        name: sessionName,
        label: `${this.entry.writer.label} · ${this.channelOptions.name ?? (basename(cwd) || cwd)}`,
        host: hostname(),
      },
    );
  }

  /** One thing at a time, under the clone's lock, on the latest state on disk. */
  private exclusive<T>(what: string, run: (current: Held) => Promise<T>): Promise<T> {
    const entry = this.entry;
    const next = this.queue.then(() =>
      this.clones.withLock(
        entry,
        what,
        async () => {
          const storage = new FileStorage(this.clones.dir(entry));
          const generation = await storage.generation();
          if (!this.held || this.held.generation !== generation) {
            const opened = await this.clones.open(entry);
            this.held = {
              ...opened,
              // save_version commits now (G6), through the same checks as any sync (A841).
              notebook: new LocalNotebook(
                new NotebookOps(opened.engine),
                Date.now,
                async () => {
                  await this.clones.sync(entry, opened);
                },
                { side: 'mcp' },
              ),
              generation,
            };
            this.giveMeaning();
          }
          const current = this.held;
          try {
            return await run(current);
          } finally {
            await current.engine.save();
            current.generation = await current.storage.generation();
          }
        },
        30_000,
      ),
    );
    this.queue = next.catch(() => undefined);
    return next;
  }

  /** Syncs under the lock and logs what it found; a failure is logged, never thrown. */
  private sync(why: string): Promise<NotebookSyncSummary | undefined> {
    const io = this.io;
    return this.exclusive(`penmoss mcp (${why})`, async (current) => {
      const done = await this.clones.sync(this.entry, current);
      const meta = current.engine.replica.state;
      this.pending = Object.keys(meta.dirty).length > 0 || meta.workspaceDirty;
      for (const warning of done.warnings) io.log(`penmoss: ${warning}`);
      for (const [path, reason] of Object.entries(done.skipped)) {
        io.log(`penmoss: skipped ${path}: ${reason}`);
      }
      if (done.copies.length > 0) {
        io.log(`penmoss: left alone, copies of notes made by hand: ${done.copies.join(', ')}`);
      }
      return done;
    }).catch((error: unknown) => {
      io.log(`penmoss: could not sync ${this.name}: ${message(error)}`);
      return undefined;
    });
  }

  /** The held notebook searches by meaning when the model is open: fully, or on a budget. */
  private giveMeaning(): void {
    const meaning = this.meaning;
    if (!meaning || !this.held) return;
    this.held.notebook.useMeaning({
      index: meaning.index,
      budgetMs: meaning.holder ? 0 : MCP_MEANING_BUDGET_MS,
    });
  }

  /**
   * Settings → Search by Meaning switched off while serving (A1158): the model closes and the
   * tools answer by words (the app removes the model and the vectors).
   */
  private async meaningStillOn(): Promise<void> {
    const current = this.meaning;
    if (!current) return;
    const status = await this.options.meaning!.status().catch(() => null);
    if (status?.enabled && status.state === 'ready') return;
    if (this.meaning !== current) return;
    // The background indexing stops with it: its next slice finds no model.
    this.meaning = null;
    this.held?.notebook.useMeaning(null);
    this.io.log(`penmoss: Semantic Search is off: searching ${this.name} by words only`);
    await current.keeper.stop();
    await current.opened.close();
  }

  /**
   * Opens the model in a worker thread. The holder of the lease indexes this notebook in the
   * background, a slice at a time. It never compacts: the cache is every notebook's, and the
   * app's service compacts, keeping what each notebook's claim names (PEN-134).
   */
  private async openMeaning(): Promise<void> {
    const io = this.io;
    try {
      const opened = await this.options.meaning!.open('mcp', { thread: true });
      if (!opened) return;
      if (!this.serving) {
        await opened.close();
        return;
      }
      // Tried for at once and again every retryMs, so a holder that dies or quits is replaced:
      // one try at the start left nobody indexing once the app quit (A1350).
      const next: Meaning = {
        opened,
        index: new MeaningIndex(opened.embedder, opened.cache),
        holder: false,
        keeper: new LeaseKeeper(() => opened.lease(), {
          retryMs: this.options.leaseRetryMs ?? LEASE_RETRY_MS,
          onChange: (held) => {
            if (this.meaning !== next) return;
            next.holder = held;
            this.giveMeaning();
            if (held) {
              io.log(`penmoss: indexing ${this.name} for meaning`);
              this.indexSoon(0);
            } else {
              io.log(`penmoss: another process indexes for meaning now`);
              this.timers.cancel('index');
            }
          },
          log: (text) => io.log(`penmoss: ${text}`),
        }),
      };
      this.meaning = next;
      await next.keeper.start();
      if (this.meaning === next) this.giveMeaning();
      this.indexSoon(0);
      void this.claimUsed();
      this.timers.every(
        'claim',
        this.options.claimEveryMs ?? CLAIM_EVERY_MS,
        () => void this.claimUsed(),
        true,
      );
    } catch (error) {
      io.log(`penmoss: searching ${this.name} by words only: ${message(error)}`);
    }
  }

  private indexSoon(ms: number): void {
    if (!this.serving || !this.meaning?.holder) return;
    this.timers.later('index', ms, () => void this.indexSlice(), true);
  }

  private async indexSlice(): Promise<void> {
    const current = this.meaning;
    if (!current || !this.serving) return;
    const every = this.options.indexEveryMs ?? INDEX_EVERY_MS;
    try {
      // The app's service may have taken the lease (A1350): then this one only searches.
      if (!(await current.keeper.check())) return;
      const notes = await this.access.use(false, (notebook) => notebook.meaningNotes());
      await current.index.update(notes, { budgetMs: INDEX_SLICE_MS, batch: 2 });
      this.indexSoon(current.index.waiting > 0 ? 0 : every);
    } catch (error) {
      this.io.log(`penmoss: indexing for meaning stopped: ${message(error)}`);
      this.indexSoon(every);
    }
  }

  /**
   * Whoever holds the lease, this notebook claims the vectors its notes use, so the app's
   * compaction keeps them though the app may never open this notebook (PEN-134).
   */
  private async claimUsed(): Promise<void> {
    const current = this.meaning;
    const claim = current?.opened.cache.claim?.bind(current.opened.cache);
    if (!current || !claim || !this.serving) return;
    try {
      const notes = await this.access.use(false, (notebook) => notebook.meaningNotes());
      await current.index.update(notes, { embed: false });
      await claim(this.clones.dir(this.entry), current.index.usedKeys());
    } catch (error) {
      this.io.log(`penmoss: could not claim ${this.name}'s vectors: ${message(error)}`);
    }
  }
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
