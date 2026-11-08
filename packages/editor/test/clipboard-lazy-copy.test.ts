import { TextSelection } from '@tiptap/pm/state';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readyCodec } from '../src/clipboard/markdown';
import { openEditor, paragraph } from './support/editor';

// The codec is a lazy chunk (A50) and nothing loads it in this file. Copy as
// Markdown made before it arrives must still reach the clipboard inside the
// user's gesture (Safari refuses a write after it), with the markdown.
describe('Copy as Markdown before the codec has loaded', () => {
  afterEach(() => {
    Reflect.deleteProperty(navigator, 'clipboard');
    Reflect.deleteProperty(window, 'ClipboardItem');
  });

  it('writes in the gesture, with the markdown as a promise', async () => {
    const write = vi.fn((items: { items: Record<string, Promise<Blob> | Blob> }[]) => {
      void items;
      return Promise.resolve();
    });
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', {
      value: { write, writeText },
      configurable: true,
    });
    Object.defineProperty(window, 'ClipboardItem', {
      value: class {
        constructor(readonly items: Record<string, Promise<Blob> | Blob>) {}
      },
      configurable: true,
    });
    const onCopy = vi.fn();
    const collab = openEditor(
      [
        { type: 'paragraph', content: [{ type: 'text', text: 'Bold', marks: [{ type: 'bold' }] }] },
        paragraph('end'),
      ],
      { clipboard: { onCopy } },
    );
    const { view } = collab.editor;
    view.dispatch(
      view.state.tr.setSelection(
        TextSelection.create(view.state.doc, 0, view.state.doc.content.size),
      ),
    );
    expect(readyCodec()).toBeNull();

    collab.editor.commands.copyAsMarkdown();
    // Synchronously, before any await: still inside the gesture.
    expect(write).toHaveBeenCalledTimes(1);
    const item = write.mock.calls[0]![0][0]!;
    const blob = await item.items['text/plain']!;
    expect(await blob.text()).toBe('**Bold**\n\nend');
    await vi.waitFor(() => expect(onCopy).toHaveBeenCalledWith('markdown', true));
    expect(writeText).not.toHaveBeenCalled();
  });
});
