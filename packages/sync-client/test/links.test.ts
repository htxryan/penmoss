import { contextText } from '@penmoss/core/links';
import { describe, expect, it } from 'vitest';
import { toMeta } from '../src/idb';
import { LINKS_VERSION, needsLinks, recordFromDoc, withLinks, withoutLinks } from '../src/records';
import { bodyJson } from '../src/yjs14';
import {
  appendEmbed,
  appendLinkParagraph,
  appendParagraph,
  createReplica,
} from './support/editing';

describe('local link index (T16)', () => {
  it('reads wikilinks from the replica, with their context', () => {
    const replica = createReplica();
    appendParagraph(replica, 'Intro');
    appendLinkParagraph(replica, 'See ', { noteId: 'n1', target: 'Sync' }, ' for details');

    const links = replica.links();

    expect(links).toMatchObject([{ noteId: 'n1', target: 'Sync', embed: false }]);
    expect(contextText(links[0]!.context, () => 'Sync design')).toBe('See Sync design for details');
    expect(bodyJson(replica.doc).content?.map((block) => block.type)).toEqual([
      'paragraph',
      'paragraph',
    ]);
  });

  it('stores links in the record and the list metadata, and leaves them out when there are none', () => {
    const linked = createReplica();
    appendLinkParagraph(linked, '', { noteId: 'n2', target: 'Brief', heading: 'Goals' }, '');
    const record = recordFromDoc('a', linked.doc, { epoch: null, unsynced: false });

    expect(record.links).toMatchObject([{ noteId: 'n2', heading: 'Goals' }]);
    expect(toMeta(record).links).toEqual(record.links);

    const plain = createReplica();
    appendParagraph(plain, 'No links');
    const none = recordFromDoc('b', plain.doc, { epoch: null, unsynced: false });
    expect('links' in none).toBe(false);
    expect('links' in toMeta(none)).toBe(false);
  });
});

describe('the links version (review follow-up)', () => {
  it('tells a note with no links from a record written before links were indexed', () => {
    const plain = createReplica();
    appendParagraph(plain, 'No links');
    const none = recordFromDoc('b', plain.doc, { epoch: null, unsynced: false });
    expect(none.linksVersion).toBe(LINKS_VERSION);
    expect(toMeta(none).linksVersion).toBe(LINKS_VERSION);
    expect(needsLinks(toMeta(none))).toBe(false);

    const linked = createReplica();
    appendLinkParagraph(linked, 'See ', { noteId: 'n2', target: 'Brief' }, '');
    const current = recordFromDoc('a', linked.doc, { epoch: 'e', unsynced: false });
    // As stored before T16: no links and no version.
    const old = withoutLinks(current);
    expect(needsLinks(toMeta(old))).toBe(true);

    const filled = withLinks(old);
    expect(filled.links).toMatchObject([{ noteId: 'n2', target: 'Brief' }]);
    expect(filled.linksVersion).toBe(LINKS_VERSION);
    expect(filled.update).toBe(old.update);
    expect(filled.epoch).toBe('e');
    expect(filled.rev).not.toBe(old.rev);
  });
});

describe('embeds (T13)', () => {
  it('index as links, and are searchable only in their source note', () => {
    const source = createReplica();
    appendParagraph(source, 'Water the tomatoes every morning');
    const host = createReplica();
    appendParagraph(host, 'This week');
    appendEmbed(host, { noteId: 'src', target: 'Garden', heading: 'Watering' });

    const record = recordFromDoc('host', host.doc, { epoch: null, unsynced: false });

    expect(host.links()).toMatchObject([
      { noteId: 'src', target: 'Garden', heading: 'Watering', embed: true },
    ]);
    expect(bodyJson(host.doc).content?.map((block) => block.type)).toEqual(['paragraph', 'embed']);
    // The host stores a reference, never the embedded text.
    expect(record.text).toBe('This week');
    expect(record.text).not.toContain('tomatoes');
  });
});
