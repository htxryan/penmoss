import { describe, expect, it, vi } from 'vitest';
import { readyCodec } from '../src/clipboard/markdown';
import { markdownOf, paste } from './support/clipboard';
import { openEditor, paragraph, select } from './support/editor';

// The codec is a lazy chunk (A50). In this file nothing loads it first: a markdown
// paste made before it arrives waits for it, then goes in as one transaction where
// the paste was made.
describe('pasting markdown before the codec has loaded', () => {
  it('waits for the codec, then writes once, at the paste position', async () => {
    const collab = openEditor([paragraph('Intro')]);
    const { view } = collab.editor;
    select(view, 6);
    expect(readyCodec()).toBeNull();
    const updates: Uint8Array[] = [];
    collab.replica.onUpdate((update) => updates.push(update));

    const event = paste(collab, { 'text/plain': '## Next\n\n- a\n- b' });
    expect(event.defaultPrevented).toBe(true);
    expect(updates).toEqual([]);
    view.dispatch(view.state.tr.insertText('First. ', 1));
    const before = updates.length;

    await vi.waitFor(() => expect(markdownOf(collab)).toContain('## Next'));
    expect(updates.length).toBe(before + 1);
    expect(markdownOf(collab)).toBe('First. Intro\n\n## Next\n\n- a\n- b\n');
  });
});
