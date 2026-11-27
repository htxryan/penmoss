/**
 * The relay's notebooks (T55, D48, PEN-192): the git-notebook engine over GitHub for each notebook
 * it serves, the local MCP server's tools on them through `NotebookRouter` (as `penmoss mcp` on a
 * Mac), and MCP's Streamable HTTP in front. Every notebook lives in one Durable Object, each in a
 * copy of its own: its own queue (one call at a time on it), its own stored copy and its own sync.
 *
 * Reads pull first when the notebook's last sync is older than `PULL_AFTER_MS`, so claude.ai sees
 * what the Mac pushed. Writes are saved at once and pushed `PUSH_AFTER_MS` after they settle (the
 * Durable Object's one alarm, set for the earliest push due), and `save_version` pushes at once.
 * Public and private repositories sync alike (D61). One notebook failing to sync leaves the
 * others serving.
 */
import {
  GitNotebookEngine,
  NotebookError,
  NotebookOps,
  type GitTransport,
  type NotebookErrorCode,
} from '@penmoss/git-notebook';
import { GitHubTransport } from '@penmoss/git-notebook/github';
import {
  LocalMcpServer,
  LocalNotebook,
  NotebookBusy,
  RELAY_ABSENT_TOOLS,
  type NotebookSet,
  type ServedNotebook,
} from '@penmoss/git-notebook/local';
import { notebookTag } from '@penmoss/core/note-ref';
import { placeKey, type NotebookPlace, type Place, type RelayConfig } from './config';
import { AppTokens, tokenSource } from './github-auth';
import type { NotebookRow } from './notebooks';
import { BlobSecrets, BlobStorage, legacyCopyKeys, PrefixedBlobs, type Blobs } from './storage';

export const PULL_AFTER_MS = 15_000;
export const PUSH_AFTER_MS = 5_000;
const RETRY_AFTER_MS = 60_000;
/**
 * The repository no longer holds the copy's notebook: its history was replaced (an import that
 * starts the branch again) or another notebook is there. The copy is a cache (A821), so the relay
 * starts again from the repository instead of serving the old copy for good.
 */
const STALE_COPY: ReadonlySet<NotebookErrorCode> = new Set(['branch_gone', 'other_notebook']);

/** What `initialize` tells claude.ai: whose notebooks these are, and which. */
export function relayInstructions(
  owner: string,
  agentLabel: string,
  served: readonly ServedNotebook[],
): string {
  const names = served.length
    ? served
        .map((each) => (each.tag ? `${each.name} (short ids ${each.tag}-…)` : each.name))
        .join(', ')
    : 'none yet';
  return `These are the Penmoss notebooks of the user (${owner} on GitHub), reached through their relay: ${names}. Each notebook's notes are kept in its own git repository. Markdown with a title, tags (nested with /), headings, [[wikilinks]] between notes, folders, and a daily and weekly journal.
- A note's id or short id finds its notebook, so tools that take one need no notebook argument. A folder id finds its notebook too.
- search_notes, list_recent, list_folder, list_tags, describe_tags and get_settings cover every notebook unless you pass notebook; each result names its notebook.
- With more than one notebook, pass notebook (its name) to create_note without a folderId, get_daily_note, create_folder without a parentId, set_settings, rename_tag, and set_folder_sort for the top level.
- Notes and folders never move between notebooks: to move one, make it in the other notebook and trash it here.
- Find notes with search_notes (words only here), list_recent, list_folder or list_tags; read one with read_note.
- Many notes have a description: a sentence or two on what the note is about. search_notes, list_recent, list_folder and get_backlinks give it, and read_note gives the description of each note it links to (links). Read descriptions to choose which notes to open before reading their whole text.
- The user describes what some tags mean: describe_tags gives each tag's description, and its parents'. Read them before choosing tags for a note or to know what a tag is for.
- Every read returns a baseVersion. Pass it to your next edit of that note; update_section and replace_text require it. Each edit returns the next baseVersion.
- An edit refused with a conflict means the part changed since you read it: call read_note again and redo the edit on the current text. Never retry blindly.
- For today's journal call get_daily_note with the notebook (it creates the day's note from that notebook's template, in its time zone), then append_to_note, optionally under one of its headings.
- Your edits are committed to each notebook's repository a few seconds after they settle, as an agent named "${agentLabel}", and the user sees them in Penmoss's History, where they can revert them.
- trash_note moves a note to Trash; nothing deletes a note for good.`;
}

