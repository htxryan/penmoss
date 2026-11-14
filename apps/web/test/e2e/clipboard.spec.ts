import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, macContext, PREVIEW, test, type Page } from './fixtures';
import { DOC_END, LINE_END } from './keys';
import { noteAction } from './note-menu';

// T15: copy and paste through the real clipboard in Chromium (clipboard permissions
// granted): Penmoss → Penmoss, Copy as Markdown, paste and match style, pasted HTML
// from other apps, VS Code, pictures in HTML, and the title field.

test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

const ULID = /\/notes\/([0-9A-HJKMNP-TV-Z]{26})$/;
const TAG = `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const FIXTURES = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../packages/editor/test/clipboard-fixtures',
);
const fixture = (name: string) => readFileSync(join(FIXTURES, name), 'utf8');

/**
 * Paste and match style, as a user does it. Chromium maps Ctrl+Shift+V itself; on a Mac the
 * shortcut is Chrome's Edit menu item (⌥⇧⌘V), and the headless browser has no menu. So there
 * the key goes with the editing command the menu runs, as Playwright sends ⌘V with `paste`.
 */
async function pasteAndMatchStyle(page: Page) {
  if (process.platform !== 'darwin') {
    await page.keyboard.press('Control+Shift+v');
    return;
  }
  const cdp = await page.context().newCDPSession(page);
  // Alt (1), Meta (4) and Shift (8).
  const key = { key: 'v', code: 'KeyV', windowsVirtualKeyCode: 86, modifiers: 1 | 4 | 8 };
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'rawKeyDown',
    ...key,
    commands: ['pasteAndMatchStyle'],
  });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...key });
  await cdp.detach();
}

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(error.message));
  return errors;
}

const body = (page: Page) => page.getByTestId('note-body').locator('.ProseMirror');

async function newNote(page: Page, title: string): Promise<string> {
  await page
    .getByTestId('sidebar-shortcuts')
    .getByRole('button', { name: 'New Note', exact: true })
    .click();
  await expect(page).toHaveURL(ULID);
  await expect(page.getByTestId('note-title')).toBeFocused();
  await page.keyboard.type(title);
  await page.keyboard.press('Enter');
  await expect(body(page)).toBeFocused();
  return ULID.exec(new URL(page.url()).pathname)![1]!;
}

/** Puts entries on the system clipboard (as another app would). */
async function writeClipboard(page: Page, entries: Record<string, string>): Promise<void> {
  await page.evaluate(async (items) => {
    const blobs = Object.fromEntries(
      Object.entries(items).map(([type, value]) => [type, new Blob([value], { type })]),
    );
    await navigator.clipboard.write([new ClipboardItem(blobs)]);
  }, entries);
}

/** What is on the system clipboard, by type. */
async function readClipboard(page: Page): Promise<Record<string, string>> {
  return page.evaluate(async () => {
    const out: Record<string, string> = {};
    for (const item of await navigator.clipboard.read()) {
      for (const type of item.types) out[type] = await (await item.getType(type)).text();
    }
    return out;
  });
}

/** The open note's body as stored markdown (the source view, without frontmatter). */
async function bodyMarkdown(page: Page): Promise<string> {
  await noteAction(page, 'toggle-markdown');
  const source = page.getByTestId('note-markdown');
  await expect(source).toContainText('---');
  const text = (await source.textContent()) ?? '';
  await noteAction(page, 'toggle-markdown');
  return text.replace(/^---\n[\s\S]*?\n---\n\n?/, '');
}

const NOTE = [
  '## Plan',
  '',
  'Some **bold**, ==marked== and `code` with $e^{i\\pi}$ and [a link](https://example.com).',
  '',
  '- [x] Done',
  '- [ ] Todo',
  '',
  '> [!warning] Careful',
  '> Hot **stove**.',
  '',
  '```ts',
  'const x = 1;',
  '```',
  '',
  '$$',
  'x^2',
  '$$',
  '',
  '| Left | Right |',
  '| :- | -: |',
  '| a | `b` |',
  '',
].join('\n');

