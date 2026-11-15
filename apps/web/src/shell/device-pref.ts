/**
 * A choice remembered on this device, in `localStorage` (a pane's width, a collapsed panel, the
 * tab last shown): how much room a view gets depends on the window, not on the person, so these
 * never sync. One helper for all of them: storage that throws (a private window) keeps the choice
 * for this page instead, every view showing it follows a change at once, and, where asked, so do
 * the other windows of this Mac (a note window drags the same pane widths).
 */
import { useCallback, useSyncExternalStore } from 'react';
import type { KeyValueStore } from './key-value';

/** This page's `localStorage`, or null where there is none or it cannot be reached. */
export function deviceStorage(): KeyValueStore | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export interface DevicePrefOptions<T> {
  /** The value for what is stored (null: nothing is). */
  readonly parse: (stored: string | null) => T;
  /** What to store for a value; null removes the key (as the default should). */
  readonly serialise: (value: T) => string | null;
  /** Follows the other windows' writes too (the `storage` event). Off unless asked. */
  readonly crossWindow?: boolean;
}

export interface DevicePref<T> {
  readonly read: () => T;
  readonly write: (value: T) => void;
  readonly subscribe: (listener: () => void) => () => void;
}

/**
 * The choice kept under `key`. `read` gives the same value until what is stored changes, so it
 * can be a `useSyncExternalStore` snapshot even when `parse` builds an object.
 */
export function devicePref<T>(key: string, options: DevicePrefOptions<T>): DevicePref<T> {
  const listeners = new Set<() => void>();
  /** What a refusing storage could not keep, for this page (undefined: none). */
  let kept: string | null | undefined;
  let cache: { readonly stored: string | null; readonly value: T } | null = null;

  const stored = (): string | null => {
    if (kept !== undefined) return kept;
    try {
      return deviceStorage()?.getItem(key) ?? null;
    } catch {
      return null;
    }
  };

  const changed = () => {
    for (const listener of listeners) listener();
  };

  return {
    read: () => {
      const now = stored();
      if (cache === null || cache.stored !== now)
        cache = { stored: now, value: options.parse(now) };
      return cache.value;
    },
    write: (value) => {
      const text = options.serialise(value);
      try {
        const storage = deviceStorage();
        if (!storage) throw new Error('No storage');
        if (text === null) storage.removeItem(key);
        else storage.setItem(key, text);
        kept = undefined;
      } catch {
        // Private mode: the choice lasts for this page only.
        kept = text;
      }
      changed();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      if (!options.crossWindow || typeof window === 'undefined') {
        return () => listeners.delete(listener);
      }
      const onStorage = (event: StorageEvent) => {
        if (event.key === null || event.key === key) listener();
      };
      window.addEventListener('storage', onStorage);
      return () => {
        listeners.delete(listener);
        window.removeEventListener('storage', onStorage);
      };
    },
  };
}

/** A device preference in React: its value, and a way to change it. */
export function useDevicePref<T>(pref: DevicePref<T>): readonly [T, (value: T) => void] {
  const value = useSyncExternalStore(pref.subscribe, pref.read, pref.read);
  const set = useCallback((next: T) => pref.write(next), [pref]);
  return [value, set] as const;
}