export interface RelayHost {
  readonly blobs: Blobs;
  /** Run `alarm()` at this time (replacing an earlier one). */
  scheduleSync(at: number): Promise<void>;
  readonly log: (text: string) => void;
}

export interface RelayOptions {
  readonly fetch?: typeof fetch;
  readonly clock?: () => number;
  /** Tests: the transport for each notebook instead of GitHub's. */
  readonly transport?: (place: NotebookPlace) => GitTransport;
}

interface Open {
  readonly engine: GitNotebookEngine;
  readonly notebook: LocalNotebook;
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Where a copy's keys live in the relay's storage. */
export const prefixOf = (place: Place) => `copy:${placeKey(place)}/`;

/** The key, in a copy's storage, of when it last synced. */
const SYNCED_AT = 'synced-at';

/** One notebook's copy: its engine over its repository, its queue and its sync. */
class Copy {
  private open: Open | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private lastSync = 0;
  private first: Promise<void> | null = null;
  private failedAt = -Infinity;
  /** Why its last first sync failed. */
  private failure: unknown = null;
  /** When it last synced, for the Notebooks page; 0 for never. */
  syncedAt = 0;
  /** What went wrong with its last sync or push, in a sentence; null when it went through. */
  problem: string | null = null;
  /** When its push is due, or null for none. */
  due: number | null = null;
  readonly blobs: PrefixedBlobs;

  constructor(
    readonly place: NotebookPlace,
    private readonly transport: GitTransport,
    private readonly relay: {
      readonly blobs: Blobs;
      readonly agentLabel: string;
      readonly clock: () => number;
      readonly log: (text: string) => void;
      schedule(copy: Copy, at: number | null): Promise<void>;
    },
  ) {
    this.blobs = new PrefixedBlobs(relay.blobs, prefixOf(place));
    // Kept with the copy, so a relay built again (a new notebook list, an evicted object) still
    // knows when each notebook last synced.
    const synced = this.blobs.get(SYNCED_AT);
    this.syncedAt = synced ? Number(new TextDecoder().decode(synced)) || 0 : 0;
  }

  get fingerprint(): string {
    return `${placeKey(this.place)}:${this.relay.agentLabel}`;
  }

  /** The notebook's own file (`notebook.json`), once a sync has read it. */
  get info() {
    return this.open?.engine.info ?? null;
  }

  private log(text: string) {
    this.relay.log(`relay: ${this.place.repository}: ${text}`);
  }

