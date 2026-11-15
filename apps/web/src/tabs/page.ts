/**
 * What a tab keeps of the page it shows (PEN-140, A1500): the place the note was scrolled to
 * and its note panel, open or closed and on which of its tabs. A note view reads them once, as it
 * mounts in the tab, and tells the tab as they change.
 */
import { useEffect, useRef, useState, type RefObject } from 'react';
import { useTabs } from './hooks';
import { activeTab, currentEntry, type Entry, type PanelState } from './state';

/** The page of the active tab as the view mounted: the tab, its path and what it kept. */
export interface TabPage {
  readonly tabId: string;
  readonly path: string;
  readonly entry: Entry;
}

/** The active tab's page now, once, as the calling view mounts; null without tabs. */
export function useTabPage(): TabPage | null {
  const tabs = useTabs();
  const [page] = useState<TabPage | null>(() => {
    if (!tabs) return null;
    const tab = activeTab(tabs.getState());
    const entry = currentEntry(tab);
    return { tabId: tab.id, path: entry.path, entry };
  });
  return page;
}

/** How often, at most, a scroll is written to the tab. */
export const SCROLL_WRITE_MS = 250;

/**
 * The view's scroll position, kept by its tab: restored once its content has laid out (unless
 * `skip`, a link to a heading, wins), and written as it scrolls and as the view goes.
 */
export function useTabScroll(
  page: TabPage | null,
  scroller: RefObject<HTMLElement | null>,
  ready: boolean,
  skip: boolean,
): void {
  const tabs = useTabs();
  const restored = useRef(false);
  useEffect(() => {
    const element = scroller.current;
    if (!page || !tabs || !ready || restored.current || !element) return;
    if (skip || page.entry.scrollTop <= 0) {
      restored.current = true;
      return;
    }
    // After the editor's first layout (its node views, its images' frames).
    const frame = requestAnimationFrame(() => {
      restored.current = true;
      element.scrollTop = page.entry.scrollTop;
    });
    return () => cancelAnimationFrame(frame);
  }, [page, tabs, ready, skip, scroller]);
  useEffect(() => {
    const element = scroller.current;
    if (!page || !tabs || !element) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    // Read as it scrolls: a view on its way out may already be out of the page, at 0.
    let last = page.entry.scrollTop;
    const write = () => {
      timer = null;
      tabs.remember(page.tabId, page.path, { scrollTop: last });
    };
    const onScroll = () => {
      if (!restored.current) return;
      last = element.scrollTop;
      timer ??= setTimeout(write, SCROLL_WRITE_MS);
    };
    element.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      element.removeEventListener('scroll', onScroll);
      if (timer !== null) {
        clearTimeout(timer);
        write();
      }
    };
  }, [page, tabs, scroller]);
}

/** Writes the view's note panel to its tab as it changes. */
export function useTabPanel(page: TabPage | null, panel: PanelState): void {
  const tabs = useTabs();
  const { open, tab } = panel;
  useEffect(() => {
    if (!page || !tabs) return;
    tabs.remember(page.tabId, page.path, { panel: { open, tab } });
  }, [page, tabs, open, tab]);
}
