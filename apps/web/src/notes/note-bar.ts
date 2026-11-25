import { noteBarSetting } from '@penmoss/core/settings';
import { useSyncExternalStore } from 'react';
import { useAppWorkspace } from '../sources/hooks';
import { NOTE_BAR_BUTTONS, noteBarShows, type NoteBarButton } from './note-bar-buttons';

// The buttons' data lives in note-bar-buttons.ts; it is exported here again, so nothing changes
// its imports.
export {
  NOTE_BAR_BUTTONS,
  NOTE_BAR_BUTTON_INFO,
  noteBarShows,
  type NoteBarButton,
} from './note-bar-buttons';

/** The title bar's buttons, and a way to change which show. */
export function useNoteBar(): {
  readonly shown: readonly NoteBarButton[];
  readonly shows: (button: NoteBarButton) => boolean;
  readonly set: (button: NoteBarButton, shown: boolean) => void;
  readonly canChange: boolean;
} {
  // The app's own settings (the Journal notebook's, A827), whichever notebook the note is in.
  const workspace = useAppWorkspace();
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
