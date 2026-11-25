/**
 * A tag's AI description in a notebook's engine page on Android (A1677): the Mac's
 * (`Describer.describeTag` in `apps/web/src/notes/describer.ts`) for one notebook. Generate AI
 * Description sends core's `tagPrompt` (the tag prompt Settings shows, with the notes carrying
 * the tag and the other tags on them) through the app's provider (`ai.describe`; the page never
 * sees the key) and writes the answer into the notebook's `tagDescriptions` (PEN-68), which syncs.
 * Generate All does the same for every tag with no description, or every tag, two at a time.
 * Nothing is sent without a provider, and nothing runs on its own: only when asked.
 */
import {
  cleanDescription,
  tagPrompt,
  tagsToDescribe,
  type TagPromptNote,
} from '@penmoss/core/ai-description';
import type { AiAnswer, AiPort } from './describer';

/** What a tag's description needs of the notebook. */
export interface TagDescriberNotes {
  /** The notebook's live notes as a tag's prompt reads them, newest first. */
  promptNotes(): readonly TagPromptNote[];
  /** Each described tag's description. */
  descriptions(): Readonly<Record<string, string>>;
  /** Writes `tag`'s description (blank text clears it) as one change, saved and pushed. */
  setDescription(tag: string, text: string): Promise<void>;
  /** The notebook's name, as `{{notebook}}` says it. */
  readonly name: string;
}

/** How many tags Generate All describes at once (the Mac's `BATCH_AT_ONCE`). */
const AT_ONCE = 2;

const NO_PROVIDER: AiAnswer = {
  ok: false,
  code: 'no-provider',
  message: 'Choose an AI provider in Settings → AI Descriptions.',
};

export class TagDescriber {
  private readonly running = new Map<string, Promise<AiAnswer>>();

  constructor(
    private readonly notes: TagDescriberNotes,
    private readonly ai: AiPort,
    private readonly now: () => number = Date.now,
  ) {}

  /** Generate AI Description: the answer, written into the tag's description when it worked. */
  describe(tag: string): Promise<AiAnswer> {
    const running = this.running.get(tag);
    if (running) return running;
    const work = this.run(tag).finally(() => this.running.delete(tag));
    this.running.set(tag, work);
    return work;
  }

  /** The tags Generate All covers: those with no description, or every tag when `replace`. */
  wanted(replace: boolean): string[] {
    return tagsToDescribe(
      this.notes.promptNotes().map((note) => note.tags),
      this.notes.descriptions(),
      replace,
    );
  }

  /** Generate All: these tags, two at a time. How many were written. */
  async batch(tags: readonly string[]): Promise<number> {
    let next = 0;
    let done = 0;
    const work = async () => {
      while (next < tags.length) {
        const tag = tags[next++]!;
        if ((await this.describe(tag)).ok) done += 1;
      }
    };
    await Promise.all(Array.from({ length: AT_ONCE }, work));
    return done;
  }

  private async run(tag: string): Promise<AiAnswer> {
    const config = await this.ai.config().catch(() => null);
    if (!config?.ready) return NO_PROVIDER;
    const prompt = tagPrompt(config.tagPrompt, {
      tag,
      notes: this.notes.promptNotes(),
      notebook: this.notes.name,
      description: this.notes.descriptions()[tag] ?? null,
      date: new Date(this.now()).toISOString().slice(0, 10),
    });
    const answer = await this.ai.describe(prompt).catch((error: unknown) => ({
      ok: false as const,
      code: 'failed',
      message: error instanceof Error ? error.message : String(error),
    }));
    if (!answer.ok) return answer;
    const text = cleanDescription(answer.text);
    if (!text) {
      return {
        ok: false,
        code: 'failed',
        message: 'The AI provider answered with no description.',
      };
    }
    await this.notes.setDescription(tag, text);
    return { ok: true, text };
  }
}
