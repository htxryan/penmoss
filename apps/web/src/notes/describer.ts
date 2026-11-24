/**
 * AI Descriptions' describer (PEN-161, A1656): one per window, which watches each notebook's
 * notes change, waits for the pause (or the next sync, as Settings says), and asks the chosen AI
 * provider for a description of a note whose text changed since its description was written. It
 * writes the answer into the note's `description`, stamped with the hash of the text it describes,
 * so the same text is never described twice and its own write asks for nothing.
 *
 * - Only one window describes on its own (a Web Lock): the others still answer Describe Now.
 * - Nothing is sent unless the note's effective setting is On and this device's AI provider is
 *   chosen; a note with no body text is never sent; a description written by hand is never
 *   overwritten (unless the person asks with Describe Now).
 * - Failures are shown for the note (`status`) and never retried in a loop: the next change, or
 *   Describe Now, tries again.
 * - A tag's description (A1677) is written only when asked (Generate AI Description and
 *   Generate All on the Tags page), with the same provider and model, from the tag prompt.
 */
import {
  aiGlobalOf,
  aiProviderOf,
  AI_DESCRIPTION_NOTEBOOK_SETTING,
  cleanDescription,
  cutForPrompt,
  describeWhenOf,
  folderLevels,
  HAND_WRITTEN,
  modelOf,
  parseAiSetting,
  pauseSecondsOf,
  promptOf,
  renderPrompt,
  resolveAiDescription,
  tagPrompt,
  tagPromptOf,
  TAG_PROMPT_MAX_NOTES,
  type AiEffective,
  type TagPromptNote,
} from '@penmoss/core/ai-description';
import { tagMatches } from '@penmoss/core/tags';
import { folderPath } from '@penmoss/core/workspace';
import {
  needsDescription,
  noteTextHash,
  readAiSetting,
  readDescription,
  readDescriptionOf,
  setAiDescription,
} from '@penmoss/model/description';
import { bodyMarkdown } from '@penmoss/model/markdown';
import { isDeleted, readTitle } from '@penmoss/model/note';
import { noteTags } from '@penmoss/model/tags';
import { WORKSPACE_RECORD_KEY, type WorkspaceSnapshot } from '@penmoss/model/workspace';
import type * as Y from '@y/y';

type Settings = Readonly<Record<string, unknown>>;

/** What a provider answered (the Mac's `DesktopAiAnswer`, Android's the same shape). */
export type AiAnswer =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly code: string; readonly message: string };

/** The native side that holds the key or runs Claude Code. */
export interface AiBridge {
  describe(provider: string, model: string, prompt: string): Promise<AiAnswer | null>;
}

/** A note open for reading or writing, as the notes service gives it. */
interface OpenCopy {
  readonly ready: Promise<void>;
  readonly isLoaded: boolean;
  readonly isClosed: boolean;
  readonly replica: { readonly doc: Y.Doc };
  close(): void;
}

/** What the describer needs of a notebook. */
export interface DescriberSource {
  readonly id: string;
  readonly name: string;
  readonly notes: {
    openCopies(id: string): readonly OpenCopy[];
    openNote(id: string): OpenCopy;
    editNote(id: string, edit: (doc: Y.Doc) => void): Promise<void>;
    onStored(listener: (ids: readonly string[]) => void): () => void;
    onPulled(listener: (ids: readonly string[]) => void): () => void;
    subscribeSync(listener: () => void): () => void;
    syncState(): { readonly phase: string };
  };
  readonly workspace: {
    settings(): Settings;
    getState(): { readonly snapshot: WorkspaceSnapshot };
  };
}

export interface DescriberOptions {
  readonly sources: () => readonly DescriberSource[];
  readonly subscribeSources: (listener: () => void) => () => void;
  /** The app's settings: the primary notebook's, with this device's own over them. */
  readonly settings: () => Settings;
  readonly bridge: AiBridge | null;
  /** Holds the describer's lock while this window describes on its own; null: always. */
  readonly locks?: LockManager | null;
  readonly now?: () => number;
  readonly today?: () => string;
}

