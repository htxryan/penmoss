/**
 * Everything the CLI touches outside itself, passed in: the terminal, the environment, files,
 * the opener and git notebooks. `bin.ts` and the Mac app (`cli-mode.ts`) wire Node's; the tests
 * wire strings and a home folder of their own. This module and every command stay free of Node
 * APIs: only `node-io.ts` and `node-notebooks.ts` use them.
 */

import type { Embedder, VectorCache } from '@penmoss/core/search';

/** The parts of a fetch Response the CLI reads: a notebook's local API answers with these. */
export interface FetchResponse {
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  text(): Promise<string>;
}

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<FetchResponse>;

export type TokenLocation = 'keychain' | 'file';

/**
 * Where secrets are kept between runs: git notebooks' tokens and writer secrets (T50), in the OS
 * keychain, else a 0600 file (A160).
 */
export interface TokenStore {
  /** The keychain's name (null without one) and the file's path. */
  describe(): { keychain: string | null; file: string };
  /** The secret saved under a key. Throws when the file is unsafe to read. */
  get(key: string): Promise<{ token: string; location: TokenLocation } | null>;
  /** Saves a secret: `auto` prefers the keychain and falls back to the file (with a note why). */
  set(
    key: string,
    token: string,
    where: 'auto' | TokenLocation,
  ): Promise<{ location: TokenLocation; note?: string }>;
  /** Forgets the secret under a key; says where it was removed from. */
  delete(key: string): Promise<TokenLocation[]>;
}

/** Stdio and signals, for `penmoss mcp` and a sync left to the background. */
export interface StdioIo {
  /** Stdin, one line at a time (newline-delimited JSON-RPC); ends when stdin closes. */
  lines(): AsyncIterable<string>;
  /**
   * Resolves with the signal's name when this process is asked to stop (SIGINT, SIGTERM or
   * SIGHUP), which then no longer ends it at once (T50 G2). Absent where there are no signals.
   */
  stopped?(): Promise<string>;
  /**
   * Starts `penmoss <args>` in the background, to outlive this process; false when it could not.
   * Its output goes to the end of `log` (kept small), else nowhere.
   */
  detach?(args: readonly string[], log?: string): boolean;
}

/** A git notebook as this machine knows it (T50 G2): `~/.penmoss/notebooks.json`. */
export interface NotebookEntry {
  /** The name commands take (`--notebook <name>`); this machine's own. */
  readonly name: string;
  /** The clone's folder under `~/.penmoss/git/`. */
  readonly localId: string;
  readonly remote: string;
  readonly branch: string;
  /** The directory in the repository ('' for its top). */
  readonly dir: string;
  readonly writer: { readonly kind: 'device' | 'agent'; readonly label: string };
  /** `notebook.json`'s id and name, once known. */
  readonly notebookId?: string;
  readonly notebookName?: string;
  /** Made by the Mac app for one of its notebooks (D52): the app removes it with that notebook. */
  readonly automatic?: true;
}

/** What one sync did (T50, A822), for people and `--json`. */
export interface NotebookSyncSummary {
  readonly name: string;
  /** The commit pushed, or null when this device had nothing to send. */
  readonly commit: string | null;
  readonly head: string | null;
  /** Notes other writers changed. */
  readonly pulled: number;
  readonly purged: number;
  /** Rendered files someone edited by hand, overwritten (A823). */
  readonly handEdits: readonly string[];
  /** Copies of notes' files someone made, with a note's id: left alone (#165). */
  readonly copies: readonly string[];
  /** Files at head this device could not read (corrupt, or too large): path → why. */
  readonly skipped: Readonly<Record<string, string>>;
  /** A newer client renders this notebook: this one wrote its logs only. */
  readonly renderSkipped: boolean;
  readonly attempts: number;
  /** The host ignored the partial-clone filter: the clone holds every file. */
  readonly filterIgnored: boolean;
  /** Something worth saying (at add: a repository Penmoss could not ask about). */
  readonly warnings: readonly string[];
}

export interface NotebookStatus extends NotebookEntry {
  /** Files at head this device could not read at the last sync: path → why. */
  readonly skipped: Readonly<Record<string, string>>;
  /** How commits are signed: as git's config says, or off (`--no-sign`). */
  readonly signing: string;
  /** Who the next commit is by, and whether that is this notebook's own (#170 F3, F6). */
  readonly author: { readonly name: string; readonly email: string; readonly own: boolean };
  readonly writerId: string | null;
  readonly lastHead: string | null;
  /** Notes changed here and not yet pushed. */
  readonly unsynced: number;
  readonly notes: number;
  readonly cloneBytes: number;
  readonly stateBytes: number;
  /** Where the notebook's token comes from: saved for it, PENMOSS_GIT_TOKEN, or none. */
  readonly token: 'saved' | 'environment' | null;
  readonly filterIgnored: boolean;
}

/** One command's use of a notebook: its local REST API, under the clone's lock. */
export interface NotebookSession {
  readonly fetch: FetchLike;
  /**
   * Gives this session's searches meaning (A1156) when the model is here and Search by Meaning
   * is on; otherwise nothing changes. Searches embed their query and at most a short budget of
   * chunks the cache lacks (A1157).
   */
  useMeaning?(): Promise<void>;
  /**
   * Syncs; with `timeoutMs`, gives up when the host has not answered by then (its git stopped,
   * every change kept) and rejects with `sync_timeout` (A852).
   */
  sync(options?: { readonly timeoutMs?: number }): Promise<NotebookSyncSummary>;
  /** Where a sync left to the background logs (the clone's `detached-sync.log`). */
  readonly detachedLog?: string;
  /** Saves and lets go of the clone. */
  close(): Promise<void>;
}

