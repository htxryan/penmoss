import { parseMarkdown } from '@penmoss/core';
import type { JSONContent } from '@tiptap/core';
import { TextSelection } from '@tiptap/pm/state';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { loadCodec } from '../src/clipboard/markdown';
import { pictureBytes } from '../src/clipboard/paste';
import { sanitizeClipboardHTML } from '../src/clipboard/sanitize';
import { clipboardToken } from '../src/clipboard/token';
import type { ImageServices } from '../src/extensions/image';
import type { CollabEditor } from '../src/collab';
import { copy, markdownOf, paste } from './support/clipboard';
import { openEditor } from './support/editor';

// Review follow-up (T15): what a paste may make the browser fetch, and which
// addresses it may store.

const HASH = 'c'.repeat(64);
const PATH = `attachments/${HASH}.png`;
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGBgAAAABQABpfZFQAAAAABJRU5ErkJggg==';
const MAX = 50 * 1024 * 1024;

beforeAll(async () => {
  await loadCodec();
});

function editorWith(markdown: string, options?: Parameters<typeof openEditor>[1]): CollabEditor {
  const doc = parseMarkdown(markdown).doc.toJSON() as { content: JSONContent[] };
  return openEditor(doc.content, options);
}

function selectAll(collab: CollabEditor): void {
  const { view } = collab.editor;
  view.dispatch(
    view.state.tr.setSelection(
      TextSelection.create(view.state.doc, 0, view.state.doc.content.size),
    ),
  );
}

/** Every image source and link address in the editor's document. */
function addresses(collab: CollabEditor): { images: string[]; links: string[] } {
  const images: string[] = [];
  const links: string[] = [];
  collab.editor.state.doc.descendants((node) => {
    if (node.type.name === 'image') images.push(node.attrs['src'] as string);
    for (const mark of node.marks) {
      if (mark.type.name === 'link') links.push(mark.attrs['href'] as string);
    }
    return true;
  });
  return { images, links };
}

const clean = (html: string, options?: Parameters<typeof sanitizeClipboardHTML>[2]) =>
  sanitizeClipboardHTML(html, new DOMParser(), options);

describe('remote pictures are never fetched by a paste', () => {
  it('turns web pictures in pasted markdown into links (a README with badges)', () => {
    const collab = openEditor();
    paste(collab, {
      'text/plain': `# Project\n\n![build](https://img.shields.io/badge/build-passing.svg) ![](https://x.example/p.png) ![local](${PATH}) ![rel](./pic.png)`,
    });
    expect(addresses(collab).images).toEqual([PATH]);
    expect(markdownOf(collab)).toBe(
      `# Project\n\n[build](https://img.shields.io/badge/build-passing.svg) [Image](https://x.example/p.png) ![local](${PATH}) rel\n`,
    );
    expect(collab.editor.view.dom.querySelector('img[src^="http"]')).toBeNull();
  });

  it('does not trust a forged Penmoss marker', () => {
    const collab = openEditor();
    paste(collab, {
      'text/html':
        '<p data-pm-slice="1 1 []" data-penmoss="">Hi <img src="https://track.example/p.png" alt="pixel"></p>',
    });
    expect(addresses(collab).images).toEqual([]);
    expect(markdownOf(collab)).toBe('Hi [pixel](https://track.example/p.png)\n');
  });

  it('marks its own copies with a random per-install token that paste checks', () => {
    const token = clipboardToken();
    expect(token).toMatch(/^[0-9a-f]{32}$/);
    expect(clipboardToken()).toBe(token);
    const source = editorWith('Some **text**');
    selectAll(source);
    const html = copy(source).getData('text/html');
    expect(html).toContain(`data-penmoss="${token}"`);
    expect(clean(html, { trustedMarker: token }).fromPenmoss).toBe(true);
    expect(clean(html.replace(token, ''), { trustedMarker: token }).fromPenmoss).toBe(false);
    expect(clean(html.replace(token, 'f'.repeat(32)), { trustedMarker: token }).fromPenmoss).toBe(
      false,
    );
    expect(clean(html).fromPenmoss).toBe(false);
  });

  it('turns a web picture copied between notes into a link too (A52)', () => {
    const source = editorWith(`![cat](https://img.example/cat.jpg) and ![kept](${PATH})`);
    selectAll(source);
    const target = openEditor();
    paste(target, Object.fromEntries(copy(source).data));
    expect(addresses(target).images).toEqual([PATH]);
    expect(markdownOf(target)).toBe(`[cat](https://img.example/cat.jpg) and ![kept](${PATH})\n`);
  });

  it('ignores srcset, <picture> sources, <base>, forms and objects', () => {
    const html =
      '<base href="https://evil.example/">' +
      '<p><img src="https://img.example/a.png" srcset="https://track.example/2x.png 2x" alt="A"></p>' +
      '<picture><source srcset="https://track.example/b.webp"><img src="https://img.example/b.png" alt="B"></picture>' +
      '<p><a href="/relative">rel</a></p>' +
      '<form action="https://evil.example/post"><input value="secret"><button>Go</button><p>Inside</p></form>' +
      '<object data="https://evil.example/x.swf"><p>fallback</p></object>';
    const out = clean(html).html;
    expect(out).not.toMatch(/srcset|<source|<base|<form|<object|<input|<button|evil|track/);
    const collab = openEditor();
    paste(collab, { 'text/html': html });
    expect(markdownOf(collab)).toBe(
      '[A](https://img.example/a.png)\n\n[B](https://img.example/b.png)\n\nrel\n\nInside\n',
    );
  });
});

