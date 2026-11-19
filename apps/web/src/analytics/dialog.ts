/**
 * Dialogs by name (PEN-137): `useTrackedDialog(name)` records `open` as a dialog opens, then
 * `done` or `cancel` as it closes, with how long it was open (a bucket). A dialog that finishes
 * its job calls `done()` before it closes; closing any other way is a cancel.
 */
import { durationBucket } from '@penmoss/core/analytics';
import { useEffect, useMemo, useRef } from 'react';
import { record } from './record';

export interface TrackedDialog {
  /** The dialog did what it was opened for: its close records `done`. */
  done(): void;
}

/**
 * Tracks the dialog `name` while `open` (a dialog mounted only while it shows leaves `open` out).
 * `name` is a catalogue name (DIALOG_NAMES), never built from data.
 */
export function useTrackedDialog(name: string, open: boolean = true): TrackedDialog {
  const current = useRef<{ done: boolean } | null>(null);
  useEffect(() => {
    if (!open) return;
    const opened = { done: false };
    const at = Date.now();
    current.current = opened;
    record('dialog', name, { action: 'open' });
    return () => {
      if (current.current === opened) current.current = null;
      record('dialog', name, {
        action: opened.done ? 'done' : 'cancel',
        open: durationBucket(Date.now() - at),
      });
    };
  }, [name, open]);
  return useMemo(
    () => ({
      done: () => {
        if (current.current) current.current.done = true;
      },
    }),
    [],
  );
}
