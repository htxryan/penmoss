/**
 * What a note's side panel shows (T51, A936): the note's Metadata (`info`, the Info panel of T41),
 * its Comments (T48), its Version History (T21) or its Local Graph (T17). The last one shown is
 * remembered per device.
 */
import { devicePref } from '../shell/device-pref';
import type { NotePanelTab } from './NoteActions';

const PANEL_TAB_KEY = 'penmoss.notePanelTab';

/** The side panel's tabs in order: each with its command, which opens it or closes the panel. */
export const PANEL_TABS: ReadonlyArray<{
  readonly tab: NotePanelTab;
  readonly label: string;
  readonly icon: 'info' | 'comment' | 'history' | 'graph';
  readonly command: string;
}> = [
  { tab: 'info', label: 'Metadata', icon: 'info', command: 'note.backlinks' },
  { tab: 'comments', label: 'Comments', icon: 'comment', command: 'note.comments' },
  { tab: 'history', label: 'History', icon: 'history', command: 'note.history' },
  { tab: 'graph', label: 'Local Graph', icon: 'graph', command: 'note.localGraph' },
];

/** The side panel's tab last shown on this device (Metadata until one is). */
export const panelTabPref = devicePref<NotePanelTab>(PANEL_TAB_KEY, {
  parse: (stored) => PANEL_TABS.find((entry) => entry.tab === stored)?.tab ?? 'info',
  serialise: (tab) => tab,
});
