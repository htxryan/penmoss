import { parseMarkdown, schema as coreSchema, serializeMarkdown } from '@penmoss/core';
import type { JSONContent } from '@tiptap/core';
import { CellSelection } from '@tiptap/pm/tables';
import { TextSelection } from '@tiptap/pm/state';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadCodec, looksLikeMarkdown, escapeCurrency } from '../src/clipboard/markdown';
import { loadMermaid } from '../src/extensions/mermaid';
import { safeHref, sanitizeClipboardHTML } from '../src/clipboard/sanitize';
import { pastePlainText, vscodeLanguage } from '../src/clipboard/paste';
import { CLIPBOARD_COMMANDS } from '../src/clipboard';
import type { ImageServices } from '../src/extensions/image';
import type { CollabEditor } from '../src/collab';
import { copy, markdownOf, paste, pressPastePlain } from './support/clipboard';
import { openEditor, paragraph, press, select, startOf } from './support/editor';

const HASH = 'b'.repeat(64);
const PATH = `attachments/${HASH}.png`;
// A 1×1 PNG.
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGBgAAAABQABpfZFQAAAAABJRU5ErkJggg==';

// The copying tests' note has a mermaid block, whose diagram loads Mermaid (a large lazy
// import) in the background; loading it here keeps that time out of whichever test runs next (#323).
beforeAll(async () => {
  await Promise.all([loadCodec(), loadMermaid()]);
}, 60_000);

/** An editor holding `markdown` (parsed by the core codec, as a note loads). */
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

/** Document positions of the first occurrence of `text`. */
function find(collab: CollabEditor, text: string): { from: number; to: number } {
  let found: { from: number; to: number } | null = null;
  collab.editor.state.doc.descendants((node, pos) => {
    if (found || !node.isText) return !found;
    const at = node.text!.indexOf(text);
    if (at >= 0) found = { from: pos + at, to: pos + at + text.length };
    return false;
  });
  if (!found) throw new Error(`No "${text}" in the document`);
  return found;
}

describe('looksLikeMarkdown', () => {
  it.each([
    ['# Title\n\nSome text.'],
    ['- milk\n- eggs'],
    ['1. first\n2. second'],
    ['- [ ] call Toni'],
    ['```ts\nconst x = 1;\n```'],
    ['| a | b |\n| --- | --- |\n| 1 | 2 |'],
    ['> [!warning] Careful\n> Hot.'],
    ['See [the docs](https://example.com).'],
    ['Use **bold** and `code`.'],
    ['---\ntitle: A note\n---\nBody'],
    ['$$\nx^2\n$$'],
  ])('reads %j as markdown', (text) => {
    expect(looksLikeMarkdown(text)).toBe(true);
  });

  it.each([
    ['Dear Bob,\n\nThanks for lunch. See you on Friday.'],
    ['It costs $5 and 2*3*4 = 24.'],
    ['Rename snake_case_name to camelCase.'],
    ['# install the deps\nnpm install\n# run it\nnpm start'],
    ['Only **one** marker here.'],
    ['- one dash line on its own'],
    ['A footnote* and another*.'],
    ['https://example.com/a_b_c'],
    [''],
  ])('reads %j as plain text', (text) => {
    expect(looksLikeMarkdown(text)).toBe(false);
  });

  it('escapes money so prose never turns into formulas', () => {
    expect(escapeCurrency('between $5 and $10, `$1` stays')).toBe(
      'between \\$5 and \\$10, `$1` stays',
    );
    expect(escapeCurrency('$x^2$ stays math')).toBe('$x^2$ stays math');
  });

  it('leaves money in indented code alone', () => {
    expect(escapeCurrency('Text\n\n    cost = $5\n\nMore $5')).toBe(
      'Text\n\n    cost = $5\n\nMore \\$5',
    );
    // In a list, an indented line is the item's text, not code.
    expect(escapeCurrency('- item\n\n    costs $5')).toBe('- item\n\n    costs \\$5');
  });
});

