/**
 * Search by meaning for `penmoss mcp` over every notebook (PEN-153, A1157, A1350, A1355): the
 * model opens once in a worker thread, however many notebooks are served, and each notebook has
 * a meaning index of its own over the one vector cache. While this process holds the Mac's one
 * indexing lease it indexes every served notebook, a slice at a time, in turn; without the lease
 * a search embeds only within its small budget. Whoever holds the lease, each notebook claims the
 * vectors its notes use every ten minutes, so the app's compaction keeps them.
 */
import { MeaningIndex } from '@penmoss/core/search';
import { LEASE_RETRY_MS, LeaseKeeper } from '@penmoss/embed/lease-keeper';
import type { LocalMeaning, LocalNotebook } from '@penmoss/git-notebook/local';
import type { MeaningIo, OpenedMeaning } from '../io';
import {
  CLAIM_EVERY_MS,
  EDIT_INDEX_DELAY_MS,
  INDEX_EVERY_MS,
  INDEX_SLICE_MS,
  MCP_MEANING_BUDGET_MS,
  Timers,
} from './mcp-session';

/** A notebook the model serves: a slot of `McpNotebooks`. */
export interface MeaningTarget {
  /** Stays the same while the notebook is served (the clone's local id). */
  readonly key: string;
  readonly name: string;
  /** Where its claim is kept: the clone's directory. */
  readonly owner: string;
  /** Reads its notes under the clone's lock, without counting as an agent's use. */
  read<T>(run: (notebook: LocalNotebook) => T | Promise<T>): Promise<T>;
  /** Searches by meaning with this from now on (null: by words), on every clone it opens. */
  give(meaning: LocalMeaning | null): void;
}

export interface SharedMeaningOptions {
  readonly indexEveryMs?: number;
  readonly leaseRetryMs?: number;
  readonly claimEveryMs?: number;
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

export class SharedMeaning {
  private opened: OpenedMeaning | null = null;
  private keeper: LeaseKeeper | null = null;
  private holder = false;
  private serving = true;
  private readonly indexes = new Map<string, MeaningIndex>();
  /** The notebooks with notes still to index, by key. */
  private readonly waiting = new Set<string>();
  /** Where the turn is: the key indexed last. */
  private last: string | null = null;
  private readonly timers = new Timers();
  private opening: Promise<void> | null = null;

  constructor(
    private readonly meaning: MeaningIo,
    private readonly targets: () => readonly MeaningTarget[],
    private readonly log: (text: string) => void,
    private readonly options: SharedMeaningOptions = {},
  ) {}

  /** Opens the model, once; calls wait for it (about two seconds), so meaning answers. */
  open(): Promise<void> {
    this.opening ??= this.openModel();
    return this.opening;
  }

  /** Whether this process indexes now (tests, logs). */
  get indexing(): boolean {
    return this.holder;
  }

  /** The notebooks served changed: the new ones search by meaning and are indexed. */
  served(): void {
    if (!this.opened) return;
    for (const target of this.targets()) {
      if (this.indexes.has(target.key)) continue;
      this.give(target);
      this.waiting.add(target.key);
      void this.claim(target);
    }
    this.soon(0);
  }

  /** An agent's edit is found by meaning a moment after it settles (A1160). */
  edited(key: string): void {
    this.waiting.add(key);
    this.soon(EDIT_INDEX_DELAY_MS);
  }

  /**
   * Settings → Search by Meaning switched off while serving (A1158): the model closes and the
   * tools answer by words (the app removes the model and the vectors).
   */
  async stillOn(): Promise<void> {
    if (!this.opened) return;
    const status = await this.meaning.status().catch(() => null);
    if (status?.enabled && status.state === 'ready') return;
    const opened = this.opened;
    if (!opened) return;
    this.opened = null;
    for (const target of this.targets()) target.give(null);
    this.indexes.clear();
    this.waiting.clear();
    this.timers.clear();
    this.log('penmoss: Search by Meaning is off: searching by words only');
    await this.keeper?.stop();
    await opened.close();
  }

  async close(): Promise<void> {
    this.serving = false;
    this.timers.clear();
    await this.opening;
    await this.keeper?.stop();
    await this.opened?.close();
    this.opened = null;
  }

