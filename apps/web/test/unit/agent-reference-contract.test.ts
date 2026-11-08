/**
 * Copy Agent Reference's text (T52 item 4): apps/android/contract/agent-reference-v1.json holds
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

const CASES: ReadonlyArray<{ readonly name: string; readonly input: AgentReferenceInput }> = [
  {
    name: 'a note in a folder of the default notebook',
    input: { id: ID, title: 'Plans', notebook: 'Personal', folders: ['Penmoss'] },
  },
  {
    name: 'at the top level of the default notebook: the notebook alone',
    input: { id: ID, title: 'Plans', notebook: 'Personal', folders: [] },
  },
  {
    name: 'the default notebook renamed',
    input: { id: ID, title: 'Plans', notebook: 'Home', folders: ['Projects'] },
  },
  {
    name: 'nested folders in a notebook, outermost first (the notebook is not a folder here)',
    input: { id: ID, title: 'Q3 review', notebook: 'Work', folders: ['Projects', 'Penmoss'] },
  },
  {
    name: 'an untitled note',
    input: { id: ID, title: '', notebook: 'Personal', folders: ['Inbox'] },
  },
  {
    name: 'a title of spaces only reads as Untitled',
    input: { id: ID, title: '   ', notebook: 'Personal', folders: [] },
  },
  {
    name: 'double quotes and backslashes in a title are escaped',
    input: { id: ID, title: 'The "big" C:\\ plan', notebook: 'Personal', folders: [] },
  },
  {
    name: 'line breaks, tabs and runs of spaces in a title are one space',
    input: { id: ID, title: '  Two\nlines\tand   more ', notebook: 'Personal', folders: [] },
  },
  {
    name: 'symbols and other scripts are kept as written',
    input: { id: ID, title: '★ Café › ideas 💡', notebook: 'Personal', folders: ['Ünïcode'] },
  },
  {
    name: 'a git notebook’s note is read through its local MCP server',
    input: { id: ID, title: 'Spec', notebook: 'Work', folders: ['Docs'], gitNotebook: 'Work' },
  },
];

interface Contract {
  readonly $comment: string;
  readonly version: 1;
  readonly cases: ReadonlyArray<{
    readonly name: string;
    readonly input: AgentReferenceInput;
    readonly expected: string;
  }>;
}

const COMMENT =
  'Copy Agent Reference (T52 item 4): each case is the input (id, title, notebook: the notebook’s name, the default one’s included; folders: below the notebook, outermost first; gitNotebook: only for a git notebook’s note) and the exact text every client copies (two lines joined by \\n, no final line break). Written from core’s agentReference by apps/web/test/unit/agent-reference-contract.test.ts; read by the Android app’s contract test.';

const contract = (): Contract => ({
  $comment: COMMENT,
  version: 1,
  cases: CASES.map((each) => ({ ...each, expected: agentReference(each.input) })),
});

const text = (value: Contract) => `${JSON.stringify(value, null, 2)}\n`;

if (process.env['PENMOSS_WRITE_CONTRACTS'] === '1') writeFileSync(FILE, text(contract()));

describe('apps/android/contract/agent-reference-v1.json (T52 item 4)', () => {
  it('holds every case with the text agentReference makes', () => {
    const stored = JSON.parse(readFileSync(FILE, 'utf8')) as Contract;
    expect(stored).toEqual(contract());
  });

  it('names the note, where it is filed, and how to read it, the id once (T53 item 7)', () => {
    expect(agentReference(CASES[0]!.input)).toBe(
      `Penmoss note "Plans" (Personal › Penmoss)\n` +
        `Read it with the Penmoss MCP tool read_note {"id":"${ID}"}`,
    );
  });
});
