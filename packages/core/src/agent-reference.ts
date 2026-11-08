/**
 * Copy Agent Reference (T52 item 4): a few lines of plain text naming a note so an agent can find
 * it through Penmoss's MCP server: its title, where it is filed (the notebook, then its folders),
 * and the read_note call that reads it, which holds the id (once: T53 item 7). Ryan pastes it into
 * an agent conversation.
 *
 * Every client produces the same text from the same parts: the web and Mac apps call this, and
 * Android matches apps/android/contract/agent-reference-v1.json (written from this function by
 * apps/web/test/unit/agent-reference-contract.test.ts).
 *
 * ```
 * Penmoss note "Plans" (Personal › Penmoss)
 * Read it with the Penmoss MCP tool read_note {"id":"01JBXYZ…"}
 * ```
 */

export interface AgentReferenceInput {
  /** The note's id (a ULID). */
  readonly id: string;
  /** Its title; empty reads as "Untitled". */
  readonly title: string;
  /** The notebook's name: a notebook's own, or the default notebook's (e.g. "Personal"). */
  readonly notebook: string;
  /** The folders the note is in below the notebook, outermost first; empty at its top level. */
  readonly folders: readonly string[];
  /**
   * A git notebook's note (T50) is not on the Penmoss server: it is read through that notebook's
   * local MCP server (`penmoss mcp --notebook <name>`), named here.
   */
  readonly gitNotebook?: string;
}

/** Between the notebook and each folder. */
export const AGENT_REFERENCE_SEPARATOR = ' › ';

/** One line: every run of whitespace (line breaks, tabs) as one space, trimmed. */
const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim();

/** Inside double quotes: backslashes and double quotes escaped, as JSON escapes them. */
const quoted = (text: string) => `"${oneLine(text).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/** The reference's text: two lines, without a final line break. */
export function agentReference(input: AgentReferenceInput): string {
  const id = oneLine(input.id);
  const title = oneLine(input.title) || 'Untitled';
  const place = [input.notebook, ...input.folders]
    .map(oneLine)
    .filter((part) => part !== '')
    .join(AGENT_REFERENCE_SEPARATOR);
  const call = `read_note {"id":"${id}"}`;
  const how =
    input.gitNotebook === undefined
      ? `Read it with the Penmoss MCP tool ${call}`
      : `Read it with the git notebook’s local Penmoss MCP (penmoss mcp --notebook ${quoted(input.gitNotebook)}) tool ${call}`;
  return [`Penmoss note ${quoted(title)}${place ? ` (${place})` : ''}`, how].join('\n');
}