  /** One thing at a time, on this copy. With `waitMs`, a queue not free in time is busy. */
  exclusive<T>(run: () => Promise<T>, busy?: { readonly waitMs: number; readonly name: string }) {
    let started = false;
    let abandoned = false;
    const next = this.queue.then(() => {
      if (abandoned) return undefined as T;
      started = true;
      return run();
    });
    this.queue = next.catch(() => undefined);
    if (!busy) return next;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        if (started) return;
        abandoned = true;
        reject(new NotebookBusy(busy.name));
      }, busy.waitMs);
    });
    return Promise.race([next, late]).finally(() => clearTimeout(timer));
  }

  private async opened(): Promise<Open> {
    if (this.open) return this.open;
    const stored = this.blobs.get('config');
    if (stored && new TextDecoder().decode(stored) !== this.fingerprint) {
      // Another notebook than the copy's: start again from the repository.
      this.blobs.clear();
      this.syncedAt = 0;
    }
    this.blobs.put('config', new TextEncoder().encode(this.fingerprint));
    const engine = await GitNotebookEngine.open({
      transport: this.transport,
      storage: new BlobStorage(this.blobs),
      secrets: new BlobSecrets(this.blobs),
      writer: { kind: 'agent', label: this.relay.agentLabel },
      clock: this.relay.clock,
      log: this.relay.log,
    });
    const notebook = new LocalNotebook(
      new NotebookOps(engine, this.relay.clock),
      this.relay.clock,
      // save_version: commit now, through the same checks as any sync.
      () => this.syncNow(engine).then(() => undefined),
      { side: 'mcp' },
    );
    this.open = { engine, notebook };
    return this.open;
  }

  private async syncNow(engine: GitNotebookEngine) {
    try {
      const report = await engine.sync();
      await engine.save();
      this.lastSync = this.relay.clock();
      this.syncedAt = this.lastSync;
      this.blobs.put(SYNCED_AT, new TextEncoder().encode(String(this.syncedAt)));
      this.problem = null;
      return report;
    } catch (error) {
      this.problem = message(error);
      throw error;
    }
  }

  /** Sync, starting again from the repository when it no longer holds the copy's notebook. */
  private async synced(): Promise<Open> {
    const open = await this.opened();
    try {
      await this.syncNow(open.engine);
      return open;
    } catch (error) {
      if (!(error instanceof NotebookError && STALE_COPY.has(error.code))) throw error;
      const dropped = Object.keys(open.engine.replica.state.dirty);
      this.log(
        `${error.message} Starting again from the repository` +
          (dropped.length ? `, dropping unpushed edits to ${dropped.join(', ')}.` : '.'),
      );
      this.open = null;
      this.blobs.clear();
      const fresh = await this.opened();
      await this.syncNow(fresh.engine);
      return fresh;
    }
  }

  private dirty(engine: GitNotebookEngine): boolean {
    const meta = engine.replica.state;
    return Object.keys(meta.dirty).length > 0 || meta.workspaceDirty;
  }

  /**
   * Opened, and synced once if it never was: its name and short ids come from the repository. A
   * first sync that failed is tried again once a pull's interval has passed, not on every call.
   */
  ready(): Promise<void> {
    if (this.first === null && this.relay.clock() - this.failedAt >= PULL_AFTER_MS) {
      this.first = this.exclusive(async () => {
        const { engine } = await this.opened();
        if (engine.info) return;
        try {
          await this.synced();
        } catch (error) {
          this.log(`the first sync failed: ${message(error)}`);
          this.failedAt = this.relay.clock();
          this.failure = error;
          this.first = null;
        }
      });
    }
    return this.first ?? Promise.resolve();
  }

  use<T>(
    write: boolean,
    run: (notebook: LocalNotebook) => Promise<T> | T,
    busy?: { readonly waitMs: number; readonly name: string },
  ): Promise<T> {
    return this.exclusive(async () => {
      const now = this.relay.clock();
      if (!(await this.opened()).engine.info && now - this.failedAt < PULL_AFTER_MS) {
        // It never synced, and its last try failed moments ago: say so again without asking GitHub.
        throw this.failure;
      }
      if (now - this.lastSync >= PULL_AFTER_MS) {
        try {
          await this.synced();
        } catch (error) {
          // A copy that never synced has nothing to serve; otherwise serve what is here.
          if (!(await this.opened()).engine.info) {
            this.failedAt = this.relay.clock();
            this.failure = error;
            throw error;
          }
          this.log(`sync failed, serving the copy: ${message(error)}`);
        }
      }
      const { engine, notebook } = await this.opened();
      const out = await run(notebook);
      await engine.save();
      if (write || this.dirty(engine)) {
        await this.relay.schedule(this, this.relay.clock() + PUSH_AFTER_MS);
      }
      return out;
    }, busy);
  }

  /** Its push, when due: push what settled (and pull). */
  push(): Promise<void> {
    return this.exclusive(async () => {
      try {
        const { engine } = await this.synced();
        await this.relay.schedule(
          this,
          this.dirty(engine) ? this.relay.clock() + PUSH_AFTER_MS : null,
        );
      } catch (error) {
        this.log(`push failed, trying again in a minute: ${message(error)}`);
        await this.relay.schedule(this, this.relay.clock() + RETRY_AFTER_MS);
      }
    });
  }

  /**
   * Pushes what it holds before it goes (Remove… on the Notebooks page): throws when edits
   * stay unpushed, so the notebook is not dropped with them.
   */
  flush(): Promise<void> {
    return this.exclusive(async () => {
      if (!this.open && !this.blobs.get('meta')) return;
      const { engine } = await this.opened();
      if (!this.dirty(engine)) return;
      await this.synced();
      if (this.dirty((await this.opened()).engine)) {
        throw new Error('Some of its edits are still not pushed.');
      }
    });
  }

  /** Whether its stored copy holds edits not pushed (a restart forgets when they are due). */
  async pending(): Promise<boolean> {
    if (!this.open && !this.blobs.get('meta')) return false;
    return this.exclusive(async () => this.dirty((await this.opened()).engine));
  }
}

