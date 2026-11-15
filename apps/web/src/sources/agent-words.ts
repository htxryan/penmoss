/** Words about agents shared by Settings → Notebooks and Settings → Agents (A1098). */
import type { ActivityEntry } from '../agents/activity';
import type { LocalAgentInfo } from '../desktop/bridge';

/** The notebook's name as a shell word for `penmoss mcp --notebook` (D52). */
export function mcpName(name: string): string {
  return /^[A-Za-z0-9_./:=@%+-]+$/.test(name) ? name : `"${name.replace(/(["\\$`])/g, '\\$1')}"`;
}

/** An agent's name in the Agents table: the copy Penmoss makes for every agent is "Any Agent". */
export const agentName = (agent: Pick<LocalAgentInfo, 'automatic' | 'label'>): string =>
  agent.automatic ? 'Any Agent' : agent.label;

/**
 * When an agent last changed something in a notebook, from its Agent Activity (the last 30 days
 * of folders, note places and settings, by the agent's name in History); null when nothing.
 */
export function lastUsed(entries: readonly ActivityEntry[], label: string): number | null {
  let last: number | null = null;
  for (const entry of entries) {
    if (entry.actor.label === label && (last === null || entry.at > last)) last = entry.at;
  }
  return last;
}

const DAY_MS = 24 * 60 * 60_000;

/** An agent's status in the table: "Used today", "Used yesterday", "Used Nov 3", or "Ready". */
export function statusWords(used: number | null, now: number = Date.now()): string {
  if (used === null) return 'Ready';
  const day = (time: number) => {
    const date = new Date(time);
    return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  };
  const days = Math.round((day(now) - day(used)) / DAY_MS);
  if (days <= 0) return 'Used today';
  if (days === 1) return 'Used yesterday';
  const date = new Date(used);
  const thisYear = date.getFullYear() === new Date(now).getFullYear();
  return `Used ${date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(thisYear ? {} : { year: 'numeric' }),
  })}`;
}