/**
 * A notebook as a tag's description needs it (A1677): its notes' list (title, the start of
 * the text, tags, when changed) and where its tag descriptions are kept.
 */
export interface TagDescriberSource extends DescriberSource {
  readonly notes: DescriberSource['notes'] & {
    list(): readonly {
      readonly id: string;
      readonly title: string;
      readonly excerpt: string;
      readonly updatedAt: number;
      readonly tags: readonly string[];
    }[];
  };
  readonly workspace: DescriberSource['workspace'] & {
    setTagDescription(tag: string, text: string): void;
    flush(): Promise<void>;
  };
}

/** What Generate AI Description came to: the text written and what it replaced, or why not. */
export type TagAnswer =
  | { readonly ok: true; readonly text: string; readonly before: string }
  | { readonly ok: false; readonly code: string; readonly message: string };

/** Nothing is sent without a provider: where to choose one. */
export const NO_PROVIDER = {
  ok: false,
  code: 'no-provider',
  message: 'Choose an AI provider in Settings → AI Descriptions.',
} as const;

/** One notebook's tags for Generate All. */
export interface TagGroup {
  readonly source: TagDescriberSource;
  readonly tags: readonly string[];
}

export type DescribeStatus =
  | { readonly state: 'idle' }
  | { readonly state: 'waiting'; readonly at: number }
  | { readonly state: 'describing' }
  | { readonly state: 'described'; readonly at: number }
  | { readonly state: 'error'; readonly message: string; readonly at: number };

const IDLE: DescribeStatus = { state: 'idle' };
/** How many notes Describe Notes Now describes at once. */
export const BATCH_AT_ONCE = 2;

export class Describer {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly syncDirty = new Map<string, Set<string>>();
  private readonly statuses = new Map<string, DescribeStatus>();
  private readonly listeners = new Set<() => void>();
  private readonly running = new Map<string, Promise<AiAnswer | null>>();
  private readonly tagsRunning = new Map<string, Promise<TagAnswer>>();
  private offs: Array<() => void> = [];
  private offSources: (() => void) | null = null;
  private leading = false;
  private releaseLock: (() => void) | null = null;

  constructor(private readonly options: DescriberOptions) {}

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  /** Starts describing on its own once this window holds the lock. */
  start(): void {
    const lead = () => {
      this.leading = true;
      this.watch();
      this.offSources = this.options.subscribeSources(() => this.watch());
    };
    const locks = this.options.locks;
    if (!locks) {
      lead();
      return;
    }
    void locks
      .request('penmoss-ai-describer', () => {
        lead();
        return new Promise<void>((resolve) => {
          this.releaseLock = resolve;
        });
      })
      .catch(() => undefined);
  }

  stop(): void {
    for (const off of this.offs) off();
    this.offs = [];
    this.offSources?.();
    this.offSources = null;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.releaseLock?.();
    this.releaseLock = null;
    this.leading = false;
  }

  private watch(): void {
    for (const off of this.offs) off();
    this.offs = [];
    for (const source of this.options.sources()) {
      const changed = (ids: readonly string[]) => this.changed(source, ids);
      this.offs.push(source.notes.onStored(changed), source.notes.onPulled(changed));
      let phase = source.notes.syncState().phase;
      this.offs.push(
        source.notes.subscribeSync(() => {
          const next = source.notes.syncState().phase;
          if (next === 'synced' && phase !== 'synced') this.synced(source);
          phase = next;
        }),
      );
    }
  }

  private key(sourceId: string, noteId: string): string {
    return `${sourceId}/${noteId}`;
  }

  /** Notes changed: each waits for the pause, or for the next sync. */
  private changed(source: DescriberSource, ids: readonly string[]): void {
    if (!this.leading) return;
    const settings = this.options.settings();
    if (aiProviderOf(settings) === 'none') return;
    const when = describeWhenOf(settings);
    const pause = pauseSecondsOf(settings) * 1000;
    for (const id of ids) {
      if (id === WORKSPACE_RECORD_KEY || id.includes('/')) continue;
      if (this.running.has(this.key(source.id, id))) continue;
      if (when === 'sync') {
        const dirty = this.syncDirty.get(source.id) ?? new Set<string>();
        dirty.add(id);
        this.syncDirty.set(source.id, dirty);
        continue;
      }
      const key = this.key(source.id, id);
      const timer = this.timers.get(key);
      if (timer) clearTimeout(timer);
      this.timers.set(
        key,
        setTimeout(() => {
          this.timers.delete(key);
          void this.run(source, id, false);
        }, pause),
      );
    }
  }

