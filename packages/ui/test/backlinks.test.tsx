import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Backlinks } from '../src/panels/Backlinks';

describe('Backlinks', () => {
  const props = {
    noteId: 'me',
    titleOf: (id: string) => ({ me: 'Garden plan', other: 'Seeds' })[id] ?? null,
    hrefOf: (id: string) => `/notes/${id}`,
    onOpen: () => undefined,
  };

  it('lists linking notes with their context, the open note’s links highlighted by current title', () => {
    const html = renderToStaticMarkup(
      <Backlinks
        {...props}
        linked={[
          {
            id: 'a',
            title: 'Weekly review',
            mentions: [
              {
                embed: false,
                heading: null,
                context: [
                  'Started the ',
                  { noteId: 'me', target: 'Old name', heading: null, alias: null },
                  ' with ',
                  { noteId: 'other', target: 'Seeds', heading: null, alias: null },
                ],
              },
            ],
          },
        ]}
        unlinked={[
          {
            id: 'b',
            title: '',
            snippet: [
              { text: 'Buy for the ', match: false },
              { text: 'garden plan', match: true },
            ],
          },
        ]}
      />,
    );

    expect(html).toContain('Linked mentions <span class="bl-count">1</span>');
    expect(html).toContain('Started the <mark>Garden plan</mark>');
    expect(html).toContain('<span class="bl-link">Seeds</span>');
    expect(html).toContain('href="/notes/a"');
    expect(html).toContain('Unlinked mentions <span class="bl-count">1</span>');
    expect(html).toContain('>Untitled</a>');
    expect(html).toContain('<mark>garden plan</mark>');
  });

  it('says when nothing links here', () => {
    const html = renderToStaticMarkup(
      <Backlinks {...props} linked={[]} unlinked={[]} note="From this device" />,
    );
    expect(html).toContain('No other notes link here yet.');
    expect(html).toContain('From this device');
  });
});
