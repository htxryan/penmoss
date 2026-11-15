/**
 * Two notebooks of one name on this Mac (Ryan's review of PR #192): `penmoss mcp --notebook
 * "<name>"` can't tell them apart (the CLI refuses it as ambiguous), so adding or renaming a
 * notebook to a name another one here has is warned about, with a free name to use instead.
 */
import { cleanNotebookName, NOTEBOOK_NAME_MAX } from '@penmoss/git-notebook/layout';
import { useState } from 'react';
import type { GitSource } from './git-source';
import { useAllSources } from './hooks';

/** How the CLI compares notebook names: its spaces trimmed, ignoring case (A1097). */
const folded = (name: string) => name.trim().replace(/\s+/g, ' ').toLowerCase();

/** The name of another notebook here that `name` clashes with, or null when it is free. */
export function nameClash(name: string, others: readonly string[]): string | null {
  const mine = folded(name);
  if (!mine) return null;
  return others.find((other) => folded(other) === mine) ?? null;
}

/** `name` made free: “Personal (2)”, or the next number no notebook here has. */
export function freeName(name: string, others: readonly string[]): string {
  const clean = name.trim().replace(/\s+/g, ' ');
  const base = clean.replace(/ \((\d+)\)$/, '');
  for (let n = 2; ; n++) {
    const suffix = ` (${n})`;
    const candidate = `${base.slice(0, NOTEBOOK_NAME_MAX - suffix.length).trimEnd()}${suffix}`;
    if (nameClash(candidate, others) === null) return candidate;
  }
}

/** The names of the notebooks on this Mac, but `except`'s (the one being renamed). */
export function useOtherNotebookNames(except?: string): readonly string[] {
  const all = useAllSources()?.all ?? [];
  return all.filter((source) => source.id !== except).map((source) => source.name);
}

/** A clash Rename found before it renamed: the name asked for, the other's, and a free one. */
export interface PendingClash {
  readonly name: string;
  readonly other: string;
  readonly suggestion: string;
}

/**
 * Rename for a git notebook (Ryan's review of PR #192), as the sidebar and Settings ask it: a
 * name another notebook here has is warned about first (`clash`); `rename` with `anyway` uses it.
 * Returns whether it renamed.
 */
export function useNotebookRename(source: GitSource) {
  const others = useOtherNotebookNames(source.id);
  const [clash, setClash] = useState<PendingClash | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const rename = async (asked: string, anyway = false): Promise<boolean> => {
    const name = cleanNotebookName(asked);
    setClash(null);
    if (name === null) {
      setMessage('A notebook needs a name.');
      return false;
    }
    if (name === source.name) return false;
    const other = nameClash(name, others);
    if (other !== null && !anyway) {
      setClash({ name, other, suggestion: freeName(name, others) });
      return false;
    }
    const why = await source.rename(name);
    setMessage(why ?? `Renamed to “${name}” on every device that syncs it.`);
    return why === null;
  };
  return { rename, clash, message, cancel: () => setClash(null) };
}
