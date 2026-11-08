/**
 * The relay's notebook (T55, D48): the git-notebook engine over GitHub, the local MCP server's
 * tools on it, and MCP's Streamable HTTP in front. One instance lives in one Durable Object, so
 * every call is one at a time on one copy, as the CLI's clone lock makes it on a Mac.
 *
 * Reads pull first when the last sync is older than `PULL_AFTER_MS`, so claude.ai sees what the
 * Mac pushed. Writes are saved at once and pushed `PUSH_AFTER_MS` after they settle (the Durable
 * Object's alarm), and `save_version` pushes at once. A public repository is never synced (A841).
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
  RELAY_ABSENT_TOOLS,
  type NotebookAccess,
} from '@penmoss/git-notebook/local';
import type { RelayConfig } from './config';
import { tokenSource } from './github-auth';
import { BlobSecrets, BlobStorage, type Blobs } from './storage';

export const PULL_AFTER_MS = 15_000;
export const PUSH_AFTER_MS = 5_000;
export const RETRY_AFTER_MS = 60_000;
/** How long a "private" answer from GitHub is trusted (A841: a public one is never cached). */
export const PRIVATE_FOR_MS = 60 * 60_000;
/**
 * The repository no longer holds the copy's notebook: its history was replaced (an import that
 * starts the branch again) or another notebook is there. The copy is a cache (A821), so the relay
 * starts again from the repository instead of serving the old copy for good.
 */
const STALE_COPY: ReadonlySet<NotebookErrorCode> = new Set(['branch_gone', 'other_notebook']);

export const RELAY_INSTRUCTIONS = `This is Ryan's Penmoss notebook, reached through his relay: notes kept in a private git repository. Markdown with a title, tags (nested with /), headings, [[wikilinks]] between notes, folders, and a daily and weekly journal.
- Find notes with search_notes (words only here), list_recent, list_folder or list_tags; read one with read_note.
- Every read returns a baseVersion. Pass it to your next edit of that note; update_section and replace_text require it. Each edit returns the next baseVersion.
- An edit refused with a conflict means the part changed since you read it: call read_note again and redo the edit on the current text. Never retry blindly.
- For today's journal call get_daily_note (it creates the day's note from the notebook's template, in its time zone), then append_to_note, optionally under one of its headings.
- Your edits are committed to the repository a few seconds after they settle, as an agent named "claude.ai", and Ryan sees them in Penmoss's History, where he can revert them.
- trash_note moves a note to Trash; nothing deletes a note for good.`;

export interface RelayHost {
  readonly blobs: Blobs;
  /** Run `alarm()` at this time (replacing an earlier one). */
  scheduleSync(at: number): Promise<void>;
  readonly log: (text: string) => void;
}

export interface RelayOptions {
  readonly fetch?: typeof fetch;
  readonly clock?: () => number;
  /** Tests: the transport to use instead of GitHub's. */
  readonly transport?: GitTransport & { isPrivate?: () => Promise<boolean> };
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

export class Relay {
  private open: Open | null = null;
  private queue: Promise<unknown> = Promise.resolve();
  private lastSync = 0;
  private privateUntil = 0;
  private readonly server: LocalMcpServer;
  private readonly transport: GitTransport & { isPrivate?: () => Promise<boolean> };
  private readonly clock: () => number;

  constructor(
    private readonly config: RelayConfig,
    private readonly host: RelayHost,
    options: RelayOptions = {},
  ) {
    this.clock = options.clock ?? Date.now;
    const call = options.fetch ?? ((input, init) => fetch(input, init));
    this.transport =
      options.transport ??
      new GitHubTransport({
        repository: config.repository,
        branch: config.branch,
        root: config.root,
        token: tokenSource({
          access: config.access,
          repository: config.repository,
          api: config.api,
          fetch: call,
          clock: this.clock,
        }),
        author: { name: `${config.agentLabel} (Penmoss relay)`, email: 'relay@penmoss.invalid' },
        api: config.api,
        fetch: call,
        clock: this.clock,
      });
    const access: NotebookAccess = { use: (write, run) => this.use(write, run) };
    this.server = new LocalMcpServer(access, config.agentLabel, host.log, {
      title: 'Penmoss',
      instructions: RELAY_INSTRUCTIONS,
      // Comments to an agent are the local MCP's only (D50, A1064).
      absent: RELAY_ABSENT_TOOLS,
    });
  }