describe('pasting plain text', () => {
  it('parses markdown text with the core codec', () => {
    const collab = openEditor();
    paste(collab, { 'text/plain': '## Plan\n\n- [x] Book flights\n- [ ] Pack\n\n**Leave** at 9.' });
    expect(markdownOf(collab)).toBe(
      '## Plan\n\n- [x] Book flights\n- [ ] Pack\n\n**Leave** at 9.\n',
    );
  });

  it('keeps prose as typed, without inventing formatting', () => {
    const collab = openEditor();
    paste(collab, { 'text/plain': 'Lunch was $12 and 2*3*4 = 24.\nsnake_case_name stays.' });
    expect(collab.editor.getJSON().content).toEqual([
      paragraph('Lunch was $12 and 2*3*4 = 24.'),
      paragraph('snake_case_name stays.'),
    ]);
  });

  it('keeps money as text in pasted markdown', () => {
    const collab = openEditor();
    paste(collab, { 'text/plain': '- Taxi $30 and tip $5\n- Lunch $12' });
    expect(markdownOf(collab)).toBe('- Taxi \\$30 and tip \\$5\n- Lunch \\$12\n');
  });

  it('joins one pasted paragraph into the text at the cursor', () => {
    const collab = openEditor([paragraph('Hello world')]);
    select(collab.editor.view, 7); // after "Hello "
    paste(collab, { 'text/plain': 'brave **new** `x`\n' });
    expect(markdownOf(collab)).toBe('Hello brave **new** `x`world\n');
  });

  it('keeps a pasted heading or code block a block, even mid-paragraph', () => {
    const collab = openEditor([paragraph('Intro text')]);
    select(collab.editor.view, 6); // after "Intro"
    paste(collab, { 'text/plain': '## Next\n\n```js\nlet a;\n```' });
    expect(markdownOf(collab)).toBe('Intro\n\n## Next\n\n```js\nlet a;\n```\n\ntext\n');
  });

  it('adds pasted list items to the list the cursor is in', () => {
    const collab = editorWith('- one\n- two');
    select(collab.editor.view, find(collab, 'two').to);
    paste(collab, { 'text/plain': '- three\n- four' });
    expect(markdownOf(collab)).toBe('- one\n- two\n- three\n- four\n');
    // In the middle of an item: between its halves. Into a checklist: as tasks.
    select(collab.editor.view, find(collab, 'one').from + 1);
    paste(collab, { 'text/plain': '- x\n- y' });
    expect(markdownOf(collab)).toBe('- o\n- x\n- y\n- ne\n- two\n- three\n- four\n');
    const tasks = editorWith('- [ ] a');
    select(tasks.editor.view, find(tasks, 'a').to);
    paste(tasks, { 'text/plain': '- [x] b\n- [ ] c' });
    expect(markdownOf(tasks)).toBe('- [ ] a\n- [x] b\n- [ ] c\n');
  });

  it('does not turn a short underline into a heading (an email signature)', () => {
    const collab = openEditor();
    paste(collab, { 'text/plain': '- milk\n- eggs\n\nThanks,\n--\nRyan' });
    const types = (collab.editor.getJSON().content ?? []).map((node) => node.type);
    expect(types).toEqual(['bulletList', 'paragraph']);
    expect(collab.editor.state.doc.lastChild!.textContent).toMatch(/^Thanks,\s*--\s*Ryan$/);
  });

  it('reads a dash underline as a rule and keeps an = underline a heading', () => {
    const collab = openEditor();
    paste(collab, { 'text/plain': '- a\n- b\n\nTotal\n---\n\nTitle\n=====\n\nBody' });
    expect(markdownOf(collab)).toBe('- a\n- b\n\nTotal\n\n---\n\n# Title\n\nBody\n');
  });

  it('keeps 2*3*4 as text inside pasted markdown', () => {
    const collab = openEditor();
    paste(collab, { 'text/plain': '- 2*3*4 = 24\n- 5*6*7 = 210\n- *real* emphasis' });
    expect(markdownOf(collab)).toBe('- 2\\*3\\*4 = 24\n- 5\\*6\\*7 = 210\n- *real* emphasis\n');
  });

  // A159: pastes never make raw markdown (it would go into the file as live HTML); its text stays.
  it('pastes markdown the codec keeps raw as text, and a mixed list as lists', () => {
    const collab = openEditor();
    paste(collab, {
      'text/plain': '# Notes\n\n<div onclick="x()">Hi</div>\n\nPress <kbd>K</kbd>.\n\n- [ ] a\n- b',
    });
    const names = new Set<string>();
    collab.editor.state.doc.descendants((node) => void names.add(node.type.name));
    expect(names).not.toContain('rawMarkdown');
    expect(names).not.toContain('rawInline');
    // (The empty paragraph the paste landed in follows.)
    expect(
      collab.editor
        .getJSON()
        .content?.map((node) => node.type)
        .slice(0, 5),
    ).toEqual(['heading', 'paragraph', 'paragraph', 'taskList', 'bulletList']);
    expect(collab.editor.state.doc.child(1).textContent).toBe('<div onclick="x()">Hi</div>');
    expect(collab.editor.state.doc.child(2).textContent).toBe('Press <kbd>K</kbd>.');
  });

  it('turns a pasted web address into a link', () => {
    const collab = openEditor([paragraph('See ')]);
    select(collab.editor.view, 5);
    paste(collab, { 'text/plain': 'https://example.com/a_b' });
    expect(markdownOf(collab)).toBe('See <https://example.com/a_b>\n');
  });
});

