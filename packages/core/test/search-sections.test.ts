import { describe, expect, it } from 'vitest';
import type { DocJson } from '../src/links';
import { CHUNK_MAX_CHARS, chunkNote, noteHeadings, noteSections } from '../src/search';

const text = (value: string): DocJson => ({ type: 'text', text: value });
const paragraph = (...content: DocJson[]): DocJson => ({ type: 'paragraph', content });
const heading = (level: number, value: string): DocJson => ({
  type: 'heading',
  attrs: { level },
  content: [text(value)],
});
const link = (target: string, alias: string | null = null): DocJson => ({
  type: 'wikilink',
  attrs: { noteId: null, target, heading: null, alias },
});

const doc: DocJson = {
  type: 'doc',
  content: [
    paragraph(text('Intro before any heading.')),
    heading(1, 'Backups'),
    paragraph(text('We mirror the vault to '), link('Git mirror', 'git'), text(' nightly.')),
    heading(2, 'Restore drill'),
    {
      type: 'bulletList',
      content: [
        { type: 'listItem', content: [paragraph(text('Clone the mirror'))] },
        { type: 'listItem', content: [paragraph(text('Open it'))] },
      ],
    },
    heading(2, 'Empty part'),
    heading(1, 'Garden'),
    paragraph(text('Tomatoes in March.')),
  ],
};

describe('note sections (T22, T23)', () => {
  it('lists headings for the headings column', () => {
    expect(noteHeadings(doc)).toBe('Backups\nRestore drill\nEmpty part\nGarden');
  });

  it('cuts a body into heading sections with their heading trail', () => {
    expect(noteSections(doc)).toEqual([
      { heading: null, path: [], text: 'Intro before any heading.' },
      { heading: 'Backups', path: ['Backups'], text: 'We mirror the vault to git nightly.' },
      {
        heading: 'Restore drill',
        path: ['Backups', 'Restore drill'],
        text: 'Clone the mirror\nOpen it',
      },
      { heading: 'Empty part', path: ['Backups', 'Empty part'], text: '' },
      { heading: 'Garden', path: ['Garden'], text: 'Tomatoes in March.' },
    ]);
  });

  it('makes one chunk per section with text, prefixed with its trail, the first with the title', () => {
    const chunks = chunkNote('Home server', noteSections(doc));
    expect(chunks.map((chunk) => chunk.text)).toEqual([
      'Home server\n\nIntro before any heading.',
      'Backups\n\nWe mirror the vault to git nightly.',
      'Backups › Restore drill\n\nClone the mirror\nOpen it',
      'Garden\n\nTomatoes in March.',
    ]);
    expect(chunks[2]).toMatchObject({
      heading: 'Restore drill',
      preview: 'Clone the mirror Open it',
    });
  });

  it('changes only the first chunk when the title changes (A115)', () => {
    const before = chunkNote('Home server', noteSections(doc));
    const after = chunkNote('Basement server', noteSections(doc));
    expect(after.map((chunk) => chunk.text === before[after.indexOf(chunk)]!.text)).toEqual([
      false,
      true,
      true,
      true,
    ]);
    // A note whose first section has a heading carries the title before its trail.
    const headed = chunkNote(
      'Garden plan',
      noteSections({ type: 'doc', content: doc.content!.slice(1) }),
    );
    expect(headed[0]!.text).toBe('Garden plan › Backups\n\nWe mirror the vault to git nightly.');
  });

  it('splits long sections at line, then word, boundaries', () => {
    const line = 'word '.repeat(150).trim(); // 749 characters
    const long = noteSections({
      type: 'doc',
      content: [heading(1, 'Long'), ...Array.from({ length: 6 }, () => paragraph(text(line)))],
    });
    const chunks = chunkNote('T', long);
    expect(chunks.length).toBe(3);
    for (const chunk of chunks) expect(chunk.text.length).toBeLessThanOrEqual(CHUNK_MAX_CHARS + 20);
    const huge = chunkNote('T', [{ heading: null, path: [], text: 'x '.repeat(3000) }]);
    expect(huge.length).toBeGreaterThan(2);
    expect(huge.every((chunk) => chunk.text.length <= CHUNK_MAX_CHARS + 20)).toBe(true);
  });

  it('keeps a note with no body findable by its title', () => {
    expect(chunkNote('Shopping list', [])).toEqual([
      { heading: null, text: 'Shopping list', preview: '' },
    ]);
    expect(chunkNote('', [])).toEqual([]);
  });
});
