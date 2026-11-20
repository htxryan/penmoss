import { useEffect, useSyncExternalStore } from 'react';
import { deviceStorage } from '../shell/device-pref';
import { withoutRecording } from '../analytics/track';
import { copySettings, readInStep, writeInStep } from './copy-settings';
import type { OpenSourcesState } from './registry';

/**
 * Keeping every other notebook's settings in step with the primary's (Quanta feedback 3, item
 * 10; A1137): this Mac's choice, off until turned on in a notebook's settings. While on, a
 * change to the primary's settings is copied to the others, one way, a moment after it is made.
 */
const listeners = new Set<() => void>();
let inStep: boolean | null = null;

const read = (): boolean => (inStep ??= readInStep(deviceStorage()));

export function setSettingsInStep(on: boolean): void {
  inStep = on;
  writeInStep(deviceStorage(), on);
  for (const listener of listeners) listener();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export function useSettingsInStepChoice(): boolean {
  return useSyncExternalStore(subscribe, read, read);
}

/** Copies the primary's settings to the others while the choice is on. */
export function useSettingsInStep(state: OpenSourcesState): void {
  const on = useSettingsInStepChoice();
  useEffect(() => {
    if (!on || state.all.length < 2) return;
    const root = state.journal.workspace;
    const others = state.all.filter((source) => source.id !== state.journal.id);
    let timer: ReturnType<typeof setTimeout> | null = null;
    const push = () => {
      timer = null;
      if (!root.getState().loaded) return;
      for (const other of others) {
        // A copy of the person's change, which was recorded once as it was made (PEN-137).
        if (other.workspace.getState().loaded) {
          withoutRecording(() => copySettings(root, other.workspace));
        }
      }
    };
    const schedule = () => {
      timer ??= setTimeout(push, 300);
    };
    push();
    const offs = [root, ...others.map((other) => other.workspace)].map((workspace) =>
      workspace.subscribe(schedule),
    );
    return () => {
      if (timer !== null) clearTimeout(timer);
      for (const off of offs) off();
    };
  }, [on, state]);
}
