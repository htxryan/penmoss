/**
 * Copy Agent Reference (T52 item 4; PEN-69) in the web and Mac apps: the one line core's
 * `agentReference` writes for a note, the MCP call that reads it by its short reference, for
 * pasting into an agent conversation. The note's ⋯ menu, its top bar and its right-click menu in
 * the sidebar copy it.
 */
import { agentReference, type AgentReferenceInput } from '@penmoss/core/agent-reference';
import { copyText } from '@penmoss/editor';
import type { WorkspaceSnapshot } from '@penmoss/model/workspace';
import { useCallback } from 'react';
import { useSource } from '../sources/hooks';
import { useWorkspaceState } from '../workspace/hooks';

/** What the status says once it is copied. */
export const COPIED_AGENT_REFERENCE = 'Copied Agent Reference';

/**
 * The reference's parts for a note: a git notebook's note (`git`: its notebook's id) is named by
 * its short reference, which finds its notebook on the one MCP server (PEN-155); any other by
 * its id.
 */
export function agentReferenceInput(
  snapshot: WorkspaceSnapshot,
  id: string,
  git: { readonly id: string } | null = null,
): AgentReferenceInput {
  return git === null
    ? { id }
    : {
        id,
        notebookId: git.id,
        noteIds: snapshot.notes.map((note) => note.id),
      };
}

/**
 * Writes the reference for a note to the clipboard, through the Mac app's clipboard when there is
 * one; resolves with whether it was written.
 */
export function useCopyAgentReference(): (id: string) => Promise<boolean> {
  const { snapshot } = useWorkspaceState();
  const source = useSource();
  const gitId = source?.kind === 'git' ? source.id : null;
  return useCallback(
    (id) =>
      copyText(
        document,
        agentReference(agentReferenceInput(snapshot, id, gitId !== null ? { id: gitId } : null)),
      ),
    [snapshot, gitId],
  );
}
