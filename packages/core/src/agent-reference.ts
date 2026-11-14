/**
 * Copy Agent Reference (T52 item 4; shortened by PEN-69): one line of plain text naming a note
 * so an agent can read it through Penmoss's MCP server: the server (a git notebook's local one,
 * `penmoss mcp --notebook <name>`) and the read_note call, which holds the note's short
 * reference (`note-ref.ts`). Ryan pastes it into an agent conversation.
 *
 * Every client produces the same text from the same parts: the web and Mac apps call this, and
 * Android matches apps/android/contract/agent-reference-v1.json (written from this function by
 * apps/web/test/unit/agent-reference-contract.test.ts).
 *
 * ```
 * Reference note via Penmoss MCP (penmoss mcp --notebook "Personal") tool read_note {"id":"K7QD-9HTF2CXA"}
 * ```
 */
import { shortNoteRef } from './note-ref';

export interface AgentReferenceInput {
  /** The note's id (a ULID). */
  readonly id: string;
  /**
   * A git notebook's note (T50) is read through that notebook's local MCP server
   * (`penmoss mcp --notebook <name>`), named here.
   */
  readonly gitNotebook?: string;
  /**
   * The git notebook's id (`.penmoss/notebook.json`): the note is named by its short reference
   * in it. Without it, by its whole id.
   */
  readonly notebookId?: string;
  /** The notebook's other note ids: one ending as this one's does makes its reference longer. */
  readonly noteIds?: Iterable<string>;
}

/** One line: every run of whitespace (line breaks, tabs) as one space, trimmed. */
const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim();

/** Inside double quotes: backslashes and double quotes escaped, as JSON escapes them. */
const quoted = (text: string) => `"${oneLine(text).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/** The reference's text: one line. */
export function agentReference(input: AgentReferenceInput): string {
  const id = oneLine(input.id);
  const ref =
    input.notebookId === undefined || input.notebookId.trim() === ''
      ? id
      : shortNoteRef(input.notebookId, id, input.noteIds);
  const server =
    input.gitNotebook === undefined
      ? 'Penmoss MCP'
      : `Penmoss MCP (penmoss mcp --notebook ${quoted(input.gitNotebook)})`;
  return `Reference note via ${server} tool read_note {"id":"${ref}"}`;
}
