/**
 * Agent sessions in a git notebook's WorkspaceDoc (T60, A1060): where Send to… finds the Claude
 * Code sessions that can receive a thread, now that no server keeps a list (A908 lifted).
 *
 * - `agentSessions`: session key → { writer, label, name, host, startedAt, lastSeen }, one plain
 *   value per session. Only the session's own channel writes its entry (at start and every
 *   HEARTBEAT_MS); whichever channel writes next removes entries not seen for FORGET_MS.
 *
 * A session is the agent clone's writer (T54) plus the channel's name, so restarting the channel
 * in the same directory is the same session. Nothing here is secret: the list lives in the
 * notebook's private repository, which everyone who reads it can already read in full.
 */
import * as Y from '@y/y';
import { readThreads, setThreadDelivery } from './comments';

export const WORKSPACE_AGENT_SESSIONS = 'agentSessions';

/** How often a running channel refreshes `lastSeen`. */
export const HEARTBEAT_MS = 60 * 60_000;
/** A session seen this recently is shown as running. */
export const ACTIVE_MS = 2 * HEARTBEAT_MS;
/** Sessions seen this recently are offered by Send to…; older ones are not. */
export const OFFERED_MS = 7 * 24 * 60 * 60_000;
/** A thread waiting this long for a session that has not been seen fails (`gone`). */
export const GONE_MS = OFFERED_MS;
/** Entries not seen for this long are removed. */
export const FORGET_MS = 30 * 24 * 60 * 60_000;

export interface AgentSession {
  /** `sessionKey(writer, name)`. */
  readonly key: string;
  /** The agent clone's writer id (a ULID). */
  readonly writer: string;
  /** What the picker shows, e.g. "Claude Code · penmoss". */
  readonly label: string;
  /** The channel's `--name`, by default `<host>:<working directory>`. */
  readonly name: string;
  readonly host: string;
  readonly startedAt: number;
  readonly lastSeen: number;
}

/** The first 24 hex digits of SHA-256 over the writer and the name (A773's shape, A1060). */
export async function sessionKey(writer: string, name: string): Promise<string> {
  const bytes = new TextEncoder().encode(`penmoss-channel\n${writer}\n${name}`);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest.subarray(0, 12), (b) => b.toString(16).padStart(2, '0')).join('');
}

const text = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0 ? value : null;
const time = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;

function sessionOf(key: string, value: unknown): AgentSession | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  const writer = text(v['writer']);
  const name = text(v['name']);
  const lastSeen = time(v['lastSeen']);
  if (!writer || !name || lastSeen === null) return null;
  return {
    key,
    writer,
    name,
    label: text(v['label']) ?? name,
    host: text(v['host']) ?? '',
    startedAt: time(v['startedAt']) ?? lastSeen,
    lastSeen,
  };
}

/** Every listed session, the most recently seen first (ties by label). */
export function readAgentSessions(doc: Y.Doc): AgentSession[] {
  const out: AgentSession[] = [];
  for (const [key, value] of doc.get(WORKSPACE_AGENT_SESSIONS).attrEntries()) {
    const session = sessionOf(String(key), value);
    if (session) out.push(session);
  }
  return out.sort((a, b) => b.lastSeen - a.lastSeen || a.label.localeCompare(b.label));
}

export function readAgentSession(doc: Y.Doc, key: string): AgentSession | null {
  return sessionOf(key, doc.get(WORKSPACE_AGENT_SESSIONS).getAttr(key));
}

export function isActive(session: Pick<AgentSession, 'lastSeen'>, now: number): boolean {
  return now - session.lastSeen <= ACTIVE_MS;
}

/** What Send to… offers: sessions seen within OFFERED_MS, running ones first. */
export function offeredSessions(doc: Y.Doc, now: number): AgentSession[] {
  const recent = readAgentSessions(doc).filter((s) => now - s.lastSeen <= OFFERED_MS);
  return [...recent.filter((s) => isActive(s, now)), ...recent.filter((s) => !isActive(s, now))];
}

/**
 * Writes the session's entry (the channel at start and on each heartbeat) and removes entries
 * not seen for FORGET_MS. Without `startedAt`, an existing entry's is kept.
 */
export function recordAgentSession(
  doc: Y.Doc,
  session: Omit<AgentSession, 'startedAt'> & { readonly startedAt?: number },
  origin: unknown = null,
): void {
  const root = doc.get(WORKSPACE_AGENT_SESSIONS);
  const current = readAgentSession(doc, session.key);
  const entry = {
    writer: session.writer,
    label: session.label,
    name: session.name,
    host: session.host,
    startedAt: session.startedAt ?? current?.startedAt ?? session.lastSeen,
    lastSeen: session.lastSeen,
  };
  doc.transact(() => {
    root.setAttr(session.key, entry);
    for (const other of readAgentSessions(doc)) {
      if (session.lastSeen - other.lastSeen > FORGET_MS) root.deleteAttr(other.key);
    }
  }, origin);
}

/**
 * Fails every delivery in a note still `waiting` for a session not seen for GONE_MS, or no longer
 * listed (A1062). The app showing the note calls it; it returns the threads it failed.
 */
export function failGoneDeliveries(
  note: Y.Doc,
  workspace: Y.Doc,
  now: number,
  origin: unknown = null,
): string[] {
  return failGoneDeliveriesSeen(
    note,
    (key) => readAgentSession(workspace, key)?.lastSeen ?? null,
    now,
    origin,
  );
}

/**
 * `failGoneDeliveries` for a page that holds the note but not the WorkspaceDoc (Android's editor,
 * T60 A1077): `lastSeen` answers a listed session's last-seen time, or null when it is not listed.
 */
export function failGoneDeliveriesSeen(
  note: Y.Doc,
  lastSeen: (session: string) => number | null,
  now: number,
  origin: unknown = null,
): string[] {
  const failed: string[] = [];
  for (const thread of readThreads(note)) {
    const { target, delivery } = thread;
    if (!target || delivery?.state !== 'waiting' || delivery.session !== target.session) continue;
    const seen = lastSeen(target.session);
    if (seen !== null && now - seen <= GONE_MS) continue;
    const done = setThreadDelivery(
      note,
      thread.id,
      { ...delivery, state: 'failed', reason: 'gone', at: now },
      origin,
    );
    if (done) failed.push(thread.id);
  }
  return failed;
}
