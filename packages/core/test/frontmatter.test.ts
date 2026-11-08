import { describe, expect, it } from 'vitest';
import {
  createFrontmatter,
  frontmatterKeys,
  parseFrontmatter,
  readNoteMeta,
  serializeFrontmatter,
  setFrontmatterFields,
} from '../src/frontmatter';

const NOTE = `id: 01JB7Q3V6M8K2T9RZ4XN5C1HPD
title: Penmoss — sync design
created: 2026-10-14T09:12:00-05:00
updated: 2026-10-21T16:40:12-05:00
tags: [penmoss, architecture]
aliases: [sync design]
type: note
`;

describe('frontmatterKeys (T24 review #10)', () => {
  it('lists every top-level key as written, known or not', () => {
    expect(frontmatterKeys(parseFrontmatter('title: A\nstatus: draft\n7: x\ntags: [a]'))).toEqual([
      'title',
      'status',
      '7',
      'tags',
    ]);
    expect(frontmatterKeys(parseFrontmatter(''))).toEqual([]);
  });

  it('is null for frontmatter that is not a map of keys, or is malformed', () => {
    expect(frontmatterKeys(parseFrontmatter('- a\n- b'))).toBeNull();
    expect(frontmatterKeys(parseFrontmatter('title: [unclosed'))).toBeNull();
  });
});

describe('readNoteMeta', () => {
  it('reads every known key as typed values', () => {
    expect(readNoteMeta(parseFrontmatter(NOTE))).toEqual({
      id: '01JB7Q3V6M8K2T9RZ4XN5C1HPD',
      title: 'Penmoss — sync design',
      created: '2026-10-14T09:12:00-05:00',
      updated: '2026-10-21T16:40:12-05:00',
      tags: ['penmoss', 'architecture'],
      aliases: ['sync design'],
      type: 'note',
    });
  });

  it('keeps timestamps as the strings written (YAML 1.2 core schema)', () => {
    expect(readNoteMeta(parseFrontmatter('created: 2026-10-14\n')).created).toBe('2026-10-14');
  });

  it('accepts a single tag written as a scalar', () => {
    expect(readNoteMeta(parseFrontmatter('tags: inbox\n')).tags).toEqual(['inbox']);
  });

  it('omits keys that are absent or the wrong shape', () => {
    expect(readNoteMeta(parseFrontmatter('title: [1, 2]\nrating: 5\n'))).toEqual({});
  });
});

describe('serializeFrontmatter', () => {
  it('returns unmodified frontmatter byte for byte, including comments and quoting', () => {
    const source = `# kept\ntitle: "Quoted"\nweird:   spacing\nnested:\n    deep: [ 1,2 ]\n`;

    expect(serializeFrontmatter(parseFrontmatter(source))).toBe(source);
  });

  it('adds a missing final newline', () => {
    expect(serializeFrontmatter(parseFrontmatter('title: A'))).toBe('title: A\n');
  });

  it('serialises empty frontmatter as an empty string', () => {
    expect(serializeFrontmatter(parseFrontmatter(''))).toBe('');
  });

  it('keeps invalid YAML verbatim and reports it', () => {
    const source = 'title: [unclosed\n';
    const fm = parseFrontmatter(source);

    expect(fm.errors.length).toBeGreaterThan(0);
    expect(serializeFrontmatter(fm)).toBe(source);
  });
});

describe('setFrontmatterFields', () => {
  it('updates a known key in place and keeps unknown keys, order and comments', () => {
    const source = `id: n1\n# a comment\ncustom: {a: 1}\nupdated: 2026-10-01\nzeta: last\n`;

    const updated = setFrontmatterFields(parseFrontmatter(source), {
      updated: '2026-10-22T10:00:00-05:00',
    });

    expect(serializeFrontmatter(updated)).toBe(
      `id: n1\n# a comment\ncustom: {a: 1}\nupdated: 2026-10-22T10:00:00-05:00\nzeta: last\n`,
    );
  });

  it('appends new keys at the end', () => {
    const updated = setFrontmatterFields(parseFrontmatter('id: n1\n'), {
      tags: ['a', 'b'],
    });

    expect(serializeFrontmatter(updated)).toBe('id: n1\ntags: [a, b]\n');
  });

  it('removes a key set to undefined', () => {
    const updated = setFrontmatterFields(parseFrontmatter('id: n1\ntype: note\n'), {
      type: undefined,
    });

    expect(serializeFrontmatter(updated)).toBe('id: n1\n');
  });

  it('does not mutate the original frontmatter', () => {
    const original = parseFrontmatter('id: n1\n');

    setFrontmatterFields(original, { title: 'New' });

    expect(serializeFrontmatter(original)).toBe('id: n1\n');
  });

  it('does not wrap long values', () => {
    const title = 'word '.repeat(40).trim();

    const updated = setFrontmatterFields(parseFrontmatter('id: n1\n'), { title });

    expect(serializeFrontmatter(updated)).toBe(`id: n1\ntitle: ${title}\n`);
  });
});

describe('createFrontmatter', () => {
  it('writes known keys in canonical order with flow-style lists', () => {
    const fm = createFrontmatter({
      type: 'note',
      tags: ['penmoss', 'architecture'],
      title: 'Penmoss — sync design',
      id: '01JB7Q3V6M8K2T9RZ4XN5C1HPD',
      aliases: ['sync design'],
      created: '2026-10-14T09:12:00-05:00',
      updated: '2026-10-21T16:40:12-05:00',
    });

    expect(serializeFrontmatter(fm)).toBe(NOTE);
  });

  it('quotes values YAML would otherwise retype', () => {
    const fm = createFrontmatter({ title: 'true' });

    expect(serializeFrontmatter(fm)).toBe('title: "true"\n');
    expect(readNoteMeta(parseFrontmatter(serializeFrontmatter(fm))).title).toBe('true');
  });
});
