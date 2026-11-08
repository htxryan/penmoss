import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { UnsupportedNote } from '../../src/notes/UnsupportedNote';

// A158: a note holding node types a later version wrote opens read-only, never as an error.
describe('UnsupportedNote', () => {
  it('says why the note is read-only, names the types and shows the text as text', () => {
    const html = renderToString(
      <UnsupportedNote types={['futureBlock', 'poll']} text={'Plans\n<b>not bold</b>'} />,
    );

    expect(html).toContain('data-testid="note-unsupported"');
    expect(html).toContain('role="status"');
    expect(html).toContain('futureBlock, poll');
    expect(html).toContain('read-only');
    expect(html).toContain('Plans\n&lt;b&gt;not bold&lt;/b&gt;');
    expect(html).not.toContain('role="alert"');
  });
});