describe('pasted link addresses', () => {
  it('drops unsafe links in pasted markdown to their text', () => {
    const collab = openEditor();
    paste(collab, {
      'text/plain':
        '# Links\n\n[click](javascript:alert(1)) <javascript:alert(2)> [ok](https://example.com) [data](data:text/html,x) [vb](vbscript:x)',
    });
    expect(addresses(collab).links).toEqual(['https://example.com']);
    expect(collab.editor.getText()).toContain('click');
    expect(collab.editor.getText()).toContain('javascript:alert(2)');
  });

  it('drops obfuscated links through the full HTML paste', () => {
    const bad = [
      'jav&#x09;ascript:alert(1)',
      '&#106;avascript:alert(1)',
      ' javascript:alert(1)',
      'JaVaScRiPt:alert(1)',
      'java&#10;script:alert(1)',
      'javascript&colon;alert(1)',
      '&#x6A;&#x61;&#x76;&#x61;&#x73;&#x63;&#x72;&#x69;&#x70;&#x74;&#x3A;alert(1)',
      'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
      'vbscript:msgbox(1)',
      '//evil.example/x',
      'file:///etc/passwd',
    ];
    const collab = openEditor();
    paste(collab, {
      'text/html':
        bad.map((href, i) => `<p><a href="${href}">x${i}</a></p>`).join('') +
        '<p><a href="https://ok.example/">ok</a></p>',
    });
    expect(addresses(collab).links).toEqual(['https://ok.example/']);
    expect(collab.editor.getText()).toContain('x10');
  });
});

describe('the slice context ProseMirror reads from pasted HTML', () => {
  it('keeps only wrapper nodes with valid attributes', () => {
    const marker = (context: unknown) =>
      clean(`<p data-pm-slice="1 1 ${JSON.stringify(context).replace(/"/g, '&quot;')}">x</p>`).html;
    expect(marker(['image', { src: 'https://t.example/p.png' }])).toBe('<p>x</p>');
    expect(marker(['codeBlock', { language: 'js' }])).toBe('<p>x</p>');
    expect(marker('nope')).toBe('<p>x</p>');
    expect(
      marker(['blockquote', null, 'callout', { type: 'warning', title: 'T', onload: 'x' }]),
    ).toBe(
      '<p data-pm-slice="1 1 [&quot;blockquote&quot;,null,&quot;callout&quot;,{&quot;type&quot;:&quot;warning&quot;,&quot;title&quot;:&quot;T&quot;}]">x</p>',
    );
    expect(marker(['callout', { type: 'bad type"><x' }])).toBe(
      '<p data-pm-slice="1 1 [&quot;callout&quot;,{}]">x</p>',
    );
    expect(marker(['orderedList', { start: '7' }, 'listItem', null])).toBe(
      '<p data-pm-slice="1 1 [&quot;orderedList&quot;,{},&quot;listItem&quot;,null]">x</p>',
    );
  });
});

