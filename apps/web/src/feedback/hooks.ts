/**
 * The window's feedback service and its outbox, as views read them. Apart from service.ts, which
 * loads the editor for the Send Feedback form, so a view that only shows the service's state
 * (Settings → GitHub) doesn't bring the editor with it, as the relay's Add Notebook page (A1701).
 */
import { createContext, useContext, useSyncExternalStore } from 'react';
import type { OutboxEntry } from './store';
import type { FeedbackService } from './service';

export const FeedbackContext = createContext<FeedbackService | null>(null);

/** The window's feedback service; null where the app runs without one (some tests). */
export function useFeedback(): FeedbackService | null {
  return useContext(FeedbackContext);
}

/** The window's feedback service, for views that only show under it (the Send Feedback form). */
export function useFeedbackService(): FeedbackService {
  const feedback = useContext(FeedbackContext);
  if (!feedback) throw new Error('useFeedbackService outside FeedbackContext');
  return feedback;
}

/** The outbox's entries (re-renders when they change). */
export function useOutbox(service: FeedbackService): readonly OutboxEntry[] {
  return useSyncExternalStore(
    service.outbox.subscribe,
    service.outbox.entries,
    service.outbox.entries,
  );
}
