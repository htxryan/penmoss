/**
 * Send feedback in the Mac app (T49, D41; T57): the outbox and draft store, the sync
 * facts the context reports (when sync last finished, its last error), which windows show which
 * note, and the recent-errors ring. One per window, made in main.tsx.
 */
import { useContext, createContext, useSyncExternalStore } from 'react';
import type { AppSyncState } from '../notes/service';
import { parseFeedbackContext, type FeedbackContext as IssueContext } from '@penmoss/core/feedback';
import { isEmptyDescription, loadFeedbackMarkdown } from '@penmoss/editor/feedback';
import { errorRing, type ErrorRing } from './errors';
import { FeedbackOutbox, webLock, webLockWait } from './outbox';
import { Presence } from './presence';
import { desktop } from '../desktop/bridge';
import { sendFeedbackOnMac } from './send';
import {
  indexedDbFeedbackStore,
  type FeedbackDraftText,
  type FeedbackStore,
  type OutboxEntry,
} from './store';

/** What Edit did: the report is back in the form, or why not. */
export type EditResult = 'ok' | 'draft-open' | 'gone';

/** The form as it was sent, read from an entry made before entries kept it (A796). */
/** The form's draft for an entry taken back by Edit: as sent, with the context it was sent with. */
function draftOf(entry: OutboxEntry): FeedbackDraftText {
  const draft = entry.draft ?? draftOfPayload(entry);
  const context = draft.context ?? sentContext(entry);
  return { ...draft, ...(context ? { context } : {}), updatedAt: Date.now() };
}

/** The context in the entry's payload (the groups that were sent), if it reads as one. */
function sentContext(entry: OutboxEntry): IssueContext | undefined {
  try {
    const payload = JSON.parse(entry.payload) as Record<string, unknown>;
    return parseFeedbackContext(payload['context']) ?? undefined;
  } catch {
    return undefined;
  }
}

function draftOfPayload(entry: OutboxEntry): FeedbackDraftText {
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(entry.payload) as Record<string, unknown>;
  } catch {
    payload = {};
  }
  const text = typeof payload['description'] === 'string' ? payload['description'] : '';
  return {
    submissionId: entry.id,
    type: payload['type'] === 'bug' || payload['type'] === 'feature' ? payload['type'] : null,
    priority: [1, 2, 3, 4].includes(payload['priority'] as number)
      ? (payload['priority'] as 1 | 2 | 3 | 4)
      : null,
    title: entry.title,
    description: text
      ? { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] }
      : null,
    omitted: [],
    updatedAt: Date.now(),
  };
}

/** When sync last finished and what last stopped it, as the app showed them. */
export class SyncTracker {
  lastSynced: number | null = null;
  lastError: string | null = null;

  constructor(private readonly now: () => number = Date.now) {}

  observe(state: AppSyncState): void {
    if (state.phase === 'synced') this.lastSynced = this.now();
    if (state.phase === 'stopped') {
      const why = state.reason ? ` (${state.reason})` : '';
      this.lastError = `${state.phase}${why}${state.detail ? `: ${state.detail}` : ''}`;
    }
  }
}

export interface FeedbackServiceOptions {
  readonly syncState: () => AppSyncState;
  readonly subscribeSync: (listener: () => void) => () => void;
  readonly store?: FeedbackStore;
  readonly online?: () => boolean;
  readonly ring?: ErrorRing;
  readonly presence?: Presence;
  /** The Mac's main-process filer (tests pass one; null: none, so entries wait). */
  readonly file?: Parameters<typeof sendFeedbackOnMac>[0] | null;
  /** Says when the person saves or removes their GitHub token (the Mac's). */
  readonly onTokenChange?: ((listener: () => void) => () => void) | null;
}

export class FeedbackService {
  readonly store: FeedbackStore;
  readonly outbox: FeedbackOutbox;
  readonly sync = new SyncTracker();
  readonly presence: Presence;
  readonly errors: ErrorRing;
  private readonly offs: Array<() => void> = [];