export class Relay {
  private readonly copies: readonly Copy[];
  private readonly server: LocalMcpServer;
  private readonly clock: () => number;

  constructor(
    config: RelayConfig,
    private readonly host: RelayHost,
    options: RelayOptions = {},
  ) {
    this.clock = options.clock ?? Date.now;
    const call = options.fetch ?? ((input, init) => fetch(input, init));
    const app = config.app
      ? new AppTokens({ app: config.app, api: config.api, fetch: call, clock: this.clock })
      : null;
    const relay = {
      blobs: host.blobs,
      agentLabel: config.agentLabel,
      clock: this.clock,
      log: host.log,
      schedule: (copy: Copy, at: number | null) => this.schedule(copy, at),
    };
    this.copies = config.notebooks.map(
      (place) =>
        new Copy(
          place,
          options.transport?.(place) ??
            new GitHubTransport({
              repository: place.repository,
              branch: place.branch,
              root: place.root,
              token: tokenSource(place.access, place.repository, app),
              author: {
                name: `${config.agentLabel} (Penmoss relay)`,
                email: 'relay@penmoss.invalid',
              },
              api: config.api,
              fetch: call,
              clock: this.clock,
            }),
          relay,
        ),
    );
    this.adoptLegacyCopy();
    const set: NotebookSet = {
      notebooks: () => this.served(),
      use: async (name, write, run, options) => {
        const copy = (await this.named()).get(name);
        if (!copy) throw new Error(`No notebook here is called “${name}”.`);
        return copy.use(
          write,
          run,
          options?.waitMs === undefined ? undefined : { waitMs: options.waitMs, name },
        );
      },
    };
    this.server = new LocalMcpServer(set, config.agentLabel, host.log, {
      title: 'Penmoss',
      instructions: (served) => relayInstructions(config.owner, config.agentLabel, served),
      // Comments to an agent are the local MCP's only (D50, A1064).
      absent: RELAY_ABSENT_TOOLS,
    });
  }

  /**
   * The one copy kept before the relay served several notebooks (unprefixed keys): moved under
   * its notebook's prefix when that notebook is still served, so unpushed edits survive, and
   * dropped otherwise.
   */
  private adoptLegacyCopy(): void {
    const keys = legacyCopyKeys(this.host.blobs);
    if (keys.length === 0) return;
    const fingerprint = new TextDecoder().decode(this.host.blobs.get('config')!);
    const heir = this.copies.find((copy) => copy.fingerprint === fingerprint);
    this.host.blobs.transaction(() => {
      for (const key of keys) {
        if (heir) heir.blobs.put(key, this.host.blobs.get(key)!);
        this.host.blobs.delete(key);
      }
    });
    this.host.log(
      heir
        ? `relay: moved the stored copy of ${heir.place.repository} under its own key.`
        : 'relay: dropped the stored copy of a notebook no longer served.',
    );
  }

