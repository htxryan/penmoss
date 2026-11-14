/**
 * The notice a newer build brings (T64 item 2), with Install and Restart and the download's
 * progress after it, and the one after an update, only when the new version has notes, with
 * What's New (PEN-110): as a model, what it says and what its buttons do. NotesShell keeps it, so a
 * dismissal holds when the window narrows or the sidebar collapses, and shows it in the sidebar's
 * bottom panel, on the rail, or as a toast where the sidebar is a drawer (PEN-135 item 10; the
 * views are in UpdatesSettings.tsx).
 */
import { useState } from 'react';
import { navigate } from '../router';
import { updatedNotice, WHATS_NEW_PATH } from './notes';
import { updateStatus, useReleaseNotes, useUpdates } from './updates';

export type UpdateNoticeModel =
  | {
      readonly kind: 'offered';
      /** "Build 440 is available.", then the download's progress. */
      readonly text: string;
      readonly phase: 'available' | 'downloading' | 'ready';
      readonly install: () => void;
      /** Only while it is offered: a download under way, or done, is not dismissed. */
      readonly dismiss: (() => void) | null;
    }
  | {
      readonly kind: 'updated';
      /** The version as people read it ("build 1313"). */
      readonly version: string;
      readonly whatsNew: () => void;
      readonly dismiss: () => void;
    };

/** Settings → Updates, where the rail's notice leads while a build is on offer. */
export const UPDATES_PATH = '/settings/updates';

/** The update notice in the Mac app's main window; null when there is nothing to say. */
export function useUpdateNotice(): UpdateNoticeModel | null {
  const found = useUpdates();
  const file = useReleaseNotes();
  const [dismissed, setDismissed] = useState<string | null>(null);
  /** The notice after an update was answered here, before main says so. */
  const [answered, setAnswered] = useState(false);
  const state = found?.state ?? null;
  if (!found || !state) return null;
  const { version, phase } = state;
  if (
    version &&
    (phase === 'available' || phase === 'downloading' || phase === 'ready') &&
    (phase !== 'available' || dismissed !== version)
  ) {
    return {
      kind: 'offered',
      text: updateStatus(state),
      phase,
      install: () => void found.updates.install().catch(() => null),
      dismiss: phase === 'available' ? () => setDismissed(version) : null,
    };
  }
  const updated = answered ? null : updatedNotice(file, state.current, state.updatedFrom);
  if (!updated) return null;
  const answer = (whatsNew: boolean) => {
    setAnswered(true);
    void found.updates.acknowledge?.().catch(() => null);
    if (whatsNew) navigate(WHATS_NEW_PATH);
  };
  return {
    kind: 'updated',
    version: updated,
    whatsNew: () => answer(true),
    dismiss: () => answer(false),
  };
}
