/**
 * AI Descriptions in a notebook's engine page on Android (PEN-161 T6, A1656): the Mac's describer
 * (`apps/web/src/notes/describer.ts`) for one notebook, on the engine's own notes. A note that
 * changed (here, or in a sync) is described after the pause, or once the notebook syncs, when
 * its setting comes to On and its text is not the text its description was written for.
 *
 * The app holds the key and makes the call (`ai.describe`); the page never sees the key. The app
 * says what is set (`ai.config`): whether this phone has a provider, Describe Notes, when, the
 * pause and the prompt, which live in the Primary Notebook and this phone's own settings. With no
 * provider nothing is sent, and the Mac describes the phone's notes once they sync. A failure
 * (no network, a refusal) is tried again only when the note next changes or the notebook syncs.
 */
import {
  aiGlobalOf,
  cleanDescription,
  cutForPrompt,
  DEFAULT_PROMPT,
  DEFAULT_TAG_PROMPT,
  folderLevels,
  HAND_WRITTEN,
  parseAiSetting,
  pauseSecondsOf,
  renderPrompt,
  resolveAiDescription,
  AI_DESCRIPTION_GLOBAL_SETTING,
  AI_DESCRIPTION_NOTEBOOK_SETTING,
  AI_DESCRIPTION_PAUSE_SETTING,
  type AiEffective,
} from '@penmoss/core/ai-description';
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
import { mergedSettings, readWorkspace } from '@penmoss/model/workspace';
import type * as Y from '@y/y';

/** What the app says is set, read afresh before each note is described. */
export interface AiConfig {
  /** This phone has a provider it can call: Anthropic, with a key kept here. */
  readonly ready: boolean;
  /** Describe Notes, for everything whose note, folders and notebook inherit. */
  readonly global: boolean;
  readonly when: 'pause' | 'sync';
  readonly pauseS: number;
  readonly prompt: string;
  /** The tag prompt (A1677): Generate AI Description on the Tags screen sends it. */
  readonly tagPrompt: string;
}

export type AiAnswer =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly code: string; readonly message: string };

/** The app's side: what is set, and the call. */
export interface AiPort {
  config(): Promise<AiConfig | null>;
  describe(prompt: string): Promise<AiAnswer>;
}

export interface DescriberNotes {
  /** The note's document, or undefined when the notebook has no such note. */
  note(id: string): Y.Doc | undefined;
  readonly workspace: Y.Doc;
  /** Runs a change alone, as the notes server's writes do, and saves it. */
  write(change: () => void): Promise<void>;
  /** The notebook's name, as the prompt's `{{notebook}}` says it. */
  readonly name: string;
}

/** Reads the app's answer to `ai.config`, or null for anything else. */
export function parseAiConfig(value: unknown): AiConfig | null {
  if (typeof value !== 'object' || value === null) return null;
  const input = value as Record<string, unknown>;
  const settings: Record<string, unknown> = {
    [AI_DESCRIPTION_GLOBAL_SETTING]: input['global'],
    [AI_DESCRIPTION_PAUSE_SETTING]: input['pauseS'],
  };
  return {
    ready: input['ready'] === true,
    global: aiGlobalOf(settings),
    when: input['when'] === 'sync' ? 'sync' : 'pause',
    pauseS: pauseSecondsOf(settings),
    prompt:
      typeof input['prompt'] === 'string' && input['prompt'].trim() !== ''
        ? input['prompt']
        : DEFAULT_PROMPT,
    tagPrompt:
      typeof input['tagPrompt'] === 'string' && input['tagPrompt'].trim() !== ''
        ? input['tagPrompt']
        : DEFAULT_TAG_PROMPT,
  };
}

/** Reads the app's answer to `ai.describe`. */
export function parseAiAnswer(value: unknown): AiAnswer {
  if (typeof value === 'object' && value !== null) {
    const input = value as Record<string, unknown>;
    if (input['ok'] === true && typeof input['text'] === 'string') {
      return { ok: true, text: input['text'] };
    }
    if (input['ok'] === false) {
      return {
        ok: false,
        code: typeof input['code'] === 'string' ? input['code'] : 'failed',
        message:
          typeof input['message'] === 'string' ? input['message'] : 'The description failed.',
      };
    }
  }
  return { ok: false, code: 'failed', message: 'The description failed.' };
}

/** How many notes Describe Notes Now sends at once (the Mac's `BATCH_AT_ONCE`). */
const BATCH_AT_ONCE = 2;

export class NotebookDescriber {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Notes waiting for the next sync (At Sync, or a failure to try again). */
  private readonly atSync = new Set<string>();
  private readonly running = new Set<string>();
  private stopped = false;

  constructor(
    private readonly notes: DescriberNotes,
    private readonly ai: AiPort,
    private readonly now: () => number = Date.now,
  ) {}

  /** Notes changed: each is described after its pause, or at the next sync. */
  changed(ids: Iterable<string>): void {
    if (this.stopped) return;
    const list = [...ids];
    if (list.length === 0) return;
    void this.ai
      .config()
      .catch(() => null)
      .then((config) => {
        if (!config?.ready || this.stopped) return;
        for (const id of list) {
          if (config.when === 'sync') {
            this.atSync.add(id);
            continue;
          }
          const timer = this.timers.get(id);
          if (timer) clearTimeout(timer);
          this.timers.set(
            id,
            setTimeout(() => {
              this.timers.delete(id);
              void this.describe(id);
            }, config.pauseS * 1000),
          );
        }
      });
  }