  /** The served notebooks by name: the name in `notebook.json`, its repository added on a clash. */
  private async named(): Promise<ReadonlyMap<string, Copy>> {
    await Promise.all(this.copies.map((copy) => copy.ready()));
    const base = (copy: Copy) => copy.info?.name ?? copy.place.repository;
    const count = new Map<string, number>();
    for (const copy of this.copies) count.set(base(copy), (count.get(base(copy)) ?? 0) + 1);
    const repositories = new Map<string, number>();
    for (const copy of this.copies) {
      repositories.set(copy.place.repository, (repositories.get(copy.place.repository) ?? 0) + 1);
    }
    const named = new Map<string, Copy>();
    for (const copy of this.copies) {
      const name = base(copy);
      if (count.get(name)! === 1) {
        named.set(name, copy);
        continue;
      }
      const where =
        repositories.get(copy.place.repository)! > 1 ? placeKey(copy.place) : copy.place.repository;
      named.set(`${name} (${where})`, copy);
    }
    return named;
  }

  /** The repositories of the notebooks served. */
  repositories(): string[] {
    return this.copies.map((copy) => copy.place.repository);
  }

  /** The notebooks, as the owner's Notebooks page lists them: nothing secret. */
  async rows(): Promise<NotebookRow[]> {
    return [...(await this.named())].map(([name, copy]) => ({
      name,
      id: copy.info?.id ?? null,
      key: placeKey(copy.place),
      repository: copy.place.repository,
      branch: copy.place.branch,
      root: copy.place.root,
      access: copy.place.access.kind,
      tokenEnd: copy.place.access.kind === 'token' ? copy.place.access.token.slice(-4) : null,
      syncedAt: copy.syncedAt || null,
      problem: copy.problem,
    }));
  }

  /** Pushes a notebook's edits before it is removed; throws when they stay unpushed. */
  async flush(key: string): Promise<void> {
    await this.copies.find((copy) => placeKey(copy.place) === key)?.flush();
  }

  private async served(): Promise<ServedNotebook[]> {
    return [...(await this.named())].map(([name, copy]) => ({
      name,
      id: copy.info?.id ?? null,
      tag: copy.info ? notebookTag(copy.info.id) : null,
    }));
  }

  /** Sets a copy's push, and the alarm for the earliest push due. */
  private async schedule(copy: Copy, at: number | null): Promise<void> {
    copy.due = at;
    const next = Math.min(...this.copies.map((each) => each.due ?? Infinity));
    if (next !== Infinity) await this.host.scheduleSync(next);
  }

  /** The Durable Object's alarm: each notebook whose push is due pushes (and pulls), apart. */
  async alarm(): Promise<void> {
    const now = this.clock();
    await Promise.all(
      this.copies.map(async (copy) => {
        const due = copy.due === null ? await copy.pending() : copy.due <= now;
        if (due) await copy.push();
      }),
    );
    // An alarm early for every copy still leaves the next push due.
    const next = Math.min(...this.copies.map((each) => each.due ?? Infinity));
    if (next !== Infinity) await this.host.scheduleSync(next);
  }

  /** MCP's Streamable HTTP, answering with JSON (no server-sent stream, no sessions). */
  async handle(request: Request): Promise<Response> {
    if (request.method !== 'POST') {
      return json(405, { error: 'POST JSON-RPC messages to this endpoint.' }, { allow: 'POST' });
    }
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return json(400, {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: 'Parse error' },
      });
    }
    const messages = Array.isArray(body) ? body : [body];
    const replies: object[] = [];
    for (const message of messages) {
      const reply = await this.server.handle(message);
      if (reply) replies.push(reply);
    }
    if (replies.length === 0) return new Response(null, { status: 202 });
    return json(200, Array.isArray(body) ? replies : replies[0]);
  }
}
