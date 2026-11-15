/**
 * Which agent session made an edit (PEN-152; A1583): the client (Claude Code, Codex) and the
 * client's own session id, so History and Agent Activity name them instead of a label someone
 * typed. A writer records each session's edits in its saved state; a commit names, in a
 * `Penmoss-Session` trailer, every session whose edits it carries and the notes each touched.
 */

/** An agent session as the MCP server knows it. */
export interface AgentSession {
  /** The client's product name: "Claude Code", "Codex", or what the client calls itself. */
  readonly client: string;
  /** The client's own session id, or one the server made (`own`). */
  readonly session: string;
  /** The id is the server's, since the client gave none. */
  readonly own: boolean;
}

/** What a writer keeps of one session until its edits are committed. */
export interface SessionEdits extends AgentSession {
  /** The notes it changed, with when (epoch ms). */
  readonly notes: Readonly<Record<string, number>>;
  /** It changed the folder tree, tags or settings. */
  readonly workspace: boolean;
}

/** A session a commit names, and the notes it touched in that commit. */
export interface CommitSession extends AgentSession {
  readonly notes: readonly string[];
}

/** The key a session is kept under. */
export const sessionKey = (session: AgentSession): string =>
  `${session.client}\u0000${session.session}`;

/** A session id or client name as a trailer can hold it: no quotes, spaces or line breaks. */
const clean = (text: string, max: number) => text.replace(/[^A-Za-z0-9._:-]/g, '').slice(0, max);
const cleanClient = (text: string) =>
  text
    .replace(/["\r\n]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60) || 'Agent';

/** `Penmoss-Session: <session> "<client>"[ own][ <note id>…]`, one line per session. */
export function sessionTrailers(sessions: readonly CommitSession[]): string[] {
  return sessions.map((each) => {
    const id = clean(each.session, 80) || 'unknown';
    const notes = each.notes.length > 0 ? ` ${each.notes.join(' ')}` : '';
    return `Penmoss-Session: ${id} "${cleanClient(each.client)}"${each.own ? ' own' : ''}${notes}`;
  });
}

const TRAILER = /^Penmoss-Session: (\S+) "([^"]*)"( own)?((?: [0-9A-Z]{26})*)\s*$/gm;

/** The sessions a commit's trailers name, in order. */
export function commitSessions(message: string): CommitSession[] {
  const out: CommitSession[] = [];
  for (const match of message.matchAll(TRAILER)) {
    out.push({
      session: match[1]!,
      client: match[2]!,
      own: match[3] !== undefined,
      notes: (match[4] ?? '').trim().split(' ').filter(Boolean),
    });
  }
  return out;
}

/** How History and Agent Activity name a session: its client and the start of its id. */
export function sessionLabel(session: AgentSession): string {
  const id = session.own
    ? session.session.replace(/^penmoss-/, '').slice(-8)
    : session.session.slice(0, 8);
  return `${session.client} · ${id}${session.own ? ' (Penmoss’s id)' : ''}`;
}

/** The client's product name, from `initialize`'s `clientInfo`. */
export function clientName(
  info: { readonly name?: unknown; readonly title?: unknown } | null,
): string {
  const name = typeof info?.name === 'string' ? info.name : '';
  if (name === 'claude-code') return 'Claude Code';
  if (name === 'codex-mcp-client') return 'Codex';
  if (typeof info?.title === 'string' && info.title.trim()) return cleanClient(info.title);
  return name.trim() ? cleanClient(name) : 'Agent';
}

/**
 * The session of a call (A1583): the client's id in the request's `_meta` (Codex's `threadId`,
 * or `x-codex-turn-metadata.session_id`), else Claude Code's `CLAUDE_CODE_SESSION_ID` from the
 * server's environment, only when the client is Claude Code (Claude passes its parent's
 * environment on, so an inherited Codex variable proves nothing), else `own`.
 */
export function callSession(input: {
  readonly clientInfo: { readonly name?: unknown; readonly title?: unknown } | null;
  readonly meta: Readonly<Record<string, unknown>> | null;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly own: string;
}): AgentSession {
  const client = clientName(input.clientInfo);
  const meta = input.meta ?? {};
  const turn = meta['x-codex-turn-metadata'];
  const fromMeta =
    typeof meta['threadId'] === 'string'
      ? meta['threadId']
      : typeof turn === 'object' &&
          turn !== null &&
          typeof (turn as Record<string, unknown>)['session_id'] === 'string'
        ? ((turn as Record<string, unknown>)['session_id'] as string)
        : null;
  if (fromMeta && clean(fromMeta, 80)) return { client, session: clean(fromMeta, 80), own: false };
  const claude = input.env['CLAUDE_CODE_SESSION_ID'];
  if (input.clientInfo?.name === 'claude-code' && claude && clean(claude, 80)) {
    return { client, session: clean(claude, 80), own: false };
  }
  return { client, session: input.own, own: true };
}
