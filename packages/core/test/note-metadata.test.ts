import { describe, expect, it } from 'vitest';
import {
  noteMetadataProblem,
  STATUS_BAR_SETTING,
  statusBarFieldsOf,
  UNDER_TITLE_SETTING,
  underTitleFieldsOf,
  withField,
} from '../src/note-metadata';

describe('pinned metadata (T62 item 4)', () => {
  it('shows nothing under the title and the counts in the status bar, unset', () => {
    expect(underTitleFieldsOf({})).toEqual([]);
    expect(statusBarFieldsOf({})).toEqual(['words', 'characters', 'reading']);
  });

  it('reads the stored fields in their own order, skipping unknown ids', () => {
    const settings = {
      [UNDER_TITLE_SETTING]: ['tags', 'later', 'edited'],
      [STATUS_BAR_SETTING]: ['reading', 'edited'],
    };
    expect(underTitleFieldsOf(settings)).toEqual(['edited', 'tags']);
    expect(statusBarFieldsOf(settings)).toEqual(['edited', 'reading']);
    // Token Count (feedback of 6 Nov 2026) goes last, in both places.
    expect(statusBarFieldsOf({ [STATUS_BAR_SETTING]: ['tokens', 'words'] })).toEqual([
      'words',
      'tokens',
    ]);
    expect(underTitleFieldsOf({ [UNDER_TITLE_SETTING]: ['tokens', 'notebook'] })).toEqual([
      'notebook',
      'tokens',
    ]);
    // An empty status bar stays empty.
    expect(statusBarFieldsOf({ [STATUS_BAR_SETTING]: [] })).toEqual([]);
  });

  it('turns a field on or off in the fields’ own order', () => {
    expect(withField(['words'], 'edited', true)).toEqual(['edited', 'words']);
    expect(withField(['edited', 'words'], 'edited', false)).toEqual(['words']);
  });

  it('refuses values it cannot store, and Tags in the status bar', () => {
    expect(noteMetadataProblem(UNDER_TITLE_SETTING, ['tags'])).toBeNull();
    expect(noteMetadataProblem(STATUS_BAR_SETTING, ['tags'])).toMatch(/cannot hold tags/);
    expect(noteMetadataProblem(STATUS_BAR_SETTING, ['words', 'words'])).toMatch(/repeats/);
    expect(noteMetadataProblem(STATUS_BAR_SETTING, 'words')).toMatch(/list/);
    expect(noteMetadataProblem('metadata.other', [])).toMatch(/not a metadata setting/);
    expect(noteMetadataProblem(STATUS_BAR_SETTING, null)).toBeNull();
    // A stored list it refuses reads as unset.
    expect(statusBarFieldsOf({ [STATUS_BAR_SETTING]: ['tags'] })).toEqual([
      'words',
      'characters',
      'reading',
    ]);
  });
});
