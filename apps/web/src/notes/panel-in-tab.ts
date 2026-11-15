/**
 * A note view's side panel in a tab (PEN-140, A1500): its own open or closed state and panel
 * tab, seeded from this note's and this device's memory the first time the note shows in the tab
 * (A985, A936), and written back to both and to the tab as they change. Without tabs (a note
 * window), it is the note's and the device's memory alone, as before.
 */
import { useCallback, useState } from 'react';
import { useTabPage, useTabPanel, type TabPage } from '../tabs/page';
import type { NotePanelTab } from './NoteActions';
import { readNotePanelMode, useNotePanelMode, type NotePanelMode } from './panel-mode';
import { PANEL_TABS, panelTabPref } from './panel-tabs';

export interface NotePanelInTab {
  /** The active tab's page as the view mounted, null without tabs. */
  readonly tabPage: TabPage | null;
  readonly panelMode: NotePanelMode;
  readonly setPanelMode: (mode: NotePanelMode) => void;
  readonly panelTab: NotePanelTab;
  readonly setPanelTab: (tab: NotePanelTab) => void;
}

export function useNotePanelInTab(id: string, startedWide: boolean): NotePanelInTab {
  const tabPage = useTabPage();
  const tabPanel = tabPage?.entry.panel ?? null;
  const [rememberedMode, rememberPanelMode] = useNotePanelMode(id, startedWide);
  // Open or closed follows the note's own memory when it has one (A985), so the same note shows
  // it alike in every tab; the tab's own then, and the panel's tab is always the tab's.
  const [tabMode, setTabMode] = useState<NotePanelMode | null>(() =>
    tabPanel && readNotePanelMode(id) === null ? (tabPanel.open ? 'open' : 'closed') : null,
  );
  const panelMode = tabMode ?? rememberedMode;
  const setPanelMode = useCallback(
    (mode: NotePanelMode) => {
      setTabMode(mode);
      rememberPanelMode(mode);
    },
    [rememberPanelMode],
  );
  // Seeded from the tab, else this device's choice; each note view keeps its own while it is open.
  const [panelTab, setPanelTab] = useState<NotePanelTab>(
    () => PANEL_TABS.find((entry) => entry.tab === tabPanel?.tab)?.tab ?? panelTabPref.read(),
  );
  useTabPanel(tabPage, { open: panelMode === 'open', tab: panelTab });
  return { tabPage, panelMode, setPanelMode, panelTab, setPanelTab };
}
