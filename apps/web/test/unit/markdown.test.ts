import { initNote } from '@penmoss/sync-client/note';
import { createYjs14Replica } from '@penmoss/sync-client/yjs14';
import { describe, expect, it } from 'vitest';
import { noteFields, noteMarkdown } from '../../src/notes/markdown';

const ID = '01JB7Q3V6M8K2T9RZ4XN5C1HPD';

describe('noteMarkdown', () => {
  it('renders frontmatter and the editor body with the core codec', async () => {
    const replica = createYjs14Replica();
    initNote(replica.doc, { id: ID, created: '2026-10-22T09:15:00-05:00', kind: 'note' }, 'Blocks');
    const body = {
      type: 'doc',
      content: [
        {
          type: 'callout',
          attrs: { type: 'faq', title: 'Why', foldable: true, collapsed: true },
          content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Because.' }] }],
        },
        {
          type: 'taskList',
          content: [
            {
              type: 'taskItem',
              attrs: { checked: true },
              content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Done' }] }],
            },
          ],
        },
      ],
    };
    expect(await noteMarkdown(ID, replica, body)).toBe(
      [
        '---',
        `id: ${ID}`,
        'title: Blocks',
        'created: 2026-10-22T09:15:00-05:00',
        '---',
        '',
        '> [!faq]- Why',
        '> Because.',
        '',
        '- [x] Done',
        '',
      ].join('\n'),
    );
  });

  it('gives Copy as Markdown the same frontmatter fields (T15)', () => {
    const replica = createYjs14Replica();
    initNote(replica.doc, { id: ID, created: '2026-10-22T09:15:00-05:00', kind: 'daily' }, 'Today');
    expect(noteFields(ID, replica)).toEqual({
      id: ID,
      title: 'Today',
      created: '2026-10-22T09:15:00-05:00',
      type: 'daily',
    });
  });
});
