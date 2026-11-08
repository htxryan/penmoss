import {
  STATUS_BAR_SETTING,
  statusBarFieldsOf,
  UNDER_TITLE_SETTING,
  underTitleFieldsOf,
  withField,
  type MetadataField,
} from '@penmoss/core/note-metadata';
import { useSyncExternalStore } from 'react';
import { useSourcesState } from '../sources/hooks';
import { useWorkspace } from '../workspace/hooks';
import type { Workspace } from '../workspace/service';

export interface NoteMetadataSettings {
  /** The fields under a note's title, in order. */
  readonly underTitle: readonly MetadataField[];
  /** The fields in the status bar, in order. */
  readonly statusBar: readonly MetadataField[];
  readonly setUnderTitle: (field: MetadataField, on: boolean) => void;
  readonly setStatusBar: (field: MetadataField, on: boolean) => void;
  /** Settings can change now: this device's copy is read (until then they are only defaults). */
  readonly canChange: boolean;
}

/**
 * Pinned metadata (T62 item 4): the fields under a note's title and in its status bar, from the
 * app's own settings (the Primary notebook's, as the sidebar's layout is).
 */
export function useNoteMetadataSettings(): NoteMetadataSettings {
  const inScope = useWorkspace();
  const sources = useSourcesState();
  const workspace: Workspace = sources?.root.workspace ?? inScope;
  // Re-renders when the settings change, here or by sync.
  const { loaded } = useSyncExternalStore(
    workspace.subscribe,
    workspace.getState,
    workspace.getState,
  );
  const settings = workspace.settings();
  // The settings now, not this render's: two quick changes must not undo each other.
  const setUnderTitle = (field: MetadataField, on: boolean) =>
    workspace.setSetting(
      UNDER_TITLE_SETTING,
      withField(underTitleFieldsOf(workspace.settings()), field, on),
    );
  const setStatusBar = (field: MetadataField, on: boolean) =>
    workspace.setSetting(
      STATUS_BAR_SETTING,
      withField(statusBarFieldsOf(workspace.settings()), field, on),
    );
  return {
    underTitle: underTitleFieldsOf(settings),
    statusBar: statusBarFieldsOf(settings),
    setUnderTitle,
    setStatusBar,
    canChange: loaded,
  };
}
