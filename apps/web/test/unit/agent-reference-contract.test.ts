/**
 * Copy Agent Reference's text (T52 item 4; one line with the short id since PEN-69): apps/android/contract/agent-reference-v1.json holds
 * cases, each with its input and the text core's `agentReference` makes from it. The web and
 * Mac apps call `agentReference`; the Android app builds the same text in Kotlin and checks it
 * against this file, so a reference copied on any client reads the same.
 *
 * After changing the format, write the file again:
 * `PENMOSS_WRITE_CONTRACTS=1 pnpm --filter @penmoss/web exec vitest run agent-reference-contract`,
 * then `pnpm exec prettier --write apps/android/contract/agent-reference-v1.json`.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { agentReference, type AgentReferenceInput } from '@penmoss/core/agent-reference';
import { describe, expect, it } from 'vitest';

const FILE = fileURLToPath(
  new URL('../../../android/contract/agent-reference-v1.json', import.meta.url),
);

const ID = '01JBXYZ0000000000000000000';
const NOTE = '01M6VAE8YFZ99TCZV2SXF7SQ9W';

/** An input as JSON holds it: the notebook's other note ids as a list. */
type ContractInput = Omit<AgentReferenceInput, 'noteIds'> & {
  readonly noteIds?: readonly string[];
};

const CASES: ReadonlyArray<{ readonly name: string; readonly input: ContractInput }> = [
  {
    name: 'a git notebook’s note: its local MCP server, and its short id',
    input: { id: NOTE, gitNotebook: 'Personal', notebookId: '01JQ7M1WQ3R4ZK3V8N2C5D6E7F' },
  },
  {
    name: 'another notebook id gives another 4 characters',
    input: { id: NOTE, gitNotebook: 'Work', notebookId: '01JBNOTEBOOK00000000000001' },
  },
  {
    name: 'the hash covers the whole notebook id',
    input: { id: NOTE, gitNotebook: 'Work', notebookId: '01JBNOTEBOOK00000000000002' },
  },
  {
    name: 'an older note ending the same way: the whole id after the notebook’s 4 characters',
    input: {
      id: NOTE,
      gitNotebook: 'Personal',
      notebookId: '01JQ7M1WQ3R4ZK3V8N2C5D6E7F',
      noteIds: ['01AAAAAAAAAAAAAAAASXF7SQ9W', NOTE],
    },
  },
  {
    name: 'a later note ending the same way changes nothing',
    input: {
      id: NOTE,
      gitNotebook: 'Personal',
      notebookId: '01JQ7M1WQ3R4ZK3V8N2C5D6E7F',
      noteIds: ['01ZZZZZZZZZZZZZZZZSXF7SQ9W'],
    },
  },
  {
    name: 'double quotes, backslashes and line breaks in the notebook’s name',
    input: {
      id: ID,
      gitNotebook: '  The "big"\nC:\\ book ',
      notebookId: '01JQ7M1WQ3R4ZK3V8N2C5D6E7F',
    },
  },
  {
    name: 'without a notebook id: the whole id',
    input: { id: ID, gitNotebook: 'Personal' },
  },
  {
    name: 'a note not in a git notebook: no --notebook, and its whole id',
    input: { id: ID },
  },
];

interface Contract {
  readonly $comment: string;
  readonly version: 2;
  readonly cases: ReadonlyArray<{
    readonly name: string;
    readonly input: ContractInput;
    readonly expected: string;
  }>;
}

const COMMENT =
  'Copy Agent Reference (T52 item 4, PEN-69): each case is the input (id: the note’s ULID; gitNotebook: the git notebook’s name, whose local MCP server reads it; notebookId: its notebook.json id, which gives the note its short id; noteIds: the notebook’s other notes, an older one ending as this one does making the short id the whole ULID) and the exact one line every client copies. Written from core’s agentReference by apps/web/test/unit/agent-reference-contract.test.ts; read by the Android app’s contract test.';

const contract = (): Contract => ({
  $comment: COMMENT,
  version: 2,
  cases: CASES.map((each) => ({ ...each, expected: agentReference(each.input) })),
});

const text = (value: Contract) => `${JSON.stringify(value, null, 2)}\n`;

if (process.env['PENMOSS_WRITE_CONTRACTS'] === '1') writeFileSync(FILE, text(contract()));

describe('apps/android/contract/agent-reference-v1.json (T52 item 4, PEN-69)', () => {
  it('holds every case with the text agentReference makes', () => {
    const stored = JSON.parse(readFileSync(FILE, 'utf8')) as Contract;
    expect(stored).toEqual(contract());
  });

  it('is the one line of Ryan’s example (PEN-69)', () => {
    expect(agentReference(CASES[0]!.input)).toMatch(
      /^Reference note via Penmoss MCP \(penmoss mcp --notebook "Personal"\) tool read_note \{"id":"[0-9A-HJKMNP-TV-Z]{4}-SXF7SQ9W"\}$/,
    );
  });
});
