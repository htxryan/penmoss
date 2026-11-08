/**
 * Where Send feedback keeps its draft and its outbox on this device (T49, A796): an IndexedDB
 * database of its own (`penmoss-feedback`), apart from the notes' store so neither schema waits
 * on the other. Screenshots are kept as Blobs, written apart from the draft's text (which is
 * saved as you type) only when they change. The memory store stands in for tests.
 */
import type {
  FeedbackContext,
  FeedbackGroupId,
  FeedbackPriority,
  FeedbackType,
} from '@penmoss/core/feedback';
import type { JSONContent } from '@penmoss/editor/feedback';

export interface StoredScreenshot {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly blob: Blob;
  readonly included: boolean;
  /**
   * Taken by the app rather than chosen: `window` is the Mac's capture of the window behind the
   * form (offered unticked, made again each time the form opens, kept only when ticked), `tab`
   * the web's Capture this window.
   */
  readonly source?: 'window' | 'tab';
}

/** Whether a screenshot is kept with the draft: all but an unticked capture of the window. */
export const keptWithDraft = (shot: StoredScreenshot) => shot.source !== 'window' || shot.included;

/** An unsent form, kept until it is queued (then its entry keeps it) or discarded. */
export interface FeedbackDraft {
  readonly submissionId: string;
  readonly type: FeedbackType | null;
  readonly priority: FeedbackPriority | null;
  readonly title: string;
  /** The description editor's document. */
  readonly description: JSONContent | null;
  readonly screenshots: readonly StoredScreenshot[];
  readonly omitted: readonly FeedbackGroupId[];
  /**
   * A report taken back from the outbox (Edit) keeps the context it was captured with, every
   * group (the ticks are `omitted`); the form shows that, not the screen it is opened over.
   */
  readonly context?: FeedbackContext;
  readonly updatedAt: number;
}

/** The draft without its screenshots: what is saved as you type. */
export type FeedbackDraftText = Omit<FeedbackDraft, 'screenshots'>;

export type OutboxState = 'queued' | 'sending' | 'failed';

export interface OutboxError {
  readonly status: number;
  readonly code: string;
  readonly message: string;
}

/** A submission waiting to be sent, exactly as it will be sent. */
export interface OutboxEntry {
  readonly id: string;
  readonly createdAt: number;
  /** For Settings → Status. */
  readonly title: string;
  /** The `payload` part, as sent. */
  readonly payload: string;
  readonly screenshots: ReadonlyArray<{
    readonly name: string;
    readonly type: string;
    readonly blob: Blob;
  }>;
  readonly state: OutboxState;
  readonly attempts: number;
  /** Not tried again before this time (epoch ms). */
  readonly nextAt: number;
  readonly error: OutboxError | null;
  /**
   * The form as it was sent, so a report the server refused can be put back in the form and
   * edited (A796): kept until the report is filed or discarded. Absent on entries from before.
   */
  readonly draft?: FeedbackDraftText;
}

export interface FeedbackStore {
  /** The draft's text and its screenshots; null when there is no draft. */
  readDraft(): Promise<FeedbackDraft | null>;
  /** The draft's text; null removes the whole draft, screenshots too. */
  writeDraft(draft: FeedbackDraftText | null): Promise<void>;
  /** The draft's screenshots, written only when they change. */
  writeDraftScreenshots(screenshots: readonly StoredScreenshot[]): Promise<void>;
  listOutbox(): Promise<OutboxEntry[]>;
  putOutbox(entry: OutboxEntry): Promise<void>;
  deleteOutbox(id: string): Promise<void>;
}

export function memoryFeedbackStore(): FeedbackStore {
  let draft: FeedbackDraftText | null = null;
  let shots: readonly StoredScreenshot[] = [];
  const outbox = new Map<string, OutboxEntry>();
  return {
    readDraft: () => Promise.resolve(draft ? { ...draft, screenshots: shots } : null),
    writeDraft: (next) => {
      draft = next;
      if (!next) shots = [];
      return Promise.resolve();
    },
    writeDraftScreenshots: (next) => {
      shots = next.filter(keptWithDraft);
      return Promise.resolve();
    },
    listOutbox: () =>
      Promise.resolve([...outbox.values()].sort((a, b) => a.createdAt - b.createdAt)),
    putOutbox: (entry) => {
      outbox.set(entry.id, entry);
      return Promise.resolve();
    },
    deleteOutbox: (id) => {
      outbox.delete(id);
      return Promise.resolve();
    },
  };
}

