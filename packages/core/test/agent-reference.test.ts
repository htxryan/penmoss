import { describe, expect, it } from 'vitest';
import { agentReference } from '../src/agent-reference';

const ID = '01JBXYZ0000000000000000000';

describe('agentReference (T52 item 4)', () => {
  it('names the title, the id, the notebook and folders, and the read_note call', () => {
    expect(
      agentReference({ id: ID, title: 'Plans', notebook: 'Personal', folders: ['Penmoss'] }),
    ).toBe(
      `Penmoss note "Plans" (Personal › Penmoss)\n` +
        `Read it with the Penmoss MCP tool read_note {"id":"${ID}"}`,
    );
  });

  it('puts a top-level note in its notebook alone, and an untitled one as Untitled', () => {
    expect(agentReference({ id: ID, title: ' ', notebook: 'Work', folders: [] })).toMatch(
      /^Penmoss note "Untitled" \(Work\)\n/,
    );
  });

  it('keeps the title on one line and escapes its quotes and backslashes', () => {
    const text = agentReference({
      id: ID,
      title: 'a "b"\n\tc\\d',
      notebook: 'Personal',
      folders: [' Deep ', ''],
    });
    expect(text.split('\n')).toHaveLength(2);
    expect(text).toContain('Penmoss note "a \\"b\\" c\\\\d" (Personal');
    expect(text).toContain('(Personal › Deep)');
  });

  it('names the id once, in the read_note call (T53 item 7)', () => {
    const text = agentReference({ id: ID, title: 'Plans', notebook: 'Personal', folders: [] });
    expect(text.split(ID)).toHaveLength(2);
  });

  it('reads a git notebook’s note through its local MCP server', () => {
    expect(
      agentReference({ id: ID, title: 'Spec', notebook: 'Work', folders: [], gitNotebook: 'Work' }),
    ).toContain('(penmoss mcp --notebook "Work") tool read_note {"id":');
  });
});
