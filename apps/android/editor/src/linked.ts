/**
 * Other notes as the open note's links and embeds see them (T40 P7, LK2,
 * LK4; A470, A471): `[[Title#` headings and embedded sections.
 *
 * The page holds only the open note's document, and Kotlin never reads Yjs
 * (A11), so another note's body comes over the bridge as opaque updates: the
 * page asks `noteContent`, the app answers with what Room stores of it
 * (fetching it first when the phone does not hold it), and the page applies
 * them to a scratch document, reads the body as JSON and throws the document
 * away. Nothing is ever written to either note.
 *
 * An embed on screen follows its note (`watch`): the page asks `watchNote`,
 * and the app says `noteChanged` whenever the phone stores a change to it,
 * from this phone or from a sync, so the embed renders again.
 */
import { headingsOf, type DocJson } from '@penmoss/core/links';
import { bodyJson } from '@penmoss/sync-client/yjs14';
import * as Y from '@y/y';
import { fromBase64 } from 'lib0/buffer';
import { BRIDGE_VERSION, type FromEditor, type StoredUpdate, type ToEditor } from './protocol';

/** How long the page waits for the app to answer `noteContent` before it shows the note as missing. */
export const CONTENT_TIMEOUT_MS = 15_000;

/**
 * How long a body read for a note no embed watches is kept: `[[Title#` completion asks
 * again as the heading is typed, and an unwatched note may change at any time.
 */
export const UNWATCHED_CACHE_MS = 5_000;

/**
 * How long a note stays watched after its last embed goes, as the web keeps an embedded
 * note open (T13): an editor re-rendering its embeds keeps the watch.
 */
export const WATCH_RELEASE_MS = 2_000;

/** At most this many bodies of notes no embed shows are kept (T40 P7 review S5), newest read last. */
export const MAX_UNWATCHED_CACHED = 16;

interface Cached {
  readonly body: DocJson;
  readonly at: number;
}

interface Watch {
  readonly listeners: Set<() => void>;
  release: ReturnType<typeof setTimeout> | null;
}

/** A note's body from its stored updates, or null when they do not make a whole note. */
export function bodyOf(updates: readonly StoredUpdate[]): DocJson | null {
  const doc = new Y.Doc();
  try {
    for (const stored of updates) Y.applyUpdate(doc, fromBase64(stored.update));
    // Updates that build on something not among them would show a partial note.
    if (doc.store.pendingStructs !== null || doc.store.pendingDs !== null) return null;
    return bodyJson(doc);
  } catch {
    return null;
  } finally {
    doc.destroy();
  }
}

export class LinkedNotes {
  private readonly cache = new Map<string, Cached>();
  private readonly asking = new Map<string, Array<(body: DocJson | null) => void>>();
  private readonly watches = new Map<string, Watch>();

  constructor(
    private readonly post: (message: FromEditor) => void,
    /** The open note's own body, when `noteId` is the note open now. */
    private readonly openBody: (noteId: string) => DocJson | null,
    private readonly now: () => number = Date.now,
    private readonly timeoutMs: number = CONTENT_TIMEOUT_MS,
  ) {}

  /** A note's body as JSON, for embeds (T13); null when the phone has none of it. */
  body(noteId: string): Promise<DocJson | null> {
    const open = this.openBody(noteId);
    if (open) return Promise.resolve(open);
    this.prune();
    const cached = this.cache.get(noteId);
    if (cached) return Promise.resolve(cached.body);
    return new Promise((resolve) => {
      const waiting = this.asking.get(noteId);
      if (waiting) {
        waiting.push(resolve);
        return;
      }
      const asked = [resolve];
      this.asking.set(noteId, asked);
      // This request's own timeout: a later one for the same note keeps its full wait.
      setTimeout(() => {
        if (this.asking.get(noteId) === asked) this.answer(noteId, null);
      }, this.timeoutMs);
      this.post({ v: BRIDGE_VERSION, type: 'noteContent', noteId });
    });
  }

  /** A note's headings for `[[Title#` completion (T16), as the web lists them. */
  async headings(noteId: string): Promise<readonly string[]> {
    const body = await this.body(noteId);
    if (!body) return [];
    return [
      ...new Set(
        headingsOf(body)
          .map((heading) => heading.text.trim())
          .filter(Boolean),
      ),
    ];
  }

  /** Follows a note's changes while an embed shows it; returns the unsubscribe. */
  watch(noteId: string, listener: () => void): () => void {
    let watch = this.watches.get(noteId);
    if (!watch) {
      watch = { listeners: new Set(), release: null };
      this.watches.set(noteId, watch);
      this.post({ v: BRIDGE_VERSION, type: 'watchNote', noteId, on: true });
    }
    const current = watch;
    if (current.release !== null) clearTimeout(current.release);
    current.release = null;
    current.listeners.add(listener);
    return () => {
      current.listeners.delete(listener);
      if (current.listeners.size > 0 || current.release !== null) return;
      current.release = setTimeout(() => {
        current.release = null;
        if (current.listeners.size > 0 || this.watches.get(noteId) !== current) return;
        this.watches.delete(noteId);
        this.cache.delete(noteId);
        this.post({ v: BRIDGE_VERSION, type: 'watchNote', noteId, on: false });
      }, WATCH_RELEASE_MS);
    };
  }

  /** The app's answer to `noteContent`. */
  received(message: Extract<ToEditor, { type: 'noteContent' }>): void {
    const body = message.state === 'ok' ? bodyOf(message.updates) : null;
    if (body) {
      // Last in the map's order: the oldest unwatched bodies go first.
      this.cache.delete(message.noteId);
      this.cache.set(message.noteId, { body, at: this.now() });
      this.prune();
      // Nothing may ask for it again: let it go when it is stale, not when the page closes.
      if (!this.watches.has(message.noteId)) setTimeout(() => this.prune(), UNWATCHED_CACHE_MS);
    }
    this.answer(message.noteId, body);
  }

  /** A watched note changed on the phone: its body is read again, and its embeds render again. */
  changed(noteId: string): void {
    this.cache.delete(noteId);
    const watch = this.watches.get(noteId);
    for (const listener of [...(watch?.listeners ?? [])]) listener();
  }

  /** The notes whose bodies are kept now, oldest read first, for tests. */
  get cached(): readonly string[] {
    return [...this.cache.keys()];
  }

  /** The notes watched now, for tests. */
  get watched(): readonly string[] {
    return [...this.watches.keys()];
  }

  /**
   * Lets go of bodies no embed shows (T40 P7 review S5): any read longer ago than
   * [UNWATCHED_CACHE_MS], and past [MAX_UNWATCHED_CACHED] the oldest read. A watched note's
   * body stays until it changes or its last embed goes.
   */
  private prune(): void {
    const now = this.now();
    const unwatched: string[] = [];
    for (const [noteId, cached] of this.cache) {
      if (this.watches.has(noteId)) continue;
      if (now - cached.at >= UNWATCHED_CACHE_MS) this.cache.delete(noteId);
      else unwatched.push(noteId);
    }
    for (const noteId of unwatched.slice(0, Math.max(0, unwatched.length - MAX_UNWATCHED_CACHED))) {
      this.cache.delete(noteId);
    }
  }

  private answer(noteId: string, body: DocJson | null): void {
    const waiting = this.asking.get(noteId);
    if (!waiting) return;
    this.asking.delete(noteId);
    for (const resolve of waiting) resolve(body);
  }
}
