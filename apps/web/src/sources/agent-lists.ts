/**
 * The agents on this Mac as Settings → Agents reads them (A993, D52, A1578): each notebook's list
 * from main, the clients an agent's setup is shown for, and a refusal's words.
 */
import { useEffect, useState } from 'react';
import type { DesktopGit, GitAnswer, LocalAgentInfo } from '../desktop/bridge';

/** A refusal's words, or the window's when main answered nothing. */
export function said<T>(result: GitAnswer<T> | null): string | null {
  if (!result) return 'This window cannot change agents on this Mac.';
  return result.ok ? null : result.error.message;
}

/** A notebook's agents as main last said them, or why it could not say. */
export type AgentList =
  | { readonly agents: readonly LocalAgentInfo[]; readonly error?: undefined }
  | { readonly agents?: undefined; readonly error: string };

/**
 * Every notebook's agents, by its local id, read when the page opens and again for one notebook
 * after a change there (`reload`). A notebook not answered yet has no entry.
 */
export function useAgentLists(
  git: DesktopGit,
  localIds: readonly string[],
): { readonly lists: Readonly<Record<string, AgentList>>; readonly reload: (id: string) => void } {
  const [lists, setLists] = useState<Readonly<Record<string, AgentList>>>({});
  const [versions, setVersions] = useState<Readonly<Record<string, number>>>({});
  // One key for the effect: the ids, each with how often it was asked to read again.
  const key = JSON.stringify(localIds.map((id) => [id, versions[id] ?? 0]));
  useEffect(() => {
    let cancelled = false;
    for (const [id] of JSON.parse(key) as [string, number][]) {
      void git.agents(id).then(
        (result) => {
          if (cancelled) return;
          const list: AgentList = result?.ok
            ? { agents: result.value }
            : { error: said(result) ?? '' };
          setLists((was) => ({ ...was, [id]: list }));
        },
        () => undefined,
      );
    }
    return () => {
      cancelled = true;
    };
  }, [git, key]);
  return {
    lists,
    reload: (id) => setVersions((was) => ({ ...was, [id]: (was[id] ?? 0) + 1 })),
  };
}

/** The clients an agent's setup is shown for, and Connect's choice of agent. */
export type AgentClient = 'claude' | 'codex' | 'other';
export const AGENT_CLIENTS: ReadonlyArray<{ readonly id: AgentClient; readonly label: string }> = [
  { id: 'claude', label: 'Claude Code' },
  { id: 'codex', label: 'Codex' },
  { id: 'other', label: 'Other' },
];