describe('style rules in pasted HTML', () => {
  it('reads long or broken <style> blocks to the end (their time is a budget)', () => {
    // A backtracking reader would hang here, past the test's own timeout; that it is linear is
    // a wall-clock budget, in clipboard-security.budget.test.ts (A1244).
    for (const style of ['a'.repeat(200_000), '/*'.repeat(100_000), 'p,'.repeat(100_000)])
      expect(clean(`<style>${style}</style><p>x</p>`).html).toContain('x</p>');
  });
});

describe('data: pictures', () => {
  it('refuses one over 50 MB without decoding it', async () => {
    const decode = vi.spyOn(globalThis, 'atob');
    const huge = `data:image/png;base64,${PNG_BASE64}${'A'.repeat(Math.ceil((MAX * 4) / 3))}`;
    await expect(pictureBytes(huge, document)).rejects.toThrow('Images over 50 MB cannot be added');
    for (const [input] of decode.mock.calls) expect(input.length).toBeLessThan(1000);
    decode.mockRestore();
  });

  it('refuses one whose bytes are not a supported picture before decoding it all', async () => {
    const decode = vi.spyOn(globalThis, 'atob');
    // An SVG (it can carry script) labelled as a PNG.
    const svg = btoa('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    const src = `data:image/png;base64,${svg}${'A'.repeat(4_000_000)}`;
    await expect(pictureBytes(src, document)).rejects.toThrow(
      'Only PNG, JPEG, GIF, WebP and AVIF images can be added',
    );
    for (const [input] of decode.mock.calls) expect(input.length).toBeLessThan(1000);
    decode.mockRestore();
  });

  it('still decodes a normal picture', async () => {
    const bytes = await pictureBytes(`data:image/png;base64,${PNG_BASE64}`, document);
    expect([...bytes.slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });

  it('keeps the text of a paste whose picture is refused, and says why', async () => {
    const onError = vi.fn();
    const add = vi.fn(() => Promise.resolve({ path: PATH }));
    const images: ImageServices = { add, onError, resolve: () => Promise.resolve(null) };
    const collab = openEditor(undefined, { images });
    const svg = btoa('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    paste(collab, {
      'text/html': `<p>Before <img src="data:image/png;base64,${svg}" alt="logo"> after</p>`,
    });
    await vi.waitFor(() => expect(markdownOf(collab)).toContain('after'));
    expect(add).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith('Only PNG, JPEG, GIF, WebP and AVIF images can be added');
    expect(markdownOf(collab)).toBe('Before logo after\n');
  });
});

describe('blob: pictures', () => {
  it('stores the original bytes when the blob can be read', async () => {
    const add = vi.fn((bytes: Uint8Array) => {
      void bytes;
      return Promise.resolve({ path: PATH });
    });
    const collab = openEditor(undefined, { images: { add, resolve: () => Promise.resolve(null) } });
    const original = Uint8Array.from(atob(PNG_BASE64), (c) => c.charCodeAt(0));
    const blob = new Blob([original], { type: 'image/png' });
    const url = URL.createObjectURL(blob);
    // happy-dom cannot fetch blob: URLs; a browser can (this origin's, with connect-src blob:).
    const fetch = vi
      .spyOn(window, 'fetch')
      .mockImplementation((input) =>
        Promise.resolve(
          String(input as string) === url
            ? new Response(blob)
            : new Response(null, { status: 404 }),
        ),
      );
    try {
      paste(collab, { 'text/html': `<p>Shot <img src="${url}" alt="s"></p>` });
      await vi.waitFor(() => expect(add).toHaveBeenCalledTimes(1));
      expect([...add.mock.calls[0]![0]]).toEqual([...original]);
      await vi.waitFor(() => expect(markdownOf(collab)).toBe(`Shot ![s](${PATH})\n`));
    } finally {
      fetch.mockRestore();
    }
  });
});
