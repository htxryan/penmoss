import { describe, expect, it } from 'vitest';
import { agentReference } from '../src/agent-reference';
import { notebookTag } from '../src/note-ref';

const ID = '01JBXYZ0000000000000000000';
const NOTE = '01M6VAE8YFZ99TCZV2SXF7SQ9W';
const NOTEBOOK = '01JQ7M1WQ3R4ZK3V8N2C5D6E7F';
const TAG = notebookTag(NOTEBOOK);

describe('agentReference (T52 item 4, PEN-69)', () => {
  it('is one line: the git notebook’s local MCP server and read_note with the short id', () => {
    expect(agentReference({ id: NOTE, gitNotebook: 'Personal', notebookId: NOTEBOOK })).toBe(
      `Reference note via Penmoss MCP (penmoss mcp --notebook "Personal") tool read_note {"id":"${TAG}-SXF7SQ9W"}`,
    );
  });

  it('names a note by its whole id without a notebook id, and without --notebook when hosted', () => {
    expect(agentReference({ id: ID })).toBe(
      `Reference note via Penmoss MCP tool read_note {"id":"${ID}"}`,
    );
  });

  it('gives the whole id after a clash of the last 8 characters with an older note', () => {
    const older = '01AAAAAAAAAAAAAAAASXF7SQ9W';
    const text = agentReference({
      id: NOTE,
      gitNotebook: 'Work',
      notebookId: NOTEBOOK,
      noteIds: [older, NOTE],
    });
    expect(text).toContain(`{"id":"${TAG}-${NOTE}"}`);
    expect(
      agentReference({ id: older, gitNotebook: 'Work', notebookId: NOTEBOOK, noteIds: [NOTE] }),
    ).toContain(`{"id":"${TAG}-SXF7SQ9W"}`);
  });

  it('escapes quotes and backslashes in the notebook’s name, on one line', () => {
    expect(
      agentReference({ id: ID, gitNotebook: 'My "big"\n\\ book', notebookId: NOTEBOOK }),
    ).toContain('(penmoss mcp --notebook "My \\"big\\" \\\\ book")');
  });

  it('keeps every reference on one line', () => {
    const git = agentReference({ id: NOTE, gitNotebook: 'Work\nBook', notebookId: NOTEBOOK });
    expect(git.split('\n')).toHaveLength(1);
    expect(agentReference({ id: ` ${ID}\n` }).split('\n')).toHaveLength(1);
  });

  it('names the id once, in the read_note call (T53 item 7)', () => {
    const hosted = agentReference({ id: ID });
    expect(hosted.split(ID)).toHaveLength(2);
    const git = agentReference({ id: NOTE, gitNotebook: 'Personal', notebookId: NOTEBOOK });
    expect(git.split('SXF7SQ9W')).toHaveLength(2);
    expect(git).not.toContain(NOTE);
  });

  it('names the note by its whole id when the notebook id is blank', () => {
    expect(agentReference({ id: NOTE, gitNotebook: 'Work', notebookId: '  ' })).toBe(
      `Reference note via Penmoss MCP (penmoss mcp --notebook "Work") tool read_note {"id":"${NOTE}"}`,
    );
  });
});