  private synced(source: DescriberSource): void {
    const dirty = this.syncDirty.get(source.id);
    if (!dirty || dirty.size === 0) return;
    this.syncDirty.delete(source.id);
    void this.batch(source, [...dirty], false);
  }

  /** How the note's setting resolves: note, folders, notebook, global (AD5). */
  effective(source: DescriberSource, noteId: string, doc: Y.Doc | null): AiEffective {
    const snapshot = source.workspace.getState().snapshot;
    const folderId = snapshot.notes.find((note) => note.id === noteId)?.folderId ?? null;
    return resolveAiDescription({
      note: doc ? readAiSetting(doc) : 'inherit',
      folders: folderLevels(snapshot.folders, folderId),
      notebook: {
        name: source.name,
        value: parseAiSetting(source.workspace.settings()[AI_DESCRIPTION_NOTEBOOK_SETTING]),
      },
      global: aiGlobalOf(this.options.settings()),
    });
  }

  /** A note's describe status, for the Metadata tab. */
  status(sourceId: string, noteId: string): DescribeStatus {
    return this.statuses.get(this.key(sourceId, noteId)) ?? IDLE;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private setStatus(sourceId: string, noteId: string, status: DescribeStatus): void {
    this.statuses.set(this.key(sourceId, noteId), status);
    for (const listener of this.listeners) listener();
  }

  /** The notebook's tags whose description is being generated now. */
  tagsBusyIn(sourceId: string): string[] {
    const prefix = `${sourceId}#`;
    return [...this.tagsRunning.keys()]
      .filter((key) => key.startsWith(prefix))
      .map((key) => key.slice(prefix.length))
      .sort();
  }

  /** Whether a tag's description is being generated now (the Tags page's row says so). */
  tagBusy(sourceId: string, tag: string): boolean {
    return this.tagsRunning.has(`${sourceId}#${tag}`);
  }

  /**
   * Generate AI Description (A1677): the tag prompt, with the notes carrying the tag (newest
   * first; their descriptions, read from the notes, or the start of their text) and the other
   * tags on them, sent to the provider; the answer is written into the notebook's
   * `tagDescriptions`. `cache` keeps the notes' descriptions across a Generate All.
   */
  describeTag(
    source: TagDescriberSource,
    tag: string,
    cache: Map<string, string | null> = new Map(),
  ): Promise<TagAnswer> {
    const key = `${source.id}#${tag}`;
    const running = this.tagsRunning.get(key);
    if (running) return running;
    const work = this.runTag(source, tag, cache).finally(() => {
      this.tagsRunning.delete(key);
      for (const listener of this.listeners) listener();
    });
    this.tagsRunning.set(key, work);
    for (const listener of this.listeners) listener();
    return work;
  }

  /**
   * Generate All (A1677): each notebook's tags, two at a time. `onProgress` hears each one
   * done; the answer counts those written and says the last failure.
   */
  async describeTags(
    groups: readonly TagGroup[],
    options: { readonly signal?: AbortSignal; readonly onProgress?: (done: number) => void } = {},
  ): Promise<{ written: number; failed: number; message: string | null }> {
    const jobs = groups.flatMap((group) =>
      group.tags.map((tag) => ({ source: group.source, tag })),
    );
    const caches = new Map<string, Map<string, string | null>>();
    let next = 0;
    let done = 0;
    const out = { written: 0, failed: 0, message: null as string | null };
    const work = async () => {
      while (next < jobs.length && !options.signal?.aborted) {
        const job = jobs[next++]!;
        const cache = caches.get(job.source.id) ?? new Map<string, string | null>();
        caches.set(job.source.id, cache);
        const answer = await this.describeTag(job.source, job.tag, cache);
        if (answer.ok) out.written += 1;
        else {
          out.failed += 1;
          out.message = answer.message;
        }
        done += 1;
        options.onProgress?.(done);
      }
    };
    await Promise.all(Array.from({ length: BATCH_AT_ONCE }, work));
    return out;
  }

  private async runTag(
    source: TagDescriberSource,
    tag: string,
    cache: Map<string, string | null>,
  ): Promise<TagAnswer> {
    const bridge = this.options.bridge;
    const settings = this.options.settings();
    const provider = aiProviderOf(settings);
    const model = modelOf(settings, provider);
    if (!bridge || provider === 'none' || !model) return NO_PROVIDER;
    const carrying = [...source.notes.list()]
      .filter((note) => note.tags.some((each) => tagMatches(each, tag)))
      .sort((a, b) => b.updatedAt - a.updatedAt);
    const notes: TagPromptNote[] = [];
    for (const [index, note] of carrying.entries()) {
      // Only the notes the prompt lists are read for their descriptions; the rest count.
      let description: string | null = null;
      if (index < TAG_PROMPT_MAX_NOTES) {
        if (!cache.has(note.id)) {
          cache.set(
            note.id,
            await this.withDoc(source, note.id, (doc) => readDescription(doc)).catch(() => null),
          );
        }
        description = cache.get(note.id) ?? null;
      }
      notes.push({ title: note.title, tags: note.tags, description, text: note.excerpt });
    }
    const described = () => source.workspace.getState().snapshot.tagDescriptions?.[tag] ?? '';
    const prompt = tagPrompt(tagPromptOf(settings), {
      tag,
      notes,
      notebook: source.name,
      description: described(),
      date: this.options.today?.() ?? new Date().toISOString().slice(0, 10),
    });
    const answer = await bridge.describe(provider, model, prompt).catch((error: unknown) => ({
      ok: false as const,
      code: 'failed',
      message: error instanceof Error ? error.message : String(error),
    }));
    if (!answer) return NO_PROVIDER;
    if (!answer.ok) return answer;
    const text = cleanDescription(answer.text);
    if (!text) {
      return {
        ok: false,
        code: 'failed',
        message: 'The AI provider answered with no description.',
      };
    }
    const before = described();
    source.workspace.setTagDescription(tag, text);
    await source.workspace.flush().catch(() => undefined);
    return { ok: true, text, before };
  }

  /** Describes one note now (Describe Now): no pause, and whatever its text's stamp. */
  describeNow(source: DescriberSource, noteId: string): Promise<AiAnswer | null> {
    const key = this.key(source.id, noteId);
    const timer = this.timers.get(key);
    if (timer) clearTimeout(timer);
    this.timers.delete(key);
    return this.run(source, noteId, true);
  }

  /**
   * Describes these notes a few at a time (Describe Notes Now, and At Sync): only those whose
   * text changed since their description, unless `force`. `onProgress` hears each one done.
   */
  async batch(
    source: DescriberSource,
    ids: readonly string[],
    force: boolean,
    options: { readonly signal?: AbortSignal; readonly onProgress?: (done: number) => void } = {},
  ): Promise<number> {
    let next = 0;
    let done = 0;
    const work = async () => {
      while (next < ids.length && !options.signal?.aborted) {
        const id = ids[next++]!;
        await this.run(source, id, force);
        done += 1;
        options.onProgress?.(done);
      }
    };
    await Promise.all(Array.from({ length: BATCH_AT_ONCE }, work));
    return done;
  }

  /** Whether a note would be described now: On, a provider chosen, text to describe, changed. */
  async wants(source: DescriberSource, noteId: string): Promise<boolean> {
    return this.withDoc(
      source,
      noteId,
      (doc) => this.eligible(source, noteId, doc, false) === null,
    );
  }

  /** Why the note is not sent, or null when it is. */
  private eligible(
    source: DescriberSource,
    noteId: string,
    doc: Y.Doc,
    force: boolean,
  ): string | null {
    if (isDeleted(doc)) return 'deleted';
    const settings = this.options.settings();
    if (aiProviderOf(settings) === 'none') return 'no provider';
    if (!this.effective(source, noteId, doc).on) return 'off';
    if (bodyMarkdown(doc).trim() === '') return 'empty';
    if (!force && readDescriptionOf(doc) === HAND_WRITTEN) return 'hand';
    if (!force && !needsDescription(doc)) return 'described';
    return null;
  }

  private async withDoc<T>(
    source: DescriberSource,
    noteId: string,
    read: (doc: Y.Doc) => T,
  ): Promise<T> {
    const open = source.notes.openCopies(noteId).find((note) => note.isLoaded && !note.isClosed);
    if (open) return read(open.replica.doc);
    const note = source.notes.openNote(noteId);
    try {
      await note.ready;
      return read(note.replica.doc);
    } finally {
      note.close();
    }
  }

  private run(source: DescriberSource, noteId: string, force: boolean): Promise<AiAnswer | null> {
    const key = this.key(source.id, noteId);
    const running = this.running.get(key);
    if (running) return running;
    const work = this.describe(source, noteId, force).finally(() => this.running.delete(key));
    this.running.set(key, work);
    return work;
  }

  private async describe(
    source: DescriberSource,
    noteId: string,
    force: boolean,
  ): Promise<AiAnswer | null> {
    const bridge = this.options.bridge;
    if (!bridge) return null;
    const settings = this.options.settings();
    const provider = aiProviderOf(settings);
    const model = modelOf(settings, provider);
    const asked = await this.withDoc(source, noteId, (doc) => {
      if (this.eligible(source, noteId, doc, force) !== null) return null;
      return { prompt: this.prompt(source, noteId, doc, settings), hash: noteTextHash(doc) };
    }).catch(() => null);
    if (!asked || !model) return null;
    this.setStatus(source.id, noteId, { state: 'describing' });
    const answer = await bridge.describe(provider, model, asked.prompt).catch((error: unknown) => ({
      ok: false as const,
      code: 'failed',
      message: error instanceof Error ? error.message : String(error),
    }));
    if (!answer) {
      this.setStatus(source.id, noteId, IDLE);
      return null;
    }
    if (!answer.ok) {
      this.setStatus(source.id, noteId, {
        state: 'error',
        message: answer.message,
        at: this.now(),
      });
      return answer;
    }
    const text = cleanDescription(answer.text);
    if (!text) {
      const message = 'The AI provider answered with no description.';
      this.setStatus(source.id, noteId, { state: 'error', message, at: this.now() });
      return { ok: false, code: 'failed', message };
    }
    let written = false;
    await source.notes.editNote(noteId, (doc) => {
      // Only for the text it read: a change meanwhile is described after its own pause.
      if (noteTextHash(doc) !== asked.hash) return;
      if (!force && readDescriptionOf(doc) === HAND_WRITTEN) return;
      setAiDescription(doc, text, asked.hash);
      written = true;
    });
    this.setStatus(source.id, noteId, written ? { state: 'described', at: this.now() } : IDLE);
    return { ok: true, text };
  }

  private prompt(source: DescriberSource, noteId: string, doc: Y.Doc, settings: Settings): string {
    const snapshot = source.workspace.getState().snapshot;
    const folderId = snapshot.notes.find((note) => note.id === noteId)?.folderId ?? null;
    const folder = folderId ? (folderPath(snapshot.folders, folderId) ?? '') : '';
    return renderPrompt(promptOf(settings), {
      title: readTitle(doc) || 'Untitled',
      body: cutForPrompt(bodyMarkdown(doc)),
      tags: noteTags(doc)
        .map((tag) => `#${tag}`)
        .join(' '),
      folder: folder || 'the top level',
      notebook: source.name,
      description: readDescription(doc) ?? '',
      date: this.options.today?.() ?? new Date().toISOString().slice(0, 10),
    });
  }
}

let current: Describer | null = null;

/** The window's describer, once `main.tsx` made it (null in tests and the capture window). */
export function windowDescriber(): Describer | null {
  return current;
}

export function installDescriber(describer: Describer): void {
  current?.stop();
  current = describer;
  describer.start();
}
