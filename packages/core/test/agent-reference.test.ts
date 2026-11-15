import { describe, expect, it } from 'vitest';
import { agentReference } from '../src/agent-reference';
import { notebookTag } from '../src/note-ref';

const ID = '01JBXYZ0000000000000000000';
const NOTE = '01M6VAE8YFZ99TCZV2SXF7SQ9W';
const NOTEBOOK = '01JQ7M1WQ3R4ZK3V8N2C5D6E7F';
const TAG = notebookTag(NOTEBOOK);

describe('agentReference (T52 item 4, PEN-69, PEN-155)', () => {
  it('is one line: read_note with the short id, which finds its notebook on the one server', () => {
    expect(agentReference({ id: NOTE, notebookId: NOTEBOOK })).toBe(
      `Reference note via Penmoss MCP tool read_note {"id":"${TAG}-SXF7SQ9W"}`,
    );
  });

  it('names a note by its whole id without a notebook id', () => {
    expect(agentReference({ id: ID })).toBe(
      `Reference note via Penmoss MCP tool read_note {"id":"${ID}"}`,
    );
  });

  it('gives the whole id after a clash of the last 8 characters with an older note', () => {
    const older = '01AAAAAAAAAAAAAAAASXF7SQ9W';
    const text = agentReference({ id: NOTE, notebookId: NOTEBOOK, noteIds: [older, NOTE] });
    expect(text).toContain(`{"id":"${TAG}-${NOTE}"}`);
    expect(agentReference({ id: older, notebookId: NOTEBOOK, noteIds: [NOTE] })).toContain(
      `{"id":"${TAG}-SXF7SQ9W"}`,
    );
  });

  it('keeps every reference on one line', () => {
    expect(agentReference({ id: ` ${ID}\n` }).split('\n')).toHaveLength(1);
    expect(agentReference({ id: `${NOTE}\n`, notebookId: NOTEBOOK }).split('\n')).toHaveLength(1);
  });

  it('names the id once, in the read_note call (T53 item 7)', () => {
    expect(agentReference({ id: ID }).split(ID)).toHaveLength(2);
    const git = agentReference({ id: NOTE, notebookId: NOTEBOOK });
    expect(git.split('SXF7SQ9W')).toHaveLength(2);
    expect(git).not.toContain(NOTE);
  });

  it('names the note by its whole id when the notebook id is blank', () => {
    expect(agentReference({ id: NOTE, notebookId: '  ' })).toBe(
      `Reference note via Penmoss MCP tool read_note {"id":"${NOTE}"}`,
    );
  });

  it('names no server and no notebook (PEN-155)', () => {
    expect(agentReference({ id: NOTE, notebookId: NOTEBOOK })).not.toMatch(/--notebook|\(/);
  });
});
