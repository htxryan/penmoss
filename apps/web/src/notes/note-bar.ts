import type { IconName } from '@penmoss/ui/icons';
import { useSyncExternalStore } from 'react';
import { useSourcesState } from '../sources/hooks';
import { useWorkspace } from '../workspace/hooks';
import type { Workspace } from '../workspace/service';

/**
 * The buttons the note's title bar can show (Quanta feedback 3, item 5; A1134), chosen in
 * Settings → Display. Every one is also an item of the note's ⋯ menu, so a button left out is
 * one click further, never gone. Full Width and Copy Agent Reference show until changed: the
 * bar's buttons before the setting. One synced setting each (`noteBar.<button>`, true or
 * false), as the sidebar's shortcuts are (A576), so two devices choosing different buttons
 * never overwrite each other.
 */
export const NOTE_BAR_BUTTONS = [
  'fullWidth',
  'toggleSource',
  'copyMarkdown',
  'copyRich',
  'copyAgentReference',
  'pinQuickAccess',
  'openInNewWindow',
  'move',
  'delete',
] as const;
export type NoteBarButton = (typeof NOTE_BAR_BUTTONS)[number];

export interface NoteBarButtonInfo {
  readonly command: string;
  readonly icon: IconName;
  readonly label: string;
}

export const NOTE_BAR_BUTTON_INFO: Readonly<Record<NoteBarButton, NoteBarButtonInfo>> = {
  fullWidth: { command: 'note.fullWidth', icon: 'widthFull', label: 'Full Width' },
  toggleSource: { command: 'note.toggleSource', icon: 'md', label: 'Markdown Source' },
  copyMarkdown: { command: 'note.copyMarkdown', icon: 'md', label: 'Copy Note as Markdown' },
  copyRich: { command: 'note.copyRich', icon: 'copy', label: 'Copy Note as Rich Text' },
  copyAgentReference: {
    command: 'note.copyAgentReference',
    icon: 'agentRef',
    label: 'Copy Agent Reference',
  },
  pinQuickAccess: { command: 'note.pinQuickAccess', icon: 'pin', label: 'Pin to Quick Access' },
  openInNewWindow: {
    command: 'note.openInNewWindow',
    icon: 'windowNew',
    label: 'Open in New Window',
  },
  move: { command: 'note.move', icon: 'folder', label: 'Move to Folder' },
  delete: { command: 'note.delete', icon: 'trash', label: 'Move to Trash' },
};

const SHOWN_FIRST: ReadonlySet<NoteBarButton> = new Set(['fullWidth', 'copyAgentReference']);

/** The setting that holds whether `button` shows in the note's title bar. */
export const noteBarSetting = (button: NoteBarButton): string => `noteBar.${button}`;

/** Whether `button` shows, from the user's settings. */
export function noteBarShows(
  settings: Readonly<Record<string, unknown>>,
  button: NoteBarButton,
): boolean {
  const value = settings[noteBarSetting(button)];
  return typeof value === 'boolean' ? value : SHOWN_FIRST.has(button);
}

/** The title bar's buttons, and a way to change which show. */
export function useNoteBar(): {
  readonly shown: readonly NoteBarButton[];
  readonly shows: (button: NoteBarButton) => boolean;
  readonly set: (button: NoteBarButton, shown: boolean) => void;
  readonly canChange: boolean;
} {
  // The app's own settings (the Journal notebook's, A827), whichever notebook the note is in.
  const inScope = useWorkspace();
  const sources = useSourcesState();
  const workspace: Workspace = sources?.root.workspace ?? inScope;
  const { loaded } = useSyncExternalStore(
    workspace.subscribe,
    workspace.getState,
    workspace.getState,
  );
  const settings = workspace.settings();
  const set = (button: NoteBarButton, shown: boolean) =>
    workspace.setSetting(noteBarSetting(button), shown);
  const shows = (button: NoteBarButton) => noteBarShows(settings, button);
  return { shown: NOTE_BAR_BUTTONS.filter(shows), shows, set, canChange: loaded };
}
