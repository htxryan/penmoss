import * as core from '@penmoss/core';
import { serializeMarkdown, schema } from '@penmoss/core';
import { NOTE_ROOT } from '@penmoss/sync-client/replica';
import { ynodeToPmnode } from '@y/prosemirror';
import * as Y from '@y/y';
import { describe, expect, it } from 'vitest';
import {
  appendCapture,
  appendMarkdown,
  captureBlocks,
  captureTime,
  splitCapture,
  CAPTURE_TITLE_MAX,
} from '../src/capture';
import { periodicNote } from '../src/periodic';

const markdownOf = (doc: Y.Doc) =>
  serializeMarkdown({ frontmatter: null, doc: ynodeToPmnode(doc.get(NOTE_ROOT), schema) }).trim();

function dailyNote(template = '## Plan\n\n## Notes\n') {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, periodicNote(core, 'daily', '2026-10-23', template).update);
  return doc;
}

describe('quick capture into today’s note (T30)', () => {
  it('adds a ## Captures heading once at the end and reuses it for every capture', () => {
    const doc = dailyNote();
    expect(appendCapture(doc, 'Call Sam about the garden', '09:05')).toBe(true);
    expect(appendCapture(doc, 'Buy *seed* potatoes', '14:32')).toBe(true);
    expect(markdownOf(doc)).toBe(
      [
        '## Plan',
        '## Notes',
        '## Captures',
        '**09:05** Call Sam about the garden',
        '**14:32** Buy *seed* potatoes',
      ].join('\n\n'),
    );
    expect(markdownOf(doc).match(/## Captures/g)).toHaveLength(1);
  });

  it('keeps captures inside the section when headings follow it', () => {
    const doc = dailyNote('## Captures\n\n**08:00** First\n\n## Later\n\nText\n');
    appendCapture(doc, 'Second', '08:30');
    expect(markdownOf(doc)).toBe(
      ['## Captures', '**08:00** First', '**08:30** Second', '## Later', 'Text'].join('\n\n'),
    );
  });

  it('demotes headings in the capture so the next capture still lands in the section', () => {
    const doc = dailyNote('');
    appendCapture(doc, '# Idea\n\nA shed with a green roof', '10:00');
    appendCapture(doc, 'Another', '10:01');
    expect(markdownOf(doc)).toBe(
      [
        '## Captures',
        '**10:00**',
        '### Idea',
        'A shed with a green roof',
        '**10:01** Another',
      ].join('\n\n'),
    );
  });

  it('replaces an empty body instead of keeping a blank first line', () => {
    const doc = new Y.Doc();
    appendCapture(doc, '- milk\n- eggs', '07:15');
    expect(markdownOf(doc)).toBe(['## Captures', '**07:15**', '- milk\n- eggs'].join('\n\n'));
  });

  it('ignores an empty capture', () => {
    const doc = dailyNote();
    const before = Y.encodeStateVector(doc);
    expect(appendCapture(doc, '  \n\n ', '09:00')).toBe(false);
    expect(Y.encodeStateVector(doc)).toEqual(before);
    expect(captureBlocks('', '09:00')).toEqual([]);
  });

  it('changes only what it adds, so a concurrent edit elsewhere in the note survives', () => {
    const base = dailyNote();
    const phone = new Y.Doc();
    const laptop = new Y.Doc();
    Y.applyUpdate(phone, Y.encodeStateAsUpdate(base));
    Y.applyUpdate(laptop, Y.encodeStateAsUpdate(base));
    // The laptop types under ## Plan while the phone captures.
    appendMarkdown(laptop, 'Typed on the laptop');
    appendCapture(phone, 'Captured on the phone', '12:00');
    Y.applyUpdate(phone, Y.encodeStateAsUpdate(laptop));
    Y.applyUpdate(laptop, Y.encodeStateAsUpdate(phone));
    expect(markdownOf(phone)).toBe(markdownOf(laptop));
    expect(markdownOf(phone)).toContain('Typed on the laptop');
    expect(markdownOf(phone)).toContain('**12:00** Captured on the phone');
    expect(markdownOf(phone).match(/## Captures/g)).toHaveLength(1);
  });

  it('two devices capturing offline merge to two headings; every later capture goes under the last', () => {
    const base = dailyNote();
    const phone = new Y.Doc();
    const laptop = new Y.Doc();
    Y.applyUpdate(phone, Y.encodeStateAsUpdate(base));
    Y.applyUpdate(laptop, Y.encodeStateAsUpdate(base));
    // Offline, each makes its own ## Captures (neither has seen the other's).
    appendCapture(phone, 'From the phone', '08:00');
    appendCapture(laptop, 'From the laptop', '08:01');
    Y.applyUpdate(phone, Y.encodeStateAsUpdate(laptop));
    Y.applyUpdate(laptop, Y.encodeStateAsUpdate(phone));
    const merged = markdownOf(phone);
    expect(merged).toBe(markdownOf(laptop));
    expect(merged.match(/^## Captures$/gm)).toHaveLength(2);
    // Each device, whichever it is, then appends to the last section: the end of the note.
    appendCapture(phone, 'Later on the phone', '09:00');
    appendCapture(laptop, 'Later on the laptop', '09:01');
    Y.applyUpdate(phone, Y.encodeStateAsUpdate(laptop));
    Y.applyUpdate(laptop, Y.encodeStateAsUpdate(phone));
    const after = markdownOf(phone);
    expect(after).toBe(markdownOf(laptop));
    expect(after.match(/^## Captures$/gm)).toHaveLength(2);
    const lastHeading = after.lastIndexOf('## Captures');
    expect(after.indexOf('**09:00** Later on the phone')).toBeGreaterThan(lastHeading);
    expect(after.indexOf('**09:01** Later on the laptop')).toBeGreaterThan(lastHeading);
    // Nothing was moved or lost.
    for (const text of ['From the phone', 'From the laptop', '## Plan', '## Notes']) {
      expect(after).toContain(text);
    }
    expect(after.endsWith('Later on the laptop') || after.endsWith('Later on the phone')).toBe(
      true,
    );
  });

  it('appends to the last ## Captures heading when a note has several', () => {
    const doc = dailyNote(
      '## Captures\n\n**08:00** One\n\n## Notes\n\nText\n\n## Captures\n\n**08:05** Two\n\n## End\n',
    );
    appendCapture(doc, 'Three', '08:10');
    expect(markdownOf(doc)).toBe(
      [
        '## Captures',
        '**08:00** One',
        '## Notes',
        'Text',
        '## Captures',
        '**08:05** Two',
        '**08:10** Three',
        '## End',
      ].join('\n\n'),
    );
  });

  it('stamps the time in the synced time zone, not the device’s', () => {
    const at = new Date('2026-10-23T19:32:00Z');
    expect(captureTime(at, 'America/Chicago')).toBe('14:32');
    expect(captureTime(at, 'Asia/Tokyo')).toBe('04:32');
    expect(captureTime(new Date('2026-10-23T05:00:00Z'), 'America/Chicago')).toBe('00:00');
  });
});

describe('a capture filed as a new note', () => {
  it('takes its title from the first line and the rest as the body', () => {
    expect(splitCapture('\n- [ ] Renew passport\nForms are in the desk\n')).toEqual({
      title: 'Renew passport',
      body: 'Forms are in the desk',
    });
    expect(splitCapture('## Shed idea')).toEqual({ title: 'Shed idea', body: '' });
    expect(splitCapture('   ')).toEqual({ title: '', body: '' });
  });

  it('keeps a long first line whole in the body under a shortened title (A343)', () => {
    const paragraph = `${'All work and no play makes Jack a dull boy. '.repeat(11).trim()} The end.`;
    expect(paragraph.length).toBeGreaterThan(CAPTURE_TITLE_MAX);
    const { title, body } = splitCapture(`${paragraph}\nSecond line`);
    expect(title.length).toBeLessThanOrEqual(CAPTURE_TITLE_MAX);
    expect(title.endsWith('…')).toBe(true);
    // Cut at a word.
    expect(paragraph.startsWith(title.slice(0, -1))).toBe(true);
    expect(paragraph[title.length - 1]).toBe(' ');
    // Nothing dropped.
    expect(body).toBe(`${paragraph}\nSecond line`);
    // A list item keeps its marker in the body.
    expect(splitCapture(`- ${paragraph}`).body).toBe(`- ${paragraph}`);
    // A title of exactly the cap is whole, and the line is not repeated.
    const exact = 'x'.repeat(CAPTURE_TITLE_MAX);
    expect(splitCapture(exact)).toEqual({ title: exact, body: '' });
    // No half of a surrogate pair at the cut.
    const emoji = splitCapture('😀'.repeat(100)).title;
    expect(emoji.endsWith('…')).toBe(true);
    expect(/[\uD800-\uDBFF]…$/.test(emoji)).toBe(false);
  });

  it('titles a capture of pictures only and keeps every picture in the body (A343)', () => {
    const one = '![](attachments/aaaa.png)';
    expect(splitCapture(one, '2026-10-23')).toEqual({ title: 'Picture 2026-10-23', body: one });
    const two = `${one}\n\n![](attachments/bbbb.jpg)`;
    expect(splitCapture(two, '2026-10-23')).toEqual({ title: 'Pictures 2026-10-23', body: two });
    expect(splitCapture(one).title).toBe('Picture');
    // Pictures before the words: the words are the title, the pictures stay in the body.
    expect(splitCapture(`${one}\n\nThe view from the top\nWindy`)).toEqual({
      title: 'The view from the top',
      body: `${one}\n\nWindy`,
    });
    // A picture on the title's line stays in the body with the line.
    expect(splitCapture(`The view ${one}`)).toEqual({ title: 'The view', body: `The view ${one}` });
    expect(splitCapture(`- ${one}`, '2026-10-23')).toEqual({
      title: 'Picture 2026-10-23',
      body: `- ${one}`,
    });
  });

  it('appends the body to an empty note', () => {
    const doc = new Y.Doc();
    expect(appendMarkdown(doc, 'Forms are in the **desk**')).toBe(true);
    expect(markdownOf(doc)).toBe('Forms are in the **desk**');
  });
});