describe('paste and match style (⌘⇧V)', () => {
  it('inserts markdown and HTML as plain text styled like the text around it', () => {
    const collab = editorWith('Make it **bold here** please');
    const { view } = collab.editor;
    const at = find(collab, 'here');
    select(view, at.from);
    pressPastePlain(collab);
    paste(collab, {
      'text/html': '<h1>Heading</h1><p><em>styled</em> <a href="https://x.example">link</a></p>',
      'text/plain': '# **shout** https://x.example ',
    });
    expect(markdownOf(collab)).toBe(
      'Make it **bold # \\*\\*shout\\*\\* https://x.example here** please\n',
    );
  });

  it('keeps paragraphs as plain paragraphs', () => {
    const collab = openEditor([paragraph('')]);
    pressPastePlain(collab);
    paste(collab, { 'text/plain': '- not a list\n- really' });
    expect(collab.editor.getJSON().content).toEqual([
      paragraph('- not a list'),
      paragraph('- really'),
    ]);
  });
});

describe('paste and match style from an app shell (T40 P8, ED11)', () => {
  it('inserts text exactly as ⌘⇧V does: plain, styled like the text around it', () => {
    const shortcut = editorWith('Make it **bold here** please');
    select(shortcut.editor.view, find(shortcut, 'here').from);
    pressPastePlain(shortcut);
    paste(shortcut, { 'text/plain': '# **shout** https://x.example ' });

    const shell = editorWith('Make it **bold here** please');
    select(shell.editor.view, find(shell, 'here').from);
    expect(pastePlainText(shell.editor.view, '# **shout** https://x.example ')).toBe(true);
    expect(markdownOf(shell)).toBe(markdownOf(shortcut));
    expect(markdownOf(shell)).toBe(
      'Make it **bold # \\*\\*shout\\*\\* https://x.example here** please\n',
    );
  });

  it('keeps lines as plain paragraphs, never a list', () => {
    const collab = openEditor([paragraph('')]);
    expect(pastePlainText(collab.editor.view, '- not a list\r\n- really')).toBe(true);
    expect(collab.editor.getJSON().content).toEqual([
      paragraph('- not a list'),
      paragraph('- really'),
    ]);
  });

  it('puts text into a code block as it is, and does nothing read-only or empty', () => {
    const collab = editorWith('```py\nx = 1\n```');
    const { view } = collab.editor;
    select(view, startOf(view, 'codeBlock') + 5);
    expect(pastePlainText(view, '\n# **not** markdown')).toBe(true);
    expect(markdownOf(collab)).toBe('```py\nx = 1\n# **not** markdown\n```\n');
    expect(pastePlainText(view, '')).toBe(false);
    collab.editor.setEditable(false);
    expect(pastePlainText(view, 'x')).toBe(false);
  });
});

describe('pasting into a code block', () => {
  it('inserts the plain text, whatever the clipboard holds', () => {
    const collab = editorWith('```py\nx = 1\n```');
    const { view } = collab.editor;
    select(view, startOf(view, 'codeBlock') + 5); // after "x = 1"
    paste(collab, {
      'text/html': '<h1>Title</h1><p><b>bold</b></p>',
      'text/plain': '\n# **not** markdown here',
      'vscode-editor-data': '{"version":1,"mode":"python"}',
    });
    expect(markdownOf(collab)).toBe('```py\nx = 1\n# **not** markdown here\n```\n');
  });
});

describe('pasting into a table cell', () => {
  const table = '| A | B |\n| - | - |\n| 1 | 2 |\n';

  it('turns pasted blocks into one line of the cell', () => {
    const collab = editorWith(table);
    const { view } = collab.editor;
    select(view, find(collab, '1').to);
    paste(collab, {
      'text/html':
        '<h2>Head</h2><ul><li>one</li><li><b>two</b></li></ul><pre><code>a\nb</code></pre>',
      'text/plain': 'Head',
    });
    expect(markdownOf(collab)).toBe(
      '| A | B |\n| - | - |\n| 1Head<br>one<br>**two**<br>a<br>b | 2 |\n',
    );
  });

  it('turns pasted markdown into one line of the cell', () => {
    const collab = editorWith(table);
    select(collab.editor.view, find(collab, '2').to);
    paste(collab, { 'text/plain': '# Big\n\n- x\n- y\n\n$$\nE=mc^2\n$$' });
    expect(markdownOf(collab)).toBe('| A | B |\n| - | - |\n| 1 | 2Big<br>x<br>y<br>$E=mc^2$ |\n');
  });

  it('fills cells from tab-separated text, growing the table (B3)', () => {
    const collab = editorWith(table);
    select(collab.editor.view, find(collab, '1').from);
    paste(collab, { 'text/plain': 'a\tb\tc\nd\te\tf\ng\th\ti\n' });
    expect(markdownOf(collab)).toBe(
      '| A | B | |\n| - | - | - |\n| a | b | c |\n| d | e | f |\n| g | h | i |\n',
    );
  });

  it('keeps the table whole when a table is pasted into a cell', () => {
    const collab = editorWith(table);
    select(collab.editor.view, find(collab, '1').from);
    paste(collab, {
      'text/html': '<table><tr><td>x</td><td>y</td></tr><tr><td>z</td><td>w</td></tr></table>',
    });
    const md = markdownOf(collab);
    expect(
      md
        .split('\n')
        .filter((line) => line.startsWith('|'))
        .every((line) => (line.match(/\|/g) ?? []).length === 3),
    ).toBe(true);
    expect(md).toContain('x');
  });
});