  /** The notebook synced: what waits for it is described now. */
  synced(): void {
    if (this.stopped || this.atSync.size === 0) return;
    const waiting = [...this.atSync];
    this.atSync.clear();
    void (async () => {
      for (const id of waiting) await this.describe(id);
    })();
  }

  stop(): void {
    this.stopped = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.atSync.clear();
  }

  /** How the note's setting resolves here: note, folders, notebook, then Describe Notes. */
  effective(id: string, doc: Y.Doc, global: boolean): AiEffective {
    const snapshot = readWorkspace(this.notes.workspace);
    const folderId = snapshot.notes.find((note) => note.id === id)?.folderId ?? null;
    return resolveAiDescription({
      note: readAiSetting(doc),
      folders: folderLevels(snapshot.folders, folderId),
      notebook: {
        name: this.notes.name,
        value: parseAiSetting(
          mergedSettings(this.notes.workspace)[AI_DESCRIPTION_NOTEBOOK_SETTING],
        ),
      },
      global,
    });
  }

  /** Describes one note when it wants it; true when a description was written. */
  async describe(id: string): Promise<boolean> {
    return (await this.run(id, false))?.ok === true;
  }

  /**
   * Describe Now: one note, no pause, whatever its text's stamp, over a hand-written one too.
   * The answer says what came of it, or null when it is not sent (off, empty, no provider).
   */
  describeNow(id: string): Promise<AiAnswer | null> {
    const timer = this.timers.get(id);
    if (timer) clearTimeout(timer);
    this.timers.delete(id);
    return this.run(id, true);
  }

  /** Describe Notes Now: these notes a few at a time, only text not yet described. */
  async batch(ids: readonly string[]): Promise<number> {
    let next = 0;
    let done = 0;
    const work = async () => {
      while (next < ids.length && !this.stopped) {
        const id = ids[next++]!;
        if ((await this.run(id, false))?.ok === true) done += 1;
      }
    };
    await Promise.all(Array.from({ length: BATCH_AT_ONCE }, work));
    return done;
  }

  /** Whether this phone can describe, and what the note's setting comes to and from where. */
  async status(id: string): Promise<{ ready: boolean; effective: AiEffective } | null> {
    const doc = this.notes.note(id);
    if (!doc) return null;
    const config = await this.ai.config().catch(() => null);
    return {
      ready: config?.ready === true,
      effective: this.effective(id, doc, config?.global ?? false),
    };
  }

  /** Whether a note would be described now: On, a provider, text, and changed since. */
  async wants(id: string): Promise<boolean> {
    const config = await this.ai.config().catch(() => null);
    const doc = this.notes.note(id);
    return !!config?.ready && !!doc && this.eligible(id, doc, config, false);
  }

  private eligible(id: string, doc: Y.Doc, config: AiConfig, force: boolean): boolean {
    if (isDeleted(doc)) return false;
    if (!this.effective(id, doc, config.global).on) return false;
    if (bodyMarkdown(doc).trim() === '') return false;
    if (!force && (readDescriptionOf(doc) === HAND_WRITTEN || !needsDescription(doc))) return false;
    return true;
  }

  private async run(id: string, force: boolean): Promise<AiAnswer | null> {
    if (this.stopped || this.running.has(id)) return null;
    this.running.add(id);
    try {
      const config = await this.ai.config().catch(() => null);
      if (!config?.ready) return null;
      const doc = this.notes.note(id);
      if (!doc || !this.eligible(id, doc, config, force)) return null;
      const hash = noteTextHash(doc);
      const answer = await this.ai
        .describe(this.prompt(id, doc, config.prompt))
        .catch((error: unknown) => ({
          ok: false as const,
          code: 'failed',
          message: error instanceof Error ? error.message : String(error),
        }));
      if (!answer.ok) {
        // Offline or refused: tried again at the next sync, or when the note next changes.
        this.atSync.add(id);
        return answer;
      }
      const text = cleanDescription(answer.text);
      if (!text) {
        return {
          ok: false,
          code: 'failed',
          message: 'The AI provider answered with no description.',
        };
      }
      let written = false;
      await this.notes.write(() => {
        const live = this.notes.note(id);
        // Only for the text it read: a change meanwhile is described after its own pause.
        if (!live || noteTextHash(live) !== hash) return;
        if (!force && readDescriptionOf(live) === HAND_WRITTEN) return;
        setAiDescription(live, text, hash);
        written = true;
      });
      return written ? { ok: true, text } : null;
    } finally {
      this.running.delete(id);
    }
  }

  private prompt(id: string, doc: Y.Doc, prompt: string): string {
    const snapshot = readWorkspace(this.notes.workspace);
    const folderId = snapshot.notes.find((note) => note.id === id)?.folderId ?? null;
    const folder = folderId ? (folderPath(snapshot.folders, folderId) ?? '') : '';
    return renderPrompt(prompt, {
      title: readTitle(doc) || 'Untitled',
      body: cutForPrompt(bodyMarkdown(doc)),
      tags: noteTags(doc)
        .map((tag) => `#${tag}`)
        .join(' '),
      folder: folder || 'the top level',
      notebook: this.notes.name,
      description: readDescription(doc) ?? '',
      date: new Date(this.now()).toISOString().slice(0, 10),
    });
  }
}
