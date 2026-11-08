/**
 * Copy Agent Reference (T52 item 4) in the web and Mac apps: the note's title, id, notebook and
 * folders as core's `agentReference` writes them, for pasting into an agent conversation. The
 * note's ⋯ menu, its top bar and its right-click menu in the sidebar copy it.
 */
import { agentReference, type AgentReferenceInput } from '@penmoss/core/agent-reference';
import { copyText } from '@penmoss/editor';
import { defaultNotebookName, type WorkspaceSnapshot } from '@penmoss/sync-client/workspace';
import { useCallback } from 'react';
import { useSource } from '../sources/hooks';
import { useWorkspaceState } from '../workspace/hooks';
import { notebookOfNote } from '../workspace/notebooks';
import { folderTrail } from './crumbs';

/** What the status says once it is copied. */
export const COPIED_AGENT_REFERENCE = 'Copied Agent Reference';

/**
 * The reference's parts for a note: a note in a notebook names the notebook and the folders
 * below it; any other note names the default notebook, then its folders. A git notebook's note
 * (`gitNotebook`) names that notebook and is read through its local MCP server.
 */
export function agentReferenceInput(
  snapshot: WorkspaceSnapshot,
  id: string,
  title: string,
  gitNotebook: string | null = null,
): AgentReferenceInput {
  const trail = folderTrail(
    snapshot.folders,
    snapshot.notes.find((entry) => entry.id === id)?.folderId ?? null,
  );
  const notebook = notebookOfNote(snapshot, id);
  return {
    id,
    title,
    ...(notebook
      ? { notebook: notebook.name, folders: trail.slice(1) }
      : { notebook: gitNotebook ?? defaultNotebookName(snapshot), folders: trail }),
    ...(gitNotebook !== null ? { gitNotebook } : {}),
  };
}

/**
 * Writes the reference for a note to the clipboard, through the Mac app's clipboard when there is
 * one; resolves with whether it was written.
 */
export function useCopyAgentReference(): (id: string, title: string) => Promise<boolean> {
  const { snapshot } = useWorkspaceState();
  const source = useSource();
  const git = source?.kind === 'git' ? source.name : null;
  return useCallback(
    (id, title) =>
      copyText(document, agentReference(agentReferenceInput(snapshot, id, title, git))),
    [snapshot, git],
  );
}
