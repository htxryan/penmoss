import { afterEach, describe, expect, it, vi } from 'vitest';
import { setNativeClipboard, type NativeClipboardPayload } from '../src/clipboard';
import { openEditor, paragraph } from './support/editor';

// T29: the Mac app's clipboard bridge. T15's explicit copies go to the app shell in one
// write with HTML, readable plain text and the markdown, which a page's copy event cannot do.
describe('copying through a native clipboard (T29)', () => {
  afterEach(() => setNativeClipboard(null));

  const note = () =>
    openEditor([
      { type: 'paragraph', content: [{ type: 'text', text: 'Bold', marks: [{ type: 'bold' }] }] },
      paragraph('end'),
    ]);

  it('writes rich text as HTML, plain text and markdown at once', async () => {
    const writes: NativeClipboardPayload[] = [];
    setNativeClipboard((payload) => {
      writes.push(payload);
      return Promise.resolve(true);
    });
    const onCopy = vi.fn();
    const collab = openEditor(
      [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'Bold', marks: [{ type: 'bold' }] }],
        },
        paragraph('end'),
      ],
      { clipboard: { onCopy } },
    );
    collab.editor.commands.copyAsRichText();
    await vi.waitFor(() => expect(onCopy).toHaveBeenCalledWith('rich', true));
    expect(writes).toHaveLength(1);
    expect(writes[0]!.html).toContain('<strong>Bold</strong>');
    expect(writes[0]!.text).toBe('Bold\n\nend');
    expect(writes[0]!.markdown).toBe('**Bold**\n\nend');
  });

  it('writes Copy as Markdown as plain text and markdown, without HTML', async () => {
    const write = vi.fn<(payload: NativeClipboardPayload) => Promise<boolean>>(() =>
      Promise.resolve(true),
    );
    setNativeClipboard(write);
    note().editor.commands.copyAsMarkdown();
    await vi.waitFor(() => expect(write).toHaveBeenCalledOnce());
    expect(write.mock.calls[0]![0]).toEqual({
      text: '**Bold**\n\nend',
      markdown: '**Bold**\n\nend',
    });
  });

  it('falls back to the page’s clipboard when the shell refuses', async () => {
    setNativeClipboard(() => Promise.reject(new Error('no clipboard')));
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    try {
      const onCopy = vi.fn();
      const collab = openEditor([paragraph('plain')], { clipboard: { onCopy } });
      collab.editor.commands.copyAsMarkdown();
      await vi.waitFor(() => expect(onCopy).toHaveBeenCalledWith('markdown', true));
    } finally {
      Reflect.deleteProperty(navigator, 'clipboard');
    }
  });
});
