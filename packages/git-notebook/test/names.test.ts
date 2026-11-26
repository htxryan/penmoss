/**
 * Stored names (A823): a committed file keeps its name while its title's base is unchanged, even
 * when the claim stored for it was lost. Two devices registering the same note offline (a daily
 * note's id is the same on both) each make its registry entry, and one wins whole, so a claim
 * stored in the other goes; the file at head still names the note (converge-dir's seed 1060327).
 */
import { couldBeUniqueName } from '@penmoss/core/mirror';
import { setTitle } from '@penmoss/model/note';
import { registerNote } from '@penmoss/model/workspace';
import * as Y from '@y/y';
import { describe, expect, it } from 'vitest';
import { assignNames, foreignOf } from '../src';

const ID = '01M62F9N00NQ2Y89SH74ZEJVPT';

function world(title: string, filesAtHead: string[]) {
  const workspace = new Y.Doc();
  // An entry with no stored claim: the one that won had none.
  registerNote(workspace, { id: ID, folderId: null });
  const note = new Y.Doc();
  setTitle(note, title);
  const foreign = foreignOf(filesAtHead, () => ID, '', new Set([ID]));
  return assignNames({
    workspace,
    notes: new Map([[ID, note]]),
    purged: new Set(),
    foreign,
    root: '',
  });
}

describe('a note whose stored claim was lost', () => {
  it('keeps the name its file has at head', () => {
    const named = world('Title fox', ['Title fox (4ZEJVPT).md']);
    expect(named.paths.get(ID)).toBe('Title fox (4ZEJVPT).md');
  });

  it('is named afresh when its title changed since', () => {
    const named = world('Title owl', ['Title fox (4ZEJVPT).md']);
    expect(named.paths.get(ID)).toBe('Title owl.md');
  });

  it('never takes a name its own rules could not have given it', () => {
    // A file someone renamed by hand keeps the note's id but not a name for its title.
    const named = world('Title fox', ['Title fox (draft).md']);
    expect(named.paths.get(ID)).toBe('Title fox.md');
  });
});

describe('couldBeUniqueName', () => {
  it('is the base, or the base with a suffix uniqueName tries for that id', () => {
    expect(couldBeUniqueName('Plan', 'Plan', ID)).toBe(true);
    expect(couldBeUniqueName('Plan (4ZEJVPT)', 'Plan', ID)).toBe(true);
    expect(couldBeUniqueName('Plan (Y89SH74ZEJVPT)', 'Plan', ID)).toBe(true);
    expect(couldBeUniqueName(`Plan (${ID})`, 'Plan', ID)).toBe(true);
    expect(couldBeUniqueName('Plan (ABCDEFG)', 'Plan', ID)).toBe(false);
    expect(couldBeUniqueName('Plan 2', 'Plan', ID)).toBe(false);
    expect(couldBeUniqueName('Plans', 'Plan', ID)).toBe(false);
  });
});
