import { NOTE_ROOT } from '@penmoss/sync-client';
import { describe, expect, it } from 'vitest';
import { codeBlock, openEditor, paragraph, select, type } from './support/editor';

const tags = (root: HTMLElement) =>
  [...root.querySelectorAll<HTMLElement>('.pm-tag')].map((element) => [
    element.textContent,
    element.dataset.tag,
  ]);

describe('inline tags (T18)', () => {
  it('marks #tags in prose, not in code, and follows typing', () => {
    const collab = openEditor([
      paragraph('Plan #Garden/Herbs and C#'),
      codeBlock('#include <stdio.h>'),
    ]);
    const { view } = collab.editor;
    expect(tags(view.dom)).toEqual([['#Garden/Herbs', 'garden/herbs']]);

    select(view, view.state.doc.child(0).nodeSize - 1);
    type(view, ' #todo');
    expect(tags(view.dom)).toEqual([
      ['#Garden/Herbs', 'garden/herbs'],
      ['#todo', 'todo'],
    ]);
  });

  it('never writes to the document', () => {
    const collab = openEditor([paragraph('A #tag here')]);
    const before = JSON.stringify(collab.replica.doc.get(NOTE_ROOT).toDeltaDeep().toJSON());
    expect(tags(collab.editor.view.dom)).toHaveLength(1);
    expect(JSON.stringify(collab.replica.doc.get(NOTE_ROOT).toDeltaDeep().toJSON())).toBe(before);
  });
});