  constructor(private readonly options: FeedbackServiceOptions) {
    this.store = options.store ?? indexedDbFeedbackStore();
    this.errors = options.ring ?? errorRing;
    this.presence = options.presence ?? new Presence();
    const online = options.online ?? (() => typeof navigator === 'undefined' || navigator.onLine);
    // The Mac app files it itself with the person's GitHub token (T57, A1010). Outside it there
    // is no filer, and entries wait in the outbox.
    const bridge = desktop()?.feedback;
    const file =
      options.file !== undefined
        ? options.file
        : bridge?.file
          ? (payload: string, shots: Parameters<NonNullable<typeof bridge.file>>[1]) =>
              bridge.file!(payload, shots)
          : null;
    this.outbox = new FeedbackOutbox({
      store: this.store,
      online,
      send: (entry: OutboxEntry) => sendFeedbackOnMac(file, entry),
      exclusive: webLock('penmoss-feedback-outbox'),
      exclusiveWait: webLockWait('penmoss-feedback-outbox'),
    });
  }

  /** Follows sync and the connection, and sends what waits. */
  start(target: Pick<Window, 'addEventListener' | 'removeEventListener'> | null = window): void {
    this.sync.observe(this.options.syncState());
    this.offs.push(this.options.subscribeSync(() => this.sync.observe(this.options.syncState())));
    // A token just saved sends what waited for one (A1012).
    const onToken =
      this.options.onTokenChange !== undefined
        ? this.options.onTokenChange
        : (listener: () => void) => desktop()?.githubToken?.onChange(listener) ?? (() => undefined);
    if (onToken) this.offs.push(onToken(() => void this.outbox.flushWaiting('no_github_token')));
    if (target) {
      const onOnline = () => void this.outbox.flush();
      target.addEventListener('online', onOnline);
      this.offs.push(() => target.removeEventListener('online', onOnline));
    }
    // The description's markdown codec, loaded while the app is online: the form may be opened
    // and sent after the connection drops (A796).
    loadFeedbackMarkdown().catch(() => undefined);
    void this.outbox.start().catch((error: unknown) => {
      console.error('[feedback] could not read the outbox', error);
    });
  }

  stop(): void {
    for (const off of this.offs.splice(0)) off();
    this.outbox.stop();
  }

  /**
   * Puts a report from the outbox back in the form (Edit, A796): the form as it was sent, its
   * screenshots as sent, the same submissionId; the entry goes. Refused while the form holds an
   * unsent report of its own, which it would replace.
   */
  async editEntry(id: string): Promise<EditResult> {
    const open = await this.store.readDraft().catch(() => null);
    if (
      open &&
      open.submissionId !== id &&
      (open.title.trim() !== '' ||
        !isEmptyDescription(open.description) ||
        open.screenshots.length > 0)
    ) {
      return 'draft-open';
    }
    // The draft is written first, under the send lock; only then does the entry go (A796).
    const entry = await this.outbox.discard(id, async (stored) => {
      const draft = draftOf(stored);
      await this.store.writeDraft(draft);
      await this.store.writeDraftScreenshots(
        stored.screenshots.map((shot, index) => ({
          id: `edit-${index}-${shot.name}`,
          name: shot.name,
          type: shot.type,
          blob: shot.blob,
          included: true,
        })),
      );
    });
    return entry ? 'ok' : 'gone';
  }
}

export const FeedbackContext = createContext<FeedbackService | null>(null);

/** The window's feedback service; null where the app runs without one (some tests). */
export function useFeedback(): FeedbackService | null {
  return useContext(FeedbackContext);
}

/** The outbox's entries (re-renders when they change). */
export function useOutbox(service: FeedbackService): readonly OutboxEntry[] {
  return useSyncExternalStore(
    service.outbox.subscribe,
    service.outbox.entries,
    service.outbox.entries,
  );
}