test('T15: markdown pasted into one note copies into another with every block kept', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await page.goto('/');
  await newNote(page, `Source ${TAG}`);

  // Markdown text from a plain-text app is parsed by the core codec.
  await writeClipboard(page, { 'text/plain': NOTE });
  await page.keyboard.press('ControlOrMeta+v');
  await expect(body(page).locator('table')).toHaveCount(1);
  await expect(body(page).locator('.katex').first()).toBeVisible();
  expect(await bodyMarkdown(page)).toBe(NOTE);

  // Copy everything: HTML for rich-text apps, markdown as the plain text.
  await body(page).click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.press('ControlOrMeta+c');
  const copied = await readClipboard(page);
  expect(copied['text/plain']).toBe(NOTE.trimEnd());
  expect(copied['text/html']).toContain('<table><tbody><tr><th');
  expect(copied['text/html']).toContain('<pre><code class="language-ts">');

  await newNote(page, `Target ${TAG}`);
  await page.keyboard.press('ControlOrMeta+v');
  await expect(body(page).locator('table')).toHaveCount(1);
  expect(await bodyMarkdown(page)).toBe(NOTE);
  expect(errors).toEqual([]);
});

test('T15: Copy as Markdown and Copy as rich text force one format', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/');
  await newNote(page, `Copy as ${TAG}`);
  await writeClipboard(page, { 'text/plain': '## Title\n\nSome **bold** words.' });
  await page.keyboard.press('ControlOrMeta+v');
  await expect(body(page).locator('h2')).toHaveText('Title');

  // Shortcut on a selection: markdown only.
  await body(page).locator('p').selectText();
  // Let the selection reach the editor (A43): its toolbar shows once it has. A fixed 50 ms was
  // not always enough on a loaded machine, and the shortcut then copied the whole note.
  await expect(page.getByTestId('selection-toolbar')).toBeVisible();
  await page.keyboard.press('ControlOrMeta+Shift+KeyC');
  await expect(page.getByTestId('copy-status')).toHaveText('Copied as Markdown');
  expect(await readClipboard(page)).toEqual({ 'text/plain': 'Some **bold** words.' });

  // The selection toolbar's menu: rich text.
  await page.getByRole('button', { name: 'Copy As' }).click();
  await page.getByRole('menuitem', { name: /Copy as Rich Text/ }).click();
  await expect(page.getByTestId('copy-status')).toHaveText('Copied as rich text');
  const rich = await readClipboard(page);
  expect(rich['text/plain']).toBe('Some bold words.');
  expect(rich['text/html']).toContain('<strong>bold</strong>');

  // The top bar's ⋯ menu (A575): the whole note, with its frontmatter.
  await page.getByTestId('note-menu').click();
  await page.getByRole('menuitem', { name: 'Copy Note as Markdown' }).click();
  await expect(page.getByTestId('copy-status')).toHaveText('Copied as Markdown');
  const whole = (await readClipboard(page))['text/plain'] ?? '';
  expect(whole).toMatch(new RegExp(`^---\\nid: [0-9A-Z]{26}\\ntitle: Copy as ${TAG}\\n`));
  expect(whole).toContain('---\n\n## Title\n\nSome **bold** words.\n');
  expect(errors).toEqual([]);
});