const DB_NAME = 'penmoss-feedback';
const DB_VERSION = 1;
const DRAFTS = 'drafts';
const OUTBOX = 'outbox';
const DRAFT_KEY = 'draft';
const SHOTS_KEY = 'screenshots';

function promised<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

/** The IndexedDB store; falls back to memory where IndexedDB cannot open (private windows). */
export function indexedDbFeedbackStore(
  factory: IDBFactory | undefined = globalThis.indexedDB,
): FeedbackStore {
  let opening: Promise<IDBDatabase | null> | null = null;
  const fallback = memoryFeedbackStore();
  const db = () =>
    (opening ??= new Promise<IDBDatabase | null>((resolve) => {
      if (!factory) return resolve(null);
      const request = factory.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(DRAFTS)) database.createObjectStore(DRAFTS);
        if (!database.objectStoreNames.contains(OUTBOX)) {
          database.createObjectStore(OUTBOX, { keyPath: 'id' });
        }
      };
      request.onsuccess = () => {
        const database = request.result;
        // Another version of the app wants the database: let it, and open again next time.
        database.onversionchange = () => {
          database.close();
          opening = null;
        };
        resolve(database);
      };
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
    }));
  const run = async <T>(
    name: string,
    mode: IDBTransactionMode,
    work: (store: IDBObjectStore) => IDBRequest<T>,
  ): Promise<T | null> => {
    const database = await db();
    if (!database) return null;
    const transaction = database.transaction(name, mode);
    const done = new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB write failed'));
      transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB write aborted'));
    });
    const result = await promised(work(transaction.objectStore(name)));
    await done;
    return result;
  };
  const usable = async () => (await db()) !== null;
  return {
    async readDraft() {
      if (!(await usable())) return fallback.readDraft();
      const text = (await run(DRAFTS, 'readonly', (store) => store.get(DRAFT_KEY))) as
        (FeedbackDraftText & { screenshots?: StoredScreenshot[] }) | undefined;
      if (!text) return null;
      const shots = (await run(DRAFTS, 'readonly', (store) => store.get(SHOTS_KEY))) as
        StoredScreenshot[] | undefined;
      // A draft from before the screenshots were kept apart holds them itself.
      return { ...text, screenshots: shots ?? text.screenshots ?? [] };
    },
    async writeDraft(draft) {
      if (!(await usable())) return fallback.writeDraft(draft);
      if (draft) {
        await run(DRAFTS, 'readwrite', (store) => store.put(draft, DRAFT_KEY));
      } else {
        await run(DRAFTS, 'readwrite', (store) => store.delete(DRAFT_KEY));
        await run(DRAFTS, 'readwrite', (store) => store.delete(SHOTS_KEY));
      }
    },
    async writeDraftScreenshots(screenshots) {
      if (!(await usable())) return fallback.writeDraftScreenshots(screenshots);
      const kept = screenshots.filter(keptWithDraft);
      await run(DRAFTS, 'readwrite', (store) => store.put(kept, SHOTS_KEY));
    },
    async listOutbox() {
      if (!(await usable())) return fallback.listOutbox();
      const all = ((await run(OUTBOX, 'readonly', (store) => store.getAll())) ??
        []) as OutboxEntry[];
      return all.sort((a, b) => a.createdAt - b.createdAt);
    },
    async putOutbox(entry) {
      if (!(await usable())) return fallback.putOutbox(entry);
      await run(OUTBOX, 'readwrite', (store) => store.put(entry));
    },
    async deleteOutbox(id) {
      if (!(await usable())) return fallback.deleteOutbox(id);
      await run(OUTBOX, 'readwrite', (store) => store.delete(id));
    },
  };
}