/**
 * Git notebooks on this machine (T50 G2, #150): clones in `~/.penmoss/git/<id>/`, each with its
 * own writer, a lock shared by the CLI and the local MCP server, and credentials in the keychain
 * or `~/.penmoss/credentials.json`.
 */
export interface NotebookIo {
  list(): Promise<NotebookEntry[]>;
  add(input: {
    readonly remote: string;
    readonly branch: string;
    readonly dir: string;
    readonly name?: string;
    readonly agent?: string;
    readonly token?: string;
    /** The user name sent with the token (`--token-user`; github.com needs none). */
    readonly tokenUser?: string;
    /** False: never sign this notebook's commits (`--no-sign`). */
    readonly sign?: boolean;
    /**
     * This notebook's own commit identity from its first commit (`--author-email`, #198), as
     * `set` gives it later; the name is git's user.name when not given.
     */
    readonly author?: { readonly name?: string; readonly email: string };
    /**
     * Only a notebook the target holds already: refuses with `notebook_not_there` rather than
     * make one (the Mac app's automatic agent clones, D52, never race the app's first push).
     */
    readonly existing?: boolean;
    /** The Mac app's own agent clone of one of its notebooks (D52). */
    readonly automatic?: boolean;
  }): Promise<{ entry: NotebookEntry; created: boolean; sync: NotebookSyncSummary }>;
  /** Changes a notebook's own settings: `sign: false` never signs; true signs as git's config says. */
  set(
    name: string,
    change: {
      readonly sign?: boolean;
      /** This notebook's own commit name and email (#170 F6); null: git's own again. */
      readonly author?: { readonly name: string; readonly email: string } | null;
    },
  ): Promise<void>;
  remove(name: string, force: boolean): Promise<NotebookEntry>;
  /** Sets (or with null forgets) the personal access token a notebook's git calls use. */
  setToken(name: string, token: string | null): Promise<void>;
  status(name: string): Promise<NotebookStatus>;
  sync(
    name: string,
    options?: { readonly full?: boolean; readonly waitMs?: number },
  ): Promise<NotebookSyncSummary>;
  session(name: string, what: string): Promise<NotebookSession>;
  /**
   * Serves the local MCP server (A830) on `lines` until they end, then syncs once more. Stopped
   * by a signal instead, it leaves that sync to a detached `penmoss notebook sync` (A847).
   */
  serveMcp(
    name: string,
    io: {
      readonly lines: AsyncIterable<string>;
      write(line: string): void;
      log(text: string): void;
      readonly stopped?: Promise<string>;
      detach?(args: readonly string[], log?: string): boolean;
    },
    options?: {
      /**
       * `--channel` (T60, A1063): also a Claude Code channel for comments sent to this session.
       * `name` is `--name` (default `<host>:<working directory>`).
       */
      readonly channel?: { readonly name?: string };
    },
  ): Promise<void>;
}

/** What `penmoss models` and search by meaning see of the model on this Mac (A1151, A1158). */
export interface MeaningStatus {
  readonly enabled: boolean;
  readonly state: 'absent' | 'partial' | 'ready';
  readonly bytes: number;
  readonly totalBytes: number;
  readonly model: string;
  readonly repository: string;
  readonly revision: string;
  readonly dir: string;
  readonly license: { readonly name: string; readonly url: string };
}

export interface OpenedMeaning {
  readonly embedder: Embedder;
  readonly cache: VectorCache & { compact(keep: ReadonlySet<string>): Promise<number> };
  /** The indexer lease (A1157), or undefined while another process holds it. */
  lease(): Promise<{ held(): Promise<boolean>; release(): Promise<void> } | undefined>;
  close(): Promise<void>;
}

/**
 * Search by meaning on this Mac (T75): the app's binary gives the CLI its model store, vector
 * cache and lease (`@penmoss/embed`'s `NodeMeaning`); a CLI without it searches words only.
 */
export interface MeaningIo {
  status(): Promise<MeaningStatus>;
  fetch(onProgress?: (received: number, total: number) => void): Promise<MeaningStatus>;
  remove(): Promise<void>;
  /** Null when Search by Meaning is off or the model is not here. `thread`: in a worker thread. */
  open(
    writer: 'cli' | 'mcp',
    options?: { readonly thread?: boolean },
  ): Promise<OpenedMeaning | null>;
}

export interface Io {
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Search by meaning, in the app's binary (T75). */
  readonly meaning?: MeaningIo;
  readonly stdin: {
    readonly isTTY: boolean;
    /** All of stdin as UTF-8. */
    read(): Promise<string>;
  };
  readonly stdout: { readonly isTTY: boolean; write(text: string): void };
  readonly stderr: { write(text: string): void };
  /** Opens a URL (`penmoss://note/…` for `penmoss open`); false when there is no way to. */
  readonly openUrl: (url: string) => Promise<boolean>;
  /** A file's bytes (`penmoss attach`); absent where the CLI has no files to read. */
  readonly readFile?: (path: string) => Promise<Uint8Array>;
  /** A file's size in bytes, so `penmoss attach` refuses one too large before reading it. */
  readonly fileSize?: (path: string) => Promise<number>;
  /** For `penmoss mcp` and background syncs; absent where the CLI cannot run a stdio server. */
  readonly stdio?: StdioIo;
  /** Git notebooks (T50); absent where the CLI has no git or files. */
  readonly notebooks?: NotebookIo;
}
