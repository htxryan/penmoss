import { describe, expect, it } from 'vitest';
import { COPY_TAGS_SETTING, copiesTags } from '../src/copy-to-notebook';

// A1353: Copy to Notebook's Copy Tags checkbox starts from the synced `copyToNotebook.tags`.

describe('copyToNotebook.tags', () => {
  it('is the key every client reads', () => {
    expect(COPY_TAGS_SETTING).toBe('copyToNotebook.tags');
  });

  it('copies tags unless set to false, as a copy did before the setting', () => {
    expect(copiesTags({})).toBe(true);
    expect(copiesTags({ [COPY_TAGS_SETTING]: true })).toBe(true);
    expect(copiesTags({ [COPY_TAGS_SETTING]: false })).toBe(false);
    // Another client's value of another kind is the default.
    for (const value of [null, 'no', 0, []]) {
      expect(copiesTags({ [COPY_TAGS_SETTING]: value }), JSON.stringify(value)).toBe(true);
    }
  });
});
