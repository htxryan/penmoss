import { parseFrontmatter, readNoteMeta, parseMarkdown } from '@penmoss/core';
import * as Y from '@y/y';
import { describe, expect, it } from 'vitest';
import {
  answerDescriptionAsk,
  clearDescription,
  descriptionAsks,
  descriptionAuthor,
  needsDescription,
  noteTextHash,
  readAiSetting,
  readDescription,
  setAiDescription,
  setAiSetting,
  setHandDescription,
} from '../src/description';
import { readNoteState, renderNote } from '../src/markdown';
import { initNote, setTitle } from '../src/note';
import { setFrontmatterTag } from '../src/tags';
import { createFolder, readWorkspace, setFolderAiDescription } from '../src/workspace';

function note(): Y.Doc {
  const doc = new Y.Doc();
  initNote(doc, { id: 'n1', created: '2026-11-20T09:00:00-06:00', kind: 'note' }, 'Plans');
  return doc;
}

const frontmatterOf = (doc: Y.Doc) => {
  const md = renderNote(readNoteState(doc), 'n1', 0).markdown;
  return readNoteMeta(parseMarkdown(md).frontmatter ?? parseFrontmatter(''));
};

describe('a note’s description', () => {
  it('renders as frontmatter, with the note’s own value', () => {
    const doc = note();
    expect(frontmatterOf(doc).description).toBeUndefined();
    setAiDescription(doc, 'Plans for the week.', noteTextHash(doc));
    setAiSetting(doc, 'on');
    expect(frontmatterOf(doc)).toMatchObject({
      description: 'Plans for the week.',
      'ai-description': 'on',
    });
    setAiSetting(doc, 'inherit');
    expect(frontmatterOf(doc)['ai-description']).toBeUndefined();
    expect(readAiSetting(doc)).toBe('inherit');
  });

  it('needs a description only when the text changed, never for frontmatter', () => {
    const doc = note();
    expect(needsDescription(doc)).toBe(true);
    setAiDescription(doc, 'Plans.', noteTextHash(doc));
    expect(needsDescription(doc)).toBe(false);
    setAiSetting(doc, 'on');
    expect(needsDescription(doc)).toBe(false);
    setFrontmatterTag(doc, 'work', true);
    expect(needsDescription(doc)).toBe(true);
    setAiDescription(doc, 'Plans.', noteTextHash(doc));
    setTitle(doc, 'Plans 2');
    expect(needsDescription(doc)).toBe(true);
  });

  it('keeps a hand-written description, and asks', () => {
    const doc = note();
    setHandDescription(doc, '  Mine. ', { ask: true });
    expect(readDescription(doc)).toBe('Mine.');
    expect(descriptionAuthor(doc)).toBe('hand');
    expect(needsDescription(doc)).toBe(false);
    expect(descriptionAsks(doc)).toBe(true);
    answerDescriptionAsk(doc, 'keep');
    expect(readAiSetting(doc)).toBe('off');
    expect(descriptionAsks(doc)).toBe(false);
    expect(readDescription(doc)).toBe('Mine.');

    setHandDescription(doc, 'Again', { ask: true });
    answerDescriptionAsk(doc, 'update');
    expect(needsDescription(doc)).toBe(true);
    expect(descriptionAuthor(doc)).toBe('ai');
  });

  it('clears', () => {
    const doc = note();
    setAiDescription(doc, 'Plans.', noteTextHash(doc));
    clearDescription(doc);
    expect(readDescription(doc)).toBeNull();
    expect(descriptionAuthor(doc)).toBeNull();
    setHandDescription(doc, 'x');
    setHandDescription(doc, '');
    expect(readDescription(doc)).toBeNull();
  });
});

describe('a folder’s AI Descriptions value', () => {
  it('is set, read and removed', () => {
    const doc = new Y.Doc();
    createFolder(doc, { id: 'w', name: 'Work', parentId: null });
    expect(readWorkspace(doc).folders[0]!.aiDescription).toBeUndefined();
    setFolderAiDescription(doc, 'w', 'on');
    expect(readWorkspace(doc).folders[0]!.aiDescription).toBe('on');
    setFolderAiDescription(doc, 'w', 'inherit');
    expect(readWorkspace(doc).folders[0]!.aiDescription).toBeUndefined();
  });
});
