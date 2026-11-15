/** What a git notebook's engine is given, what a sync is told and what it reports (T50, A822). */
import type { NotebookStorage } from '../replica';
import type { GitTransport } from '../transport';
import type { WriterKind, WriterSecrets } from '../writer';

/** "At most 3 times" (A822): the first attempt and three rebuilds. */
export const MAX_ATTEMPTS = 4;
/** The largest writer log read (A822): a bigger one is skipped and reported, never loaded. */
export const MAX_LOG_BYTES = 32 * 1024 * 1024;
/** The largest actor file read. */
export const MAX_ACTOR_BYTES = 1024 * 1024;
/**
 * A writer that has written with this many client ids retires (A850): the next sync makes a new
 * writer, with a new id, secret and actor file, as a copied profile does. Every writing process
 * takes a new client id (A821) and its actor file lists them all; 20,000 ids are about 220 KB,
 * well inside `MAX_ACTOR_BYTES`.
 */
export const RETIRE_WRITER_AFTER_IDS = 20_000;

export interface EngineOptions {
  readonly transport: GitTransport;
  readonly storage: NotebookStorage;
  /** Where this writer's secret lives (A821): the Keychain, the CLI's credential store. */
  readonly secrets: WriterSecrets;
  readonly writer: { readonly kind: WriterKind; readonly label: string };
  /**
   * Make the notebook when the target has none (a new notebook); otherwise it must be there.
   * `salt` only for the notebook imported from the personal workspace (`''`, A1021).
   */
  readonly create?: { readonly id?: string; readonly name: string; readonly salt?: string };
  readonly clock?: () => number;
  /** The writer's Yjs client id, overriding the stored one (tests only). */
  readonly clientID?: number;
  /** When this writer retires for a new one (default `RETIRE_WRITER_AFTER_IDS`; tests lower it). */
  readonly retireWriterAfterIds?: number;
  /** The largest actor file written (default `MAX_ACTOR_BYTES`; tests lower it). */
  readonly maxActorBytes?: number;
  /**
   * The client confirms what it showed of the repository's changes (`confirmGitChanges`): until
   * then they are given again, after a restart too. The Mac's engine host, whose windows read a
   * separate store, sets it; the CLI reads the docs themselves.
   */
  readonly confirmDelivery?: boolean;
  readonly random?: () => number;
  readonly newId?: () => string;
  readonly log?: (message: string) => void;
  /** The largest log read (default `MAX_LOG_BYTES`; tests lower it). */
  readonly maxLogBytes?: number;
  /**
   * Where copies withheld from the push are kept (A886): Android's Room, as kept-aside rows the
   * person can save, delete or keep and sync. Called before a copy leaves the notebook; a throw
   * fails the sync with nothing changed or pushed. Without it, the engine's own store keeps each
   * copy's whole doc (`withheld` in its bookkeeping).
   */
  readonly withhold?: (copies: readonly CopyToWithhold[]) => Promise<void>;
  /**
   * Test hook: a deliberate bug, to show the convergence checks catch it (G0's mutations).
   * `no-claims` stores no names; `narrow-render` renders only notes whose own logs changed.
   */
  readonly mutation?: 'no-claims' | 'narrow-render';
}

/** A copy the engine withholds from the push (A886), as `withhold` is handed it. */
export interface CopyToWithhold {
  readonly id: string;
  /** The original's id, deleted for good on another device. */
  readonly origin: string;
  readonly title: string;
  readonly folderId: string | null;
  /** The copy's whole doc, every edit made on it here included. */
  readonly update: Uint8Array;
}

export interface SyncOptions {
  /** Recompute every note's own file, not only changed ones (`penmoss notebook sync --full`). */
  readonly full?: boolean;
  /**
   * Stops the sync: once aborted, every git call it would make next fails as `timeout`, so a
   * caller whose time is up ends it at the next call (with the transport's `cancel` for the one
   * running). Changes are kept, as after any failure.
   */
  readonly signal?: AbortSignal;
  /** Test hook: between building a commit and pushing it (throw to crash there). */
  readonly beforePush?: (commit: string) => void | Promise<void>;
  /** Test hook: once the push landed, before the engine records it (throw to lose it). */
  readonly afterPush?: (commit: string) => void | Promise<void>;
}

export interface SyncReport {
  /** The branch's head after the sync. */
  readonly head: string | null;
  /** The commit this sync landed, or null when there was nothing to commit. */
  readonly commit: string | null;
  /** Builds it took (1 when no push was rejected). */
  readonly attempts: number;
  /** Notes the repository changed here (other writers' edits), for the client to refresh. */
  readonly changed: readonly string[];
  /** The WorkspaceDoc changed here (tree, names, Trash, purges). */
  readonly workspaceChanged: boolean;
  /** Notes dropped because someone deleted them for good. */
  readonly purged: readonly string[];
  /** Notes the commit carries (logs or rendered files). */
  readonly notes: number;
  /** Rendered files someone edited by hand, overwritten by this render (Status lists them). */
  readonly handEdits: readonly string[];
  /** Files under `<dir>` Penmoss did not write, relative to it (A217; left alone). */
  readonly foreign: readonly string[];
  /** A newer client owns the render (`renderVersion`): this one wrote logs only (A823). */
  readonly renderSkipped: boolean;
  /** This profile got a new writer id (its first sync, or a copied profile, A821). */
  readonly newWriter: string | null;
  /** The client id this writer writes with (a new one for every process, A821). */
  readonly clientId: number;
  /** Files at head this writer could not read and left out (path → why); Status lists them. */
  readonly skipped: Readonly<Record<string, string>>;
  /** `.md` files carrying a note's id where Penmoss did not put them: left alone, reported. */
  readonly copies: readonly string[];
}
