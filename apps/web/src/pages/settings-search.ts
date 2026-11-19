/**
 * Search Settings' state (PEN-146): the query and what it finds, for the field and the results
 * (SettingsSearch.tsx), and how an opened result is shown on its page (`revealSetting`).
 */
import { useId, useRef, useState, type RefObject } from 'react';
import type { SettingsSection } from '../router';
import { searchSettings, type SettingMatch } from './settings-index';

export interface SettingsSearchState {
  readonly query: string;
  readonly setQuery: (query: string) => void;
  readonly results: readonly SettingMatch[];
  readonly clear: () => void;
  readonly input: RefObject<HTMLInputElement | null>;
  /** The results list's id, which the field controls. */
  readonly listId: string;
}

export function useSettingsSearch(shown: readonly SettingsSection[]): SettingsSearchState {
  const [query, setQuery] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const listId = useId();
  // A few dozen entries: searched on each render, no memo needed.
  const results = searchSettings(query, shown);
  return { query, setQuery, results, clear: () => setQuery(''), input, listId };
}

/** How long a setting a result opened stays marked. */
const MARKED_MS = 2000;

/**
 * Scrolls to `[data-setting=id]` in `root` once it shows (a page may draw it after reading its
 * state), marks it for a moment and puts focus on its first control. Gives up after about a
 * second, leaving the page at its top. Answers the cleanup.
 */
export function revealSetting(root: HTMLElement | null, id: string, done: () => void): () => void {
  let frame = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let tries = 0;
  const find = () => {
    const row = root?.querySelector<HTMLElement>(`[data-setting="${CSS.escape(id)}"]`);
    if (!row) {
      if (++tries < 60) frame = requestAnimationFrame(find);
      else done();
      return;
    }
    // On a page with Settings and Preview tabs (A1633), a row on the tab not shown: show its tab.
    const panel = row.closest<HTMLElement>('[role="tabpanel"][hidden]');
    if (panel) {
      root?.querySelector<HTMLElement>(`[aria-controls="${CSS.escape(panel.id)}"]`)?.click();
      if (++tries < 60) frame = requestAnimationFrame(find);
      else done();
      return;
    }
    row.scrollIntoView?.({ block: 'center' });
    row.setAttribute('data-found', '');
    const control = row.querySelector<HTMLElement>(
      'input:not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled]), a[href]',
    );
    control?.focus({ preventScroll: true });
    timer = setTimeout(() => {
      row.removeAttribute('data-found');
      done();
    }, MARKED_MS);
  };
  find();
  return () => {
    cancelAnimationFrame(frame);
    if (timer !== undefined) clearTimeout(timer);
    root?.querySelector('[data-found]')?.removeAttribute('data-found');
  };
}