  private async openModel(): Promise<void> {
    try {
      const opened = await this.meaning.open('mcp', { thread: true });
      if (!opened) return;
      if (!this.serving) {
        await opened.close();
        return;
      }
      this.opened = opened;
      // Tried for at once and again every retryMs, so a holder that dies or quits is replaced
      // (A1350).
      this.keeper = new LeaseKeeper(() => opened.lease(), {
        retryMs: this.options.leaseRetryMs ?? LEASE_RETRY_MS,
        onChange: (held) => {
          if (this.opened !== opened) return;
          this.holder = held;
          for (const target of this.targets()) this.give(target);
          if (held) {
            this.log(
              `penmoss: indexing ${this.targets()
                .map((each) => each.name)
                .join(', ')} for meaning`,
            );
            for (const target of this.targets()) this.waiting.add(target.key);
            this.soon(0);
          } else {
            this.log('penmoss: another process indexes for meaning now');
            this.timers.cancel('index');
          }
        },
        log: (text) => this.log(`penmoss: ${text}`),
      });
      await this.keeper.start();
      this.served();
      this.timers.every(
        'claim',
        this.options.claimEveryMs ?? CLAIM_EVERY_MS,
        () => void this.claimAll(),
        true,
      );
    } catch (error) {
      this.log(`penmoss: searching by words only: ${message(error)}`);
    }
  }

  private indexOf(target: MeaningTarget): MeaningIndex {
    let index = this.indexes.get(target.key);
    if (!index) {
      index = new MeaningIndex(this.opened!.embedder, this.opened!.cache);
      this.indexes.set(target.key, index);
    }
    return index;
  }

  private give(target: MeaningTarget): void {
    if (!this.opened) return;
    target.give({
      index: this.indexOf(target),
      budgetMs: this.holder ? 0 : MCP_MEANING_BUDGET_MS,
    });
  }

  private soon(ms: number): void {
    if (!this.serving || !this.holder || !this.opened) return;
    this.timers.later('index', ms, () => void this.slice(), true);
  }

  /** The next notebook in turn with notes to index, after the one indexed last. */
  private next(): MeaningTarget | null {
    const targets = this.targets().filter((each) => this.waiting.has(each.key));
    if (targets.length === 0) return null;
    const keys = this.targets().map((each) => each.key);
    const after = this.last === null ? -1 : keys.indexOf(this.last);
    return targets.find((each) => keys.indexOf(each.key) > after) ?? targets[0] ?? null;
  }

  /** One slice of one notebook, then the next notebook's turn. */
  private async slice(): Promise<void> {
    const opened = this.opened;
    const keeper = this.keeper;
    if (!opened || !keeper || !this.serving) return;
    const every = this.options.indexEveryMs ?? INDEX_EVERY_MS;
    const target = this.next();
    if (!target) {
      // Every notebook indexed: look again later for what other writers pushed.
      for (const each of this.targets()) this.waiting.add(each.key);
      this.soon(every);
      return;
    }
    try {
      // The app's service may have taken the lease (A1350): then this one only searches.
      if (!(await keeper.check())) return;
      const index = this.indexOf(target);
      const notes = await target.read((notebook) => notebook.meaningNotes());
      if (this.opened !== opened) return;
      await index.update(notes, { budgetMs: INDEX_SLICE_MS, batch: 2 });
      this.last = target.key;
      if (index.waiting === 0) this.waiting.delete(target.key);
      this.soon(this.waiting.size > 0 ? 0 : every);
    } catch (error) {
      this.log(`penmoss: indexing ${target.name} for meaning stopped: ${message(error)}`);
      this.last = target.key;
      this.waiting.delete(target.key);
      this.soon(this.waiting.size > 0 ? 0 : every);
    }
  }

  private async claimAll(): Promise<void> {
    for (const target of this.targets()) await this.claim(target);
  }

  /**
   * Whoever holds the lease, the notebook claims the vectors its notes use, so the app's
   * compaction keeps them though the app may never open it (PEN-134, A1355).
   */
  private async claim(target: MeaningTarget): Promise<void> {
    const opened = this.opened;
    const claim = opened?.cache.claim?.bind(opened.cache);
    if (!opened || !claim || !this.serving) return;
    try {
      const index = this.indexOf(target);
      const notes = await target.read((notebook) => notebook.meaningNotes());
      await index.update(notes, { embed: false });
      await claim(target.owner, index.usedKeys());
    } catch (error) {
      this.log(`penmoss: could not claim ${target.name}'s vectors: ${message(error)}`);
    }
  }
}