test('T15: paste and match style inserts plain text styled like its surroundings', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await page.goto('/');
  await newNote(page, `Plain ${TAG}`);
  await page.keyboard.type('Make it **bold here** please');
  await expect(body(page).locator('strong')).toHaveText('bold here');

  await writeClipboard(page, {
    'text/html': '<h1>Heading</h1><p><em>styled</em> <a href="https://x.example">link</a></p>',
    'text/plain': '# **shout** https://x.example ',
  });
  // Caret between "bold " and "here", inside the bold text.
  await body(page).locator('strong').click();
  await page.keyboard.press(LINE_END);
  for (let i = 0; i < 'here please'.length; i++) await page.keyboard.press('ArrowLeft');
  await page.waitForTimeout(50);
  await pasteAndMatchStyle(page);
  await expect(body(page).locator('strong')).toHaveText('bold # **shout** https://x.example here');
  await expect(body(page).locator('h1, em, a')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('T15: HTML from Google Docs, VS Code and a page with pictures pastes as clean blocks', async ({
  page,
}) => {
  const errors = collectErrors(page);
  // Pasting never makes the browser fetch a picture from another site.
  const remote: string[] = [];
  page.on('request', (request) => {
    if (/img\.example|shields\.io/.test(request.url())) remote.push(request.url());
  });
  await page.goto('/');
  await newNote(page, `Pasted ${TAG}`);

  await writeClipboard(page, {
    'text/html': fixture('google-docs.html'),
    'text/plain': 'Trip planning',
  });
  await page.keyboard.press('ControlOrMeta+v');
  await expect(body(page).locator('table')).toHaveCount(1);
  expect(await bodyMarkdown(page)).toBe(fixture('google-docs.expected.md'));
  // Nothing from the source's styles reaches the note (TipTap's checkbox labels are its own).
  await expect(
    body(page).locator('p[style], li[style], h1[style], td[style], span[style]:not(label span)'),
  ).toHaveCount(0);

  // VS Code: its own clipboard entry names the language (a synthetic event: the async
  // clipboard API cannot write custom types).
  await body(page).press(DOC_END);
  await page.evaluate(
    (entries) => {
      const transfer = new DataTransfer();
      for (const [type, value] of Object.entries(entries)) transfer.setData(type, value);
      document
        .querySelector('[data-testid="note-body"] .ProseMirror')!
        .dispatchEvent(
          new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }),
        );
    },
    {
      'text/plain': fixture('vscode.txt'),
      'text/html': fixture('vscode.html'),
      'vscode-editor-data': fixture('vscode.vscode-editor-data.json'),
    },
  );
  const code = body(page).locator('.pm-code-block').last();
  await expect(code.getByRole('combobox', { name: 'Code block language' })).toHaveValue('ts');
  await expect(code.locator('code')).toContainText('return `Hello, ${name}`;');

  // A picture inside HTML is stored on this device (T10) and shown from it.
  const png = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 40;
    canvas.height = 20;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#3f7d4e';
    ctx.fillRect(0, 0, 40, 20);
    return canvas.toDataURL('image/png');
  });
  // Out of the code block (a paste inside it would be plain text).
  await body(page).press(DOC_END);
  await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(50);
  await writeClipboard(page, {
    'text/html': `<p>Chart <img src="${png}" alt="Green bar"> and <img src="https://img.example/remote.png" alt="Remote"></p>`,
    'text/plain': 'Chart and',
  });
  await page.keyboard.press('ControlOrMeta+v');
  const image = body(page).getByTestId('image');
  await expect(image).toHaveAttribute('data-state', 'ready');
  await expect(image.locator('img')).toHaveAttribute('src', /^blob:/);
  const markdown = await bodyMarkdown(page);
  expect(markdown).toMatch(
    /Chart !\[Green bar\]\(attachments\/[0-9a-f]{64}\.png\) and \[Remote\]\(https:\/\/img\.example\/remote\.png\)\n$/,
  );

  // Markdown with badges (a README): links to the pictures, nothing fetched.
  await body(page).press(DOC_END);
  await page.keyboard.press('Enter');
  await writeClipboard(page, {
    'text/plain':
      '## Read me\n\n![build](https://img.shields.io/badge/build-passing-green.svg) [x](javascript:alert(1))',
  });
  await page.keyboard.press('ControlOrMeta+v');
  await expect(body(page).locator('h2', { hasText: 'Read me' })).toHaveCount(1);
  expect(await bodyMarkdown(page)).toMatch(
    /## Read me\n\n\[build\]\(https:\/\/img\.shields\.io\/badge\/build-passing-green\.svg\) x\n$/,
  );
  await expect(body(page).locator('img[src^="http"]')).toHaveCount(0);
  expect(remote).toEqual([]);
  expect(errors).toEqual([]);
});