  /** One thing at a time, on the one copy. */
  private exclusive<T>(run: () => Promise<T>): Promise<T> {
    const next = this.queue.then(run);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async opened(): Promise<Open> {
    if (this.open) return this.open;
    const fingerprint = `${this.config.repository}#${this.config.branch}:${this.config.root}:${this.config.agentLabel}`;
    const stored = this.host.blobs.get('config');
    if (stored && new TextDecoder().decode(stored) !== fingerprint) {
      // Another notebook than the copy's: start again from the repository.
      this.host.blobs.clear();
    }
    this.host.blobs.put('config', new TextEncoder().encode(fingerprint));
    const engine = await GitNotebookEngine.open({
      transport: this.transport,
      storage: new BlobStorage(this.host.blobs),
      secrets: new BlobSecrets(this.host.blobs),
      writer: { kind: 'agent', label: this.config.agentLabel },
      clock: this.clock,
      log: this.host.log,
    });
    const notebook = new LocalNotebook(
      new NotebookOps(engine, this.clock),
      this.clock,
      // save_version: commit now, through the same checks as any sync.
      () => this.syncNow(engine).then(() => undefined),
      { side: 'mcp' },
    );
    this.open = { engine, notebook };
    return this.open;
  }

  private async checkPrivate(): Promise<void> {
    if (this.clock() < this.privateUntil || !this.transport.isPrivate) return;
    if (!(await this.transport.isPrivate())) {
      throw new Error(
        `${this.config.repository} is public. The relay never syncs a public repository: make it private on GitHub.`,
      );
    }
    this.privateUntil = this.clock() + PRIVATE_FOR_MS;
  }

  private async syncNow(engine: GitNotebookEngine) {
    await this.checkPrivate();
    const report = await engine.sync();
    await engine.save();
    this.lastSync = this.clock();
    return report;
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
      this.host.log(
        `relay: ${error.message} Starting again from the repository` +
          (dropped.length ? `, dropping unpushed edits to ${dropped.join(', ')}.` : '.'),
      );
      this.open = null;
      this.host.blobs.clear();
      const fresh = await this.opened();
      await this.syncNow(fresh.engine);
      return fresh;
    }
  }

  private dirty(engine: GitNotebookEngine): boolean {
    const meta = engine.replica.state;
    return Object.keys(meta.dirty).length > 0 || meta.workspaceDirty;
  }

  private use<T>(write: boolean, run: (notebook: LocalNotebook) => Promise<T> | T): Promise<T> {
    return this.exclusive(async () => {
      if (this.clock() - this.lastSync >= PULL_AFTER_MS) {
        try {
          await this.synced();
        } catch (error) {
          // A copy that never synced has nothing to serve; otherwise serve what is here.
          if (!(await this.opened()).engine.info) throw error;
          this.host.log(`relay: sync failed, serving the copy: ${String(error)}`);
        }
      }
      const { engine, notebook } = await this.opened();
      const out = await run(notebook);
      await engine.save();
      if (write || this.dirty(engine)) await this.host.scheduleSync(this.clock() + PUSH_AFTER_MS);
      return out;
    });
  }

  /** The Durable Object's alarm: push what settled (and pull). */
  alarm(): Promise<void> {
    return this.exclusive(async () => {
      try {
        const { engine } = await this.synced();
        if (this.dirty(engine)) await this.host.scheduleSync(this.clock() + PUSH_AFTER_MS);
      } catch (error) {
        this.host.log(`relay: push failed, trying again in a minute: ${String(error)}`);
        await this.host.scheduleSync(this.clock() + RETRY_AFTER_MS);
      }
    });
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
