/**
 * The repair guard holds a `selectionOnly` plugin to its word (T44 review). It was in the line
 * symbols' cost test, which is now a wall-clock budget (line-symbols.budget.test.ts, A1244).
 */
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { describe, expect, it, vi } from 'vitest';
import { skipRepairsOfBindingChanges } from '../src/collab/yjs14';
import { openEditor, paragraph } from './support/editor';

describe('a selectionOnly plugin (T44 review)', () => {
  it('may move the selection, and is refused a change to the document', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const plugin = skipRepairsOfBindingChanges(
      new Plugin({
        key: new PluginKey('writesAnyway'),
        selectionOnly: true,
        appendTransaction: (_transactions, _old, state) => state.tr.insertText('!', 1),
      }),
    );
    const { editor } = openEditor([paragraph('Text')]);
    const state = editor.state.reconfigure({ plugins: [...editor.state.plugins, plugin] });
    const after = state.applyTransaction(state.tr.insertText('a', 1)).state;
    expect(after.doc.textContent).toBe('aText');
    expect(error).toHaveBeenCalledWith(expect.stringContaining('writesAnyway'));
    error.mockRestore();
  });
});
