import { createContext, useContext, useSyncExternalStore } from 'react';
import { mainTabs, type TabsController } from './controller';
import type { TabsState } from './state';

const NONE = () => () => undefined;
const NULL = () => null;

/** The main window's tabs as they are now; null where there are none (a note window, a test). */
export function useTabsState(): TabsState | null {
  const tabs = useTabs();
  return useSyncExternalStore(
    tabs ? tabs.subscribe : NONE,
    tabs ? tabs.getState : NULL,
    tabs ? tabs.getState : NULL,
  );
}

/** The main window's tabs controller, through context (tests give their own). */
const TabsContext = createContext<TabsController | null>(null);

/** The controller in context, else the main window's own. */
export function useTabs(): TabsController | null {
  return useContext(TabsContext) ?? mainTabs();
}

/**
 * Where the open note's bar buttons go (PEN-140, A1505): the strip's right end in the main
 * window, which has no title row above the note. Null: the note keeps its own bar (a note window).
 */
export const TabStripEnd = createContext<HTMLElement | null>(null);

/** Where the note's bar buttons go now: the tab strip's end, or null for its title row. */
export function useStripEnd(): HTMLElement | null {
  return useContext(TabStripEnd);
}
