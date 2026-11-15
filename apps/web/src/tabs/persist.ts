/**
 * The main window's tabs across restarts (PEN-140, A1496): the whole state, the closed list
 * too, under `penmoss.tabs.main` in this device's storage. A saved value is read as data from an
 * older or newer Penmoss, or a damaged one: anything off is left out, and nothing usable reads as
 * no saved tabs (the window then opens as before, on the last note opened).
 */
import type { KeyValueStore } from '../shell/key-value';
import {
  MAX_CLOSED,
  MAX_ENTRIES,
  MAX_SAVED,
  type ClosedTab,
  type Entry,
  type PanelState,
  type Tab,
  type TabsState,
} from './state';

/** The key of the main window's tabs; a second main window would need its own (A1496). */
export const TABS_KEY = 'penmoss.tabs.main';

const VERSION = 1;

/** The state as saved: at most 50 tabs, pinned first (they are first in the strip anyway). */
export function serialise(state: TabsState): string {
  const pinned = state.tabs.filter((tab) => tab.pinned);
  const rest = state.tabs.filter((tab) => !tab.pinned);
  const tabs = [...pinned, ...rest].slice(0, MAX_SAVED);
  const active = tabs.some((tab) => tab.id === state.active) ? state.active : tabs[0]?.id;
  return JSON.stringify({
    v: VERSION,
    active,
    tabs: tabs.map(saveTab),
    closed: state.closed.slice(-MAX_CLOSED).map((item) => ({
      position: item.position,
      tab: saveTab(item.tab),
    })),
  });
}

function saveTab(tab: Tab): unknown {
  return {
    id: tab.id,
    pinned: tab.pinned,
    index: tab.index,
    entries: tab.entries.map((item) => ({
      path: item.path,
      scrollTop: Math.round(item.scrollTop),
      ...(item.panel ? { panel: item.panel } : {}),
    })),
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** An in-app path: `/…`, never `//host`, and not too long. */
const isPath = (value: unknown): value is string =>
  typeof value === 'string' && value.length <= 2048 && /^\/(?![/\\])/.test(value);

function readPanel(value: unknown): PanelState | undefined {
  if (!isRecord(value)) return undefined;
  const { open, tab } = value;
  if (typeof open !== 'boolean' || typeof tab !== 'string' || tab.length > 40) return undefined;
  return { open, tab };
}

function readEntry(value: unknown): Entry | null {
  if (!isRecord(value) || !isPath(value['path'])) return null;
  const scroll = value['scrollTop'];
  const scrollTop =
    typeof scroll === 'number' && Number.isFinite(scroll) && scroll > 0 ? scroll : 0;
  const panel = readPanel(value['panel']);
  return { path: value['path'], scrollTop, ...(panel ? { panel } : {}) };
}

function readTab(value: unknown): Tab | null {
  if (!isRecord(value)) return null;
  const { id, pinned, index, entries } = value;
  if (typeof id !== 'string' || id.length === 0 || id.length > 64) return null;
  if (!Array.isArray(entries)) return null;
  const read = entries
    .slice(-MAX_ENTRIES)
    .map(readEntry)
    .filter((item): item is Entry => item !== null);
  if (read.length === 0) return null;
  const at = typeof index === 'number' && Number.isInteger(index) ? index : read.length - 1;
  return {
    id,
    pinned: pinned === true,
    entries: read,
    index: Math.min(Math.max(at, 0), read.length - 1),
  };
}

/** The saved state, or null when there is none worth showing. */
export function parse(raw: string | null): TabsState | null {
  if (raw === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(value) || value['v'] !== VERSION || !Array.isArray(value['tabs'])) return null;
  const seen = new Set<string>();
  const tabs: Tab[] = [];
  for (const item of value['tabs'].slice(0, MAX_SAVED)) {
    const tab = readTab(item);
    if (!tab || seen.has(tab.id)) continue;
    seen.add(tab.id);
    tabs.push(tab);
  }
  if (tabs.length === 0) return null;
  // Pinned ones first, whatever the value says.
  const ordered = [...tabs.filter((tab) => tab.pinned), ...tabs.filter((tab) => !tab.pinned)];
  const active =
    typeof value['active'] === 'string' && seen.has(value['active'])
      ? value['active']
      : ordered[0]!.id;
  const closed: ClosedTab[] = [];
  if (Array.isArray(value['closed'])) {
    for (const item of value['closed'].slice(-MAX_CLOSED)) {
      if (!isRecord(item)) continue;
      const tab = readTab(item['tab']);
      const position = item['position'];
      if (!tab || seen.has(tab.id)) continue;
      if (typeof position !== 'number' || !Number.isInteger(position) || position < 0) continue;
      seen.add(tab.id);
      closed.push({ tab, position });
    }
  }
  return { tabs: ordered, active, closed };
}

export function load(storage: KeyValueStore | null): TabsState | null {
  try {
    return parse(storage?.getItem(TABS_KEY) ?? null);
  } catch {
    return null;
  }
}

export function save(storage: KeyValueStore | null, state: TabsState): void {
  try {
    storage?.setItem(TABS_KEY, serialise(state));
  } catch {
    // Full or private: the tabs are this session's only.
  }
}