test('T15: pasting into the title or a table cell keeps their structure', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/');
  await newNote(page, `Cells ${TAG}`);
  await page.keyboard.type('| A | B |');
  await page.keyboard.press('Enter');
  await expect(body(page).locator('table')).toHaveCount(1);

  // The caret is in the first body cell: blocks become one line there.
  await writeClipboard(page, {
    'text/html': '<h2>Head</h2><ul><li>one</li><li><b>two</b></li></ul>',
    'text/plain': 'Head\none\ntwo',
  });
  await page.keyboard.press('ControlOrMeta+v');
  await expect(body(page).locator('table tr')).toHaveCount(2);
  await expect(body(page).locator('table td').first()).toHaveText('Headonetwo');
  expect(await bodyMarkdown(page)).toBe('| A | B |\n| - | - |\n| Head<br>one<br>**two** | |\n');

  // The title takes one line of text.
  const title = page.getByTestId('note-title');
  await title.click();
  await page.keyboard.press(LINE_END);
  await writeClipboard(page, {
    'text/html': '<h1>Second</h1><p>line <b>bold</b></p>',
    'text/plain': ' Second\nline bold',
  });
  await page.keyboard.press('ControlOrMeta+v');
  await expect(title).toHaveValue(`Cells ${TAG} Second line bold`);
  // The paste is one step of the field's own undo.
  await page.keyboard.press('ControlOrMeta+z');
  await expect(title).toHaveValue(`Cells ${TAG}`);
  await page.keyboard.press('ControlOrMeta+Shift+z');
  await expect(title).toHaveValue(`Cells ${TAG} Second line bold`);
  await expect(body(page).locator('table')).toHaveCount(1);
  await expect(body(page).locator('h1')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('T15: under the production CSP, a blob: picture in pasted HTML is stored as it is', async ({
  browser,
  host,
}) => {
  test.setTimeout(120_000);
  // The production build (vite preview) sends the app host's Content Security Policy.
  const context = await macContext(browser, host, {
    baseURL: PREVIEW,
    permissions: ['clipboard-read', 'clipboard-write'],
  });
  try {
    const page = await context.newPage();
    const errors = collectErrors(page);
    await page.goto('/');
    await newNote(page, `Blob ${TAG}`);
    const blobUrl = await page.evaluate(async () => {
      const canvas = document.createElement('canvas');
      canvas.width = 30;
      canvas.height = 30;
      const ctx = canvas.getContext('2d')!;
      ctx.fillStyle = '#c0392b';
      ctx.fillRect(0, 0, 30, 30);
      const blob = await new Promise<Blob>((resolve) =>
        canvas.toBlob((made) => resolve(made!), 'image/jpeg'),
      );
      return URL.createObjectURL(blob);
    });
    await writeClipboard(page, {
      'text/html': `<p>Photo <img src="${blobUrl}" alt="Red"></p>`,
      'text/plain': 'Photo',
    });
    await page.keyboard.press('ControlOrMeta+v');
    await expect(body(page).getByTestId('image')).toHaveAttribute('data-state', 'ready');
    // A JPEG stays a JPEG (read as a file, not redrawn as a PNG), with no CSP violation.
    expect(await bodyMarkdown(page)).toMatch(
      /^Photo !\[Red\]\(attachments\/[0-9a-f]{64}\.jpg\)\n$/,
    );
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});

test('T52: Copy Agent Reference from the top bar, the ⋯ menu and the sidebar', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/');
  const title = `Reference ${TAG}`;
  const id = await newNote(page, title);
  // One line (PEN-69): the git notebook's local MCP server and read_note with the note's short
  // id, the notebook's 4 characters and the id's last 8 (core's agentReference, the same on every
  // client).
  const expected = new RegExp(
    `^Reference note via Penmoss MCP \\(penmoss mcp --notebook "[^"]+"\\) tool read_note \\{"id":"[0-9A-HJKMNP-TV-Z]{4}-${id.slice(-8)}"\\}$`,
  );
  await page.getByTestId('copy-agent-reference').click();
  await expect(page.getByTestId('copy-status')).toHaveText('Copied Agent Reference');
  expect((await readClipboard(page))['text/plain']).toMatch(expected);

  await writeClipboard(page, { 'text/plain': 'something else' });
  await page.getByTestId('note-menu').click();
  await page.getByRole('menuitem', { name: 'Copy Agent Reference' }).click();
  await expect(page.getByTestId('copy-status')).toHaveText('Copied Agent Reference');
  expect((await readClipboard(page))['text/plain']).toMatch(expected);

  await writeClipboard(page, { 'text/plain': 'something else' });
  const row = page.getByTestId('note-list').getByRole('treeitem', { name: title, exact: true });
  await row.click({ button: 'right' });
  await page
    .getByRole('menu', { name: `“${title}”` })
    .getByRole('menuitem', { name: 'Copy Agent Reference' })
    .click();
  await expect(page.getByTestId('tree-message')).toHaveText('Copied Agent Reference');
  expect((await readClipboard(page))['text/plain']).toMatch(expected);
  expect(errors).toEqual([]);
});
