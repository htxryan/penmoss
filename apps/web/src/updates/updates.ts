/**
 * Auto-Update in the page (T64 item 2, A1112, A1196): main's state, kept current, and how it
 * reads. Main does the work (apps/desktop/src/updater.ts); UpdatesSettings.tsx shows it.
 */
import { useEffect, useState } from 'react';
import { desktop, type DesktopUpdates, type DesktopUpdateState } from '../desktop/bridge';

/** `0.1.436` as people read it: build 436. */
export function buildOf(version: string): string {
  return /^0\.1\.(\d+)$/.exec(version)?.[1] ?? version;
}

/** A version as people read it: `build 436` from before P5, else `version 0.2.0`. */
export function nameOf(version: string): string {
  const build = buildOf(version);
  return build === version ? `version ${version}` : `build ${build}`;
}

/** A build from main (`0.2.1-alpha.12`), not a stable release (A1196). */
export function isAlphaBuild(version: string): boolean {
  return /^\d+\.\d+\.\d+-/.test(version);
}

const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** Main's update state, kept current; null until read, or outside the Mac app. */
export function useUpdates(): { updates: DesktopUpdates; state: DesktopUpdateState | null } | null {
  const updates = desktop()?.updates ?? null;
  const [state, setState] = useState<DesktopUpdateState | null>(null);
  useEffect(() => {
    if (!updates) return;
    let live = true;
    void updates
      .state()
      .catch(() => null)
      .then((next) => {
        if (live && next) setState(next);
      });
    const off = updates.onChange((next) => {
      if (live) setState(next);
    });
    return () => {
      live = false;
      off();
    };
  }, [updates]);
  return updates ? { updates, state } : null;
}

/** What the last check found, in a sentence. */
export function updateStatus(state: DesktopUpdateState): string {
  const next = state.version ? capital(nameOf(state.version)) : 'A new build';
  switch (state.phase) {
    case 'checking':
      return 'Checking for updates…';
    case 'current':
      // An Alpha build switched to Stable keeps its build until a stable release is newer.
      return state.channel === 'stable' && isAlphaBuild(state.current)
        ? 'This is an Alpha build: Penmoss moves to Stable with the next stable release.'
        : 'Penmoss is up to date.';
    case 'available':
      return state.message
        ? `${next} is available, but it could not be downloaded: ${state.message}`
        : `${next} is available.`;
    case 'downloading':
      return `Downloading ${state.version ? nameOf(state.version) : 'the new build'}… ${state.percent ?? 0}%`;
    case 'ready':
      return `${next} is downloaded: Penmoss restarts into it now.`;
    case 'error':
      return `Penmoss could not check for updates: ${state.message ?? 'unknown error'}.`;
    case 'idle':
      return state.auto
        ? 'Penmoss checks for updates when it starts and every hour.'
        : 'Not checked yet.';
  }
}
