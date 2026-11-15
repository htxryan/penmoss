/**
 * Short note references in the app (PEN-69): `/notes/K7QD-9HTF2CXA` names the note of the git
 * notebook whose id's 4 characters start it.
 */
import { notebookTag } from '@penmoss/core/note-ref';
import { describe, expect, it } from 'vitest';
import { noteOfShortRef } from '../../src/sources/short-ref';
import type { Workspace } from '../../src/workspace/service';

const NOTE = '01M6VAE8YFZ99TCZV2SXF7SQ9W';

const source = (id: string, notes: readonly string[]) => ({
  id,
  workspace: {
    getState: () => ({ snapshot: { notes: notes.map((each) => ({ id: each })) } }),
  } as unknown as Workspace,
});

describe('noteOfShortRef (PEN-69)', () => {
  const work = source('01JBNOTEBOOK00000000000001', [NOTE]);
  const home = source('01JBNOTEBOOK00000000000002', []);

  it('finds the note in the notebook its 4 characters name, in any case', () => {
    const ref = `${notebookTag(work.id)}-sxf7sq9w`;
    expect(noteOfShortRef(ref, [home, work])).toEqual({ kind: 'note', id: NOTE });
    expect(noteOfShortRef(`${notebookTag(work.id)}-${NOTE}`, [work])).toEqual({
      kind: 'note',
      id: NOTE,
    });
  });

  it('says when no notebook here, or no note in it, is the one named', () => {
    expect(noteOfShortRef(`${notebookTag(work.id)}-SXF7SQ9W`, [home])).toEqual({
      kind: 'no-notebook',
    });
    expect(noteOfShortRef(`${notebookTag(home.id)}-SXF7SQ9W`, [home, work])).toEqual({
      kind: 'no-note',
    });
  });

  it('passes a note id through', () => {
    expect(noteOfShortRef(NOTE, [])).toEqual({ kind: 'note', id: NOTE });
  });
});