describe('paste transactions', () => {
  it('writes to the Y.Doc once per paste', () => {
    const collab = openEditor();
    const updates: Uint8Array[] = [];
    collab.replica.onUpdate((update) => updates.push(update));
    paste(collab, {
      'text/html': '<table><tr><td>a</td><td>b</td></tr></table><ul><li>c</li></ul><p><b>d</b></p>',
    });
    expect(updates).toHaveLength(1);
  });

  it('writes nothing until pictures are stored, then once, where the paste was made', async () => {
    let finish: (value: { path: string }) => void = () => undefined;
    const add = vi.fn(
      (bytes: Uint8Array) =>
        new Promise<{ path: string }>((resolve) => {
          void bytes;
          finish = resolve;
        }),
    );
    const images: ImageServices = { add, resolve: () => Promise.resolve(null) };
    const collab = openEditor([paragraph('Before after')], { images });
    const { view } = collab.editor;
    select(view, 8); // after "Before "
    const updates: Uint8Array[] = [];
    collab.replica.onUpdate((update) => updates.push(update));

    const event = paste(collab, {
      'text/html': `<p>Chart <img src="data:image/png;base64,${PNG_BASE64}" alt="Q3"> here</p>`,
    });
    expect(event.defaultPrevented).toBe(true);
    await vi.waitFor(() => expect(add).toHaveBeenCalledTimes(1));
    expect(updates).toEqual([]);

    // An edit made meanwhile (a peer's or the user's) moves the paste point with it.
    view.dispatch(view.state.tr.insertText('Earlier. ', 1));
    const before = updates.length;
    finish({ path: PATH });
    await vi.waitFor(() => expect(updates.length).toBe(before + 1));

    const bytes = add.mock.calls[0]![0];
    expect([...bytes.slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    expect(markdownOf(collab)).toBe(`Earlier. Before Chart ![Q3](${PATH}) hereafter\n`);
  });
});

describe('a delayed paste and a peer', () => {
  it('lands where it was made when a remote update arrives meanwhile', async () => {
    let finish: (value: { path: string }) => void = () => undefined;
    const add = vi.fn(
      () =>
        new Promise<{ path: string }>((resolve) => {
          finish = resolve;
        }),
    );
    const images: ImageServices = { add, resolve: () => Promise.resolve(null) };
    const local = openEditor([paragraph('Shared line')], { images });
    const peer = openEditor();
    peer.replica.applyUpdate(local.replica.encodeStateAsUpdate(), 'remote');
    expect(markdownOf(peer)).toBe('Shared line\n');

    select(local.editor.view, find(local, 'line').from);
    paste(local, {
      'text/html': `<p>pasted <img src="data:image/png;base64,${PNG_BASE64}" alt="p"> here </p>`,
    });
    await vi.waitFor(() => expect(add).toHaveBeenCalledTimes(1));

    // The peer types at the start; its update reaches this replica before the picture is stored.
    peer.editor.chain().setTextSelection(1).insertContent('Peer: ').run();
    local.replica.applyUpdate(
      peer.replica.encodeStateAsUpdate(local.replica.encodeStateVector()),
      'remote',
    );
    expect(markdownOf(local)).toBe('Peer: Shared line\n');

    finish({ path: PATH });
    await vi.waitFor(() => expect(markdownOf(local)).toContain('pasted'));
    expect(markdownOf(local)).toBe(`Peer: Shared pasted ![p](${PATH}) hereline\n`);
    peer.replica.applyUpdate(
      local.replica.encodeStateAsUpdate(peer.replica.encodeStateVector()),
      'remote',
    );
    expect(markdownOf(peer)).toBe(markdownOf(local));
  });
});

describe('pasting HTML inside containers', () => {
  it('keeps a paste into a callout inside the callout', () => {
    const collab = editorWith('> [!note] Title\n> Body text');
    select(collab.editor.view, find(collab, 'Body text').to);
    paste(collab, { 'text/html': '<p>more <b>bold</b></p><ul><li>x</li><li>y</li></ul>' });
    expect(markdownOf(collab)).toBe('> [!note] Title\n> Body textmore **bold**\n>\n> - x\n> - y\n');
  });

  it('keeps a paste into a list item inside the list', () => {
    const collab = editorWith('- one\n- two');
    select(collab.editor.view, find(collab, 'one').to);
    paste(collab, { 'text/html': '<p>alpha</p><p>beta</p>' });
    // Two paragraphs in one item: the codec writes the list loose.
    expect(markdownOf(collab)).toBe('- onealpha\n\n  beta\n\n- two\n');
  });
});

describe('pictures in pasted HTML', () => {
  it('stores data: pictures through the T10 image services, once each', async () => {
    const add = vi.fn(() => Promise.resolve({ path: PATH }));
    const collab = openEditor(undefined, { images: { add, resolve: () => Promise.resolve(null) } });
    const src = `data:image/png;base64,${PNG_BASE64}`;
    paste(collab, {
      'text/html': `<h2>Report</h2><p><img src="${src}"> and <img src="${src}" alt="again"></p>`,
    });
    await vi.waitFor(() => expect(markdownOf(collab)).toContain('Report'));
    expect(add).toHaveBeenCalledTimes(1);
    expect(markdownOf(collab)).toBe(`## Report\n\n![](${PATH}) and ![again](${PATH})\n`);
  });

  it('leaves out a picture that cannot be stored and says why', async () => {
    const onError = vi.fn();
    const add = vi.fn(() => Promise.reject(new Error('Images over 50 MB cannot be added')));
    const collab = openEditor(undefined, {
      images: { add, onError, resolve: () => Promise.resolve(null) },
    });
    paste(collab, {
      'text/html': `<p>Text <img src="data:image/png;base64,${PNG_BASE64}" alt="big"> stays</p>`,
    });
    await vi.waitFor(() => expect(markdownOf(collab)).toContain('stays'));
    expect(onError).toHaveBeenCalledWith('Images over 50 MB cannot be added');
    expect(markdownOf(collab)).toBe('Text big stays\n');
  });

  it('turns remote pictures into links and drops tracking pixels', () => {
    const collab = openEditor();
    paste(collab, {
      'text/html':
        '<p>Look <img src="https://img.example/cat.jpg" alt="A cat"><img src="https://t.example/p.gif" width="1" height="1"></p>',
    });
    expect(markdownOf(collab)).toBe('Look [A cat](https://img.example/cat.jpg)\n');
  });

  it('still takes a lone pasted picture through the T10 file path', async () => {
    const add = vi.fn(() => Promise.resolve({ path: PATH }));
    const collab = openEditor(undefined, { images: { add, resolve: () => Promise.resolve(null) } });
    const file = new File([Uint8Array.from(atob(PNG_BASE64), (c) => c.charCodeAt(0))], 'shot.png', {
      type: 'image/png',
    });
    paste(collab, { 'text/html': '<img src="https://x.example/a.png">' }, [file]);
    await vi.waitFor(() => expect(markdownOf(collab)).toBe(`![](${PATH})\n`));
  });
});

describe('sanitising', () => {
  const clean = (html: string) => sanitizeClipboardHTML(html, new DOMParser()).html;

  it('keeps only safe link addresses', () => {
    expect(safeHref('https://example.com/a')).toBe('https://example.com/a');
    expect(safeHref('mailto:a@b.c')).toBe('mailto:a@b.c');
    expect(safeHref(`attachments/${HASH}.pdf`)).toBe(`attachments/${HASH}.pdf`);
    for (const bad of [
      'javascript:alert(1)',
      ' JaVaScRiPt:alert(1)',
      'java\tscript:alert(1)',
      'vbscript:x',
      'data:text/html,<script>x</script>',
      'file:///etc/passwd',
      '/relative',
      '#top',
    ]) {
      expect(safeHref(bad)).toBeNull();
    }
    expect(safeHref('https://www.google.com/url?q=https://a.example/x&sa=D')).toBe(
      'https://a.example/x',
    );
    expect(safeHref('https://www.google.com/url?q=javascript:alert(1)')).toBe(
      'https://www.google.com/url?q=javascript:alert(1)',
    );
  });

  it('removes scripts, handlers, styles, frames and unsafe pictures', () => {
    const html = clean(
      '<p onclick="x()" style="color:red">Hi <img src="x" onerror="alert(1)"><svg onload="alert(1)"></svg>' +
        '<a href="javascript:alert(1)" onmouseover="y()">there</a></p><script>alert(1)</script>' +
        '<iframe src="https://evil.example"></iframe><style>p{}</style>' +
        '<img src="data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=">',
    );
    expect(html).toBe('<p>Hi there</p>');
  });

  it('is idempotent', () => {
    const once = clean(
      '<h1 style="x">T</h1><ul><li>a<ul><li>b</li></ul></li></ul><table><tr><td>1</td></tr></table>',
    );
    expect(clean(once)).toBe(once);
  });
});

describe('pasting from VS Code', () => {
  it('maps VS Code language ids to fence names', () => {
    expect(vscodeLanguage('typescript')).toBe('ts');
    expect(vscodeLanguage('typescriptreact')).toBe('ts'); // The picker writes tsx as ts too.
    expect(vscodeLanguage('shellscript')).toBe('bash');
    expect(vscodeLanguage('plaintext')).toBeNull();
    expect(vscodeLanguage(undefined)).toBeNull();
  });

  it('pastes one line of code as inline code', () => {
    const collab = openEditor([paragraph('Call ')]);
    select(collab.editor.view, 6);
    paste(collab, {
      'text/plain': 'greet(name)',
      'text/html':
        '<div style="font-family: Menlo; white-space: pre;"><div>greet(name)</div></div>',
      'vscode-editor-data': '{"version":1,"mode":"typescript"}',
    });
    expect(markdownOf(collab)).toBe('Call `greet(name)`\n');
  });

  it('pastes a plain text file as text', () => {
    const collab = openEditor();
    paste(collab, {
      'text/plain': 'line one\nline two\n',
      'vscode-editor-data': '{"version":1,"mode":"plaintext"}',
    });
    expect(markdownOf(collab)).toBe('line one\n\nline two\n');
  });
});

describe('copying', () => {
  const NOTE = [
    '## Plan',
    '',
    'Some **bold**, *italic*, ~~gone~~, ==marked== and `code` with $e^{i\\pi}$ and [a link](https://example.com "Title").',
    '',
    '- [x] Done',
    '- [ ] Todo',
    '',
    '* loose one',
    '',
    '* loose two',
    '',
    '3. three',
    '4. four',
    '',
    '> [!warning]- Careful now',
    '> Hot **stove**.',
    '',
    '```ts title="a.ts"',
    'const x = 1;',
    '```',
    '',
    '```mermaid',
    'graph TD; A-->B',
    '```',
    '',
    '$$',
    '\\int_0^1 x\\,dx',
    '$$',
    '',
    '| Left | Middle | Right |',
    '| :- | :-: | -: |',
    '| a | b<br>c | `d` |',
    '',
    '![Chart|240](attachments/' + HASH + '.png)',
    '',
    '> quote',
    '',
    '---',
    '',
    'End.',
    '',
  ].join('\n');

  it('round-trips everything from one note to another (Penmoss → Penmoss)', () => {
    expect(serializeMarkdown({ frontmatter: null, doc: parseMarkdown(NOTE).doc })).toBe(NOTE);
    const source = editorWith(NOTE);
    selectAll(source);
    const data = copy(source);
    expect(data.getData('text/html')).toContain('data-penmoss');

    const target = openEditor();
    paste(target, Object.fromEntries(data.data));
    expect(markdownOf(target)).toBe(NOTE);
  });

  it('writes standard HTML for rich-text apps and markdown as the plain text', () => {
    const source = editorWith(NOTE);
    selectAll(source);
    const data = copy(source);
    const html = data.getData('text/html');
    expect(html).toMatch(/<table><tbody><tr><th[^>]*>Left<\/th>/);
    expect(html).toContain(
      '<pre data-meta="title=&quot;a.ts&quot;"><code class="language-ts">const x = 1;</code></pre>',
    );
    expect(html).toContain(
      '<blockquote data-callout="warning" data-callout-title="Careful now" data-callout-fold="-"><p data-callout-heading=""><strong>Careful now</strong></p>',
    );
    expect(html).toContain('<mark>marked</mark>');
    expect(html).not.toMatch(/colgroup|min-width/);
    expect(data.getData('text/plain')).toBe(NOTE.trimEnd());
  });

  it('cuts in one transaction', () => {
    const source = editorWith('Keep this. Cut **this**.');
    const range = find(source, 'Cut ');
    select(source.editor.view, range.from, source.editor.state.doc.content.size - 1);
    const data = copy(source, 'cut');
    expect(data.getData('text/plain')).toBe('Cut **this**.');
    expect(markdownOf(source)).toBe('Keep this.\n');
  });

  it('copies words inside a heading as inline markdown, and code as code', () => {
    const source = editorWith('## A **big** title\n\n```js\nlet a = b * c;\n```');
    const words = find(source, 'big');
    select(source.editor.view, words.from - 2, words.to + 3);
    expect(copy(source).getData('text/plain')).toBe('A **big** ti');
    const code = find(source, 'b * c');
    select(source.editor.view, code.from, code.to);
    expect(copy(source).getData('text/plain')).toBe('b * c');
  });

  it('copies a list item from inside a list as its text', () => {
    const source = editorWith('- one\n- two\n- three');
    const two = find(source, 'two');
    select(source.editor.view, two.from, two.to);
    expect(copy(source).getData('text/plain')).toBe('two');
    select(source.editor.view, find(source, 'one').from, two.to);
    expect(copy(source).getData('text/plain')).toBe('- one\n- two');
  });

  it('copies part of an ordered list as an ordered list, numbered as shown', () => {
    const source = editorWith('3. three\n4. four\n5. five');
    select(source.editor.view, find(source, 'four').from, find(source, 'five').to);
    expect(copy(source).getData('text/plain')).toBe('4. four\n5. five');
    select(source.editor.view, find(source, 'three').from + 1, find(source, 'four').to);
    expect(copy(source).getData('text/plain')).toBe('3. hree\n4. four');
    // An item copied with the block after it keeps its number.
    const mixed = editorWith('1. a\n2. b\n\nAfter');
    select(mixed.editor.view, find(mixed, 'b').from, find(mixed, 'After').to);
    expect(copy(mixed).getData('text/plain')).toBe('2. b\n\nAfter');
  });

  it('copies part of a nested list as that list', () => {
    const source = editorWith('- a\n  1. x\n  2. y\n  3. z\n- b');
    select(source.editor.view, find(source, 'y').from, find(source, 'z').to);
    expect(copy(source).getData('text/plain')).toBe('2. y\n3. z');
    const tasks = editorWith('1. one\n   - [ ] p\n   - [x] q\n2. two');
    select(tasks.editor.view, find(tasks, 'p').from, find(tasks, 'q').to);
    expect(copy(tasks).getData('text/plain')).toBe('- [ ] p\n- [x] q');
    select(tasks.editor.view, find(tasks, 'one').from, find(tasks, 'two').to);
    expect(copy(tasks).getData('text/plain')).toBe('1. one\n   - [ ] p\n   - [x] q\n2. two');
  });

  it('pastes a partial ordered list copy between notes with its numbers', () => {
    const source = editorWith('1. a\n2. b\n3. c');
    select(source.editor.view, find(source, 'b').from, find(source, 'c').to);
    const target = openEditor();
    paste(target, Object.fromEntries(copy(source).data));
    expect(markdownOf(target)).toBe('2. b\n3. c\n');
  });

  it('copies cells from one table row as a table', () => {
    const source = editorWith('| A | B |\n| - | - |\n| 1 | 2 |\n| 3 | 4 |');
    const { view } = source.editor;
    const $a = view.state.doc.resolve(find(source, '1').from - 1);
    const $b = view.state.doc.resolve(find(source, '2').from - 1);
    view.dispatch(view.state.tr.setSelection(new CellSelection($a, $b)));
    expect(copy(source).getData('text/plain')).toBe('| 1 | 2 |\n| - | - |');
  });

  it('copies selected table cells as a table', () => {
    const source = editorWith('| A | B |\n| - | - |\n| 1 | 2 |\n| 3 | 4 |');
    const { view } = source.editor;
    const $a = view.state.doc.resolve(find(source, '1').from - 1);
    const $b = view.state.doc.resolve(find(source, '4').from - 1);
    view.dispatch(view.state.tr.setSelection(new CellSelection($a, $b)));
    expect(copy(source).getData('text/plain')).toBe('| 1 | 2 |\n| - | - |\n| 3 | 4 |');
  });
});

describe('Copy as Markdown and Copy as rich text', () => {
  const originals = { clipboard: Object.getOwnPropertyDescriptor(navigator, 'clipboard') };
  afterEach(() => {
    if (originals.clipboard) Object.defineProperty(navigator, 'clipboard', originals.clipboard);
    else Reflect.deleteProperty(navigator, 'clipboard');
    Reflect.deleteProperty(window, 'ClipboardItem');
  });

  function mockClipboard() {
    const writeText = vi.fn(() => Promise.resolve());
    const write = vi.fn((items: { items: Record<string, Blob> }[]) => {
      void items;
      return Promise.resolve();
    });
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText, write },
      configurable: true,
    });
    Object.defineProperty(window, 'ClipboardItem', {
      value: class {
        constructor(readonly items: Record<string, Blob>) {}
      },
      configurable: true,
    });
    return { writeText, write };
  }

  it('Mod-Shift-C copies the selection as markdown only', async () => {
    const { writeText, write } = mockClipboard();
    const onCopy = vi.fn();
    const source = editorWith('Some **bold** text', { clipboard: { onCopy } });
    selectAll(source);
    expect(press(source.editor.view, 'c', { shiftKey: true, ctrlKey: true })).toBe(true);
    await vi.waitFor(() => expect(onCopy).toHaveBeenCalledWith('markdown', true));
    expect(writeText).toHaveBeenCalledWith('Some **bold** text');
    expect(write).not.toHaveBeenCalled();
  });

  it('copies the whole note, with frontmatter, when nothing is selected', async () => {
    const { writeText } = mockClipboard();
    const source = editorWith('# Heading\n\nBody', {
      clipboard: { note: () => ({ id: '01JB7Q3V6M8K2T9RZ4XN5C1HPD', title: 'My note' }) },
    });
    select(source.editor.view, 3);
    source.editor.commands.copyAsMarkdown();
    await vi.waitFor(() => expect(writeText).toHaveBeenCalled());
    expect(writeText).toHaveBeenCalledWith(
      '---\nid: 01JB7Q3V6M8K2T9RZ4XN5C1HPD\ntitle: My note\n---\n\n# Heading\n\nBody\n',
    );
  });

  it('binds Copy as rich text by default on Apple platforms only (AltGr+Shift+C types Ć)', () => {
    const { write, writeText } = mockClipboard();
    const other = editorWith('x');
    selectAll(other);
    // With Shift held a browser reports the letter as "C", and its key code.
    const keys = { shiftKey: true, ctrlKey: true, altKey: true, keyCode: 67 };
    expect(press(other.editor.view, 'C', keys)).toBe(false);
    expect(write).not.toHaveBeenCalled();
    expect(writeText).not.toHaveBeenCalled();
    const platform = vi.spyOn(navigator, 'platform', 'get').mockReturnValue('MacIntel');
    const apple = editorWith('x');
    selectAll(apple);
    // prosemirror-keymap read the platform when it loaded (not Apple here), so Mod is Ctrl.
    expect(press(apple.editor.view, 'C', keys)).toBe(true);
    platform.mockRestore();
  });

  it('lists both commands, with their default keys, for the command registry (T20)', () => {
    expect(CLIPBOARD_COMMANDS.map(({ id, label, keys }) => ({ id, label, keys }))).toEqual([
      {
        id: 'copy-markdown',
        label: 'Copy as Markdown',
        keys: { apple: 'Mod-Shift-c', other: 'Mod-Shift-c' },
      },
      {
        id: 'copy-rich-text',
        label: 'Copy as Rich Text',
        keys: { apple: 'Mod-Alt-Shift-c', other: null },
      },
    ]);
    const collab = editorWith('Some **bold**');
    selectAll(collab);
    const { write } = mockClipboard();
    expect(CLIPBOARD_COMMANDS[1]!.run(collab.editor)).toBe(true);
    return vi.waitFor(() => expect(write).toHaveBeenCalled());
  });

  it('Copy as rich text writes HTML with readable plain text', async () => {
    const { write } = mockClipboard();
    const source = editorWith('- [x] **Done** with $x$');
    selectAll(source);
    source.editor.commands.copyAsRichText();
    await vi.waitFor(() => expect(write).toHaveBeenCalled());
    const items = (write.mock.calls[0]![0] as unknown as { items: Record<string, Blob> }[])[0]!
      .items;
    expect(await items['text/plain']!.text()).toBe('Done with $x$');
    expect(await items['text/html']!.text()).toContain('<strong>Done</strong>');
  });
});

describe('schema round trip through HTML', () => {
  it('keeps core attributes TipTap does not render (tight, align, meta)', () => {
    const doc = parseMarkdown('- a\n\n- b\n\n| x |\n| -: |\n| y |\n\n```py meta\nz\n```\n').doc;
    const source = openEditor((doc.toJSON() as { content: JSONContent[] }).content);
    selectAll(source);
    const target = openEditor();
    paste(target, Object.fromEntries(copy(source).data));
    const pasted = coreSchema.nodeFromJSON(target.editor.getJSON());
    expect(pasted.child(0).attrs['tight']).toBe(false);
    expect(pasted.child(1).child(0).child(0).attrs['align']).toBe('right');
    expect(pasted.child(2).attrs).toEqual({ language: 'py', meta: 'meta' });
    expect(serializeMarkdown({ frontmatter: null, doc: pasted })).toBe(
      serializeMarkdown({ frontmatter: null, doc }),
    );
  });
});
