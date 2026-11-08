import type { JSONContent } from '@tiptap/core';
import { TextSelection } from '@tiptap/pm/state';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadCodec } from '../src/clipboard/markdown';
import { sanitizeClipboardHTML } from '../src/clipboard/sanitize';
import type { CollabEditor } from '../src/collab';
import { copy, paste } from './support/clipboard';
import { openEditor, paragraph } from './support/editor';

// Merge follow-up (T13/T16 with T15): the sanitiser rebuilds pasted HTML from
// an allow-list, so wikilinks, embeds and attachment chips must be on it, or a
// copy between notes turns them into plain text.

const NOTE = '01J9ZK3Q8X4V2B6N7M5C0D1E2F';
const OTHER = '01J9ZK3Q8X4V2B6N7M5C0D1E2G';
const FILE = `attachments/${'a'.repeat(64)}.pdf`;

beforeAll(async () => {
  await loadCodec();
});

const wikilink = (noteId: string | null, target: string, heading: string | null = null) => ({
  type: 'wikilink',
  attrs: { noteId, target, heading, alias: 'the plan' },
});
const embed = (noteId: string | null, target: string, heading: string | null = null) => ({
  type: 'embed',
  attrs: { noteId, target, heading, alias: null },
});
const attachment = (href: string, name: string) => ({ type: 'attachment', attrs: { href, name } });

function selectAll(collab: CollabEditor): void {
  const { view } = collab.editor;
  view.dispatch(
    view.state.tr.setSelection(
      TextSelection.create(view.state.doc, 0, view.state.doc.content.size),
    ),
  );
}

function nodes(collab: CollabEditor, name: string): Record<string, unknown>[] {
  const found: Record<string, unknown>[] = [];
  collab.editor.state.doc.descendants((node) => {
    if (node.type.name === name) found.push({ ...node.attrs });
    return true;
  });
  return found;
}

const clean = (html: string) => sanitizeClipboardHTML(html, new DOMParser()).html;

describe('copying links, embeds and files between notes', () => {
  it('keeps wikilinks, embeds and attachment chips (and their ids) through copy and paste', () => {
    const source = openEditor([
      {
        type: 'paragraph',
        content: [{ type: 'text', text: 'See ' }, wikilink(NOTE, 'Plan', 'Goals')],
      },
      embed(OTHER, 'Garden', 'Watering'),
      { type: 'paragraph', content: [attachment(FILE, 'Q3 report.pdf')] },
    ] as JSONContent[]);
    selectAll(source);
    const clipboard = copy(source);

    const target = openEditor([paragraph()]);
    paste(target, {
      'text/html': clipboard.getData('text/html'),
      'text/plain': clipboard.getData('text/plain'),
    });

    expect(nodes(target, 'wikilink')).toEqual([
      { noteId: NOTE, target: 'Plan', heading: 'Goals', alias: 'the plan' },
    ]);
    expect(nodes(target, 'embed')).toEqual([
      { noteId: OTHER, target: 'Garden', heading: 'Watering', alias: null },
    ]);
    expect(nodes(target, 'attachment')).toEqual([{ href: FILE, name: 'Q3 report.pdf' }]);
  });

  it('keeps them from HTML without the install marker too (another device), checked', () => {
    const html = clean(
      `<p><a data-wikilink data-note-id="${NOTE}" data-target="Plan" href="/notes/${NOTE}">Plan</a></p>` +
        `<div data-embed data-note-id="${OTHER}" data-target="Garden">![[Garden]]</div>` +
        `<p><a data-attachment data-href="${FILE}" data-name="r.pdf" href="${FILE}">r.pdf</a></p>`,
    );
    expect(html).toContain(`data-wikilink="" data-note-id="${NOTE}" data-target="Plan"`);
    expect(html).toContain(`<div data-embed="" data-note-id="${OTHER}" data-target="Garden">`);
    expect(html).toContain(`data-attachment="" data-href="${FILE}" data-name="r.pdf"`);
  });

  it('drops values a page could abuse: bad ids, unsafe file paths, handlers, oversize text', () => {
    const html = clean(
      `<p><a data-wikilink data-note-id="../../x" data-target="Plan" onclick="x()">Plan</a></p>` +
        `<div data-embed data-note-id="${OTHER}" data-target="${'x'.repeat(2000)}" style="x">y</div>` +
        `<p><a data-attachment data-href="javascript:alert(1)" data-name="r.pdf">r.pdf</a></p>`,
    );
    expect(html).not.toContain('../../x');
    expect(html).not.toContain('onclick');
    expect(html).not.toContain('style');
    expect(html).not.toContain('javascript');
    expect(html).not.toContain('x'.repeat(2000));
    // The link keeps its written target without the bad id; the bad file is plain text.
    expect(html).toContain('data-wikilink="" data-target="Plan"');
    expect(html).not.toContain('data-attachment');
    expect(html).toContain('r.pdf');
  });

  it('keeps a pasted attachment path a chip, not a broken link', () => {
    const target = openEditor([paragraph()]);
    paste(target, {
      'text/html': `<p><a data-attachment data-href="${FILE}" data-name="r.pdf" href="${FILE}">r.pdf</a></p>`,
    });
    expect(nodes(target, 'attachment')).toEqual([{ href: FILE, name: 'r.pdf' }]);
  });
});
