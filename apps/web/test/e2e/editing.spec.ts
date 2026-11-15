import { expect, type Page, test } from './fixtures';
import { LINE_END, NEW_NOTE } from './keys';
import { body, collectErrors, newNote, ULID } from './support/app';

// T14: the slash menu, markdown shortcuts, selection toolbar and block moves,
// driven from the keyboard (and the mouse for the drag handle) in a real note.

const TAG = `e${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** A 1×1 PNG, enough for the image path (the server checks the magic number, A31). */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

const menu = (page: Page) => page.getByRole('listbox', { name: 'Insert block' });

/** Creates a note from the keyboard (⌘⌥N, or Alt+N off a Mac), titles it, and leaves the caret in its body. */
async function newNoteByKeyboard(page: Page, title: string) {
  await expect(
    page.getByTestId('sidebar-shortcuts').getByRole('button', { name: 'New Note', exact: true }),
  ).toBeVisible();
  await page.keyboard.press(NEW_NOTE);
  await expect(page).toHaveURL(ULID);
  await expect(page.getByTestId('note-title')).toBeFocused();
  await page.keyboard.type(title);
  await page.keyboard.press('Enter');
  await expect(body(page)).toBeFocused();
}

/** Types `/query`, checks the menu offers `option` first, and inserts it with Enter. */
async function slash(page: Page, query: string, option: string) {
  await page.keyboard.type(`/${query}`);
  await expect(menu(page)).toBeVisible();
  await expect(menu(page).getByRole('option').first()).toHaveText(new RegExp(option));
  await expect(menu(page).getByRole('option', { selected: true })).toHaveText(new RegExp(option));
  await page.keyboard.press('Enter');
  await expect(menu(page)).toBeHidden();
}

test('T14: a note built with only the keyboard, through the slash menu and shortcuts', async ({
  page,
}) => {
  test.setTimeout(90_000);
  const errors = collectErrors(page);
  await page.goto('/');
  await newNoteByKeyboard(page, `Keyboard ${TAG}`);
  const editor = body(page);
  const type = (text: string) => page.keyboard.type(text);
  const press = (key: string, times = 1) =>
    (async () => {
      for (let i = 0; i < times; i += 1) await page.keyboard.press(key);
    })();

  // The menu is a listbox the editor points at; arrows move, Esc closes and keeps the text.
  await type('/');
  await expect(menu(page)).toBeVisible();
  // The editor (a textbox) controls the listbox; aria-expanded is not allowed on a textbox.
  await expect(editor).toHaveAttribute('aria-controls', (await menu(page).getAttribute('id'))!);
  await expect(editor).not.toHaveAttribute('aria-expanded', /.*/);
  const first = menu(page).getByRole('option').first();
  await expect(editor).toHaveAttribute('aria-activedescendant', (await first.getAttribute('id'))!);
  await press('ArrowDown');
  await expect(menu(page).getByRole('option', { selected: true })).toHaveText(/Heading 1/);
  await type('zz');
  await expect(page.getByText('No blocks match “zz”')).toBeVisible();
  await press('Escape');
  await expect(menu(page)).toBeHidden();
  await expect(editor).not.toHaveAttribute('aria-activedescendant', /.+/);
  await press('Backspace', 3);

  await slash(page, 'h1', 'Heading 1');
  await type('Trip plan');
  await press('Enter');
  await type('Packing for the weekend.');
  await press('Enter');
  await slash(page, 'heading 2', 'Heading 2');
  await type('Lists');
  await press('Enter');
  await slash(page, 'bullet', 'Bulleted List');
  await type('Tent');
  await press('Enter');
  await type('Stove');
  await press('Enter', 2);
  await slash(page, 'numbered', 'Numbered List');
  await type('Drive');
  await press('Enter');
  await type('Hike');
  await press('Enter', 2);
  await slash(page, 'checklist', 'Checklist');
  await type('Book the site');
  await press('Enter', 2);
  await slash(page, 'quote', 'Quote');
  await type('Leave no trace.');
  await press('Enter', 2);
  await slash(page, 'h3', 'Heading 3');
  await type('Details');
  await press('Enter');
  await slash(page, 'divider', 'Divider');
  await slash(page, 'code', 'Code Block');
  await type('echo packed');
  await press('Enter', 3);
  await slash(page, 'table', 'Table');
  await type('Day');
  await press('Tab');
  await type('Plan');
  await press('Tab');
  await type('Sat');
  await press('Tab');
  await type('Hike');
  await press('ArrowDown');
  await slash(page, 'warn', 'Warning Callout');
  await type('Bring water.');
  await press('Enter', 2);
  await slash(page, 'callout', 'Callout');
  await type('Plain note.');
  await press('Enter', 2);
  await slash(page, 'toggle', 'Toggle');
  await expect(page.getByRole('textbox', { name: 'Callout title' }).last()).toBeFocused();
  await type('Gear list');
  await press('Enter');
  await type('Headlamp');
  await press('Enter', 2);
  await slash(page, 'mermaid', 'Diagram: Mermaid');
  await type('graph TD\n  A[Pack] --> B[Go]');
  await expect(editor.locator('.pm-diagram-output svg')).toBeVisible({ timeout: 15_000 });
  await press('Enter', 3);
  await slash(page, 'math block', 'Math Block');
  await expect(page.getByRole('textbox', { name: 'Formula (LaTeX)' })).toBeFocused();
  await type('E = mc^2');
  await press('ControlOrMeta+Enter');
  await expect(editor.locator('.pm-math-block .katex-display')).toBeVisible();
  await type('Area ');
  await slash(page, 'inline math', 'Inline Math');
  await expect(page.getByRole('textbox', { name: 'Inline formula (LaTeX)' })).toBeFocused();
  await type('\\pi r^2');
  await press('Enter');
  await type(' of the tarp.');
  await press('Enter');

  // An image, through the file picker and the T10 image services.
  const chooser = page.waitForEvent('filechooser');
  await slash(page, 'image', 'Image');
  await (await chooser).setFiles({ name: 'map.png', mimeType: 'image/png', buffer: PNG });
  await expect(editor.locator('.pm-image[data-state="ready"]')).toBeVisible();
  await press(LINE_END);
  await press('Enter');

  // Markdown shortcuts, block and inline.
  await type('## By shortcut');
  await press('Enter');
  await type('- [ ] typed task');
  await press('Enter', 2);
  await type('> [!tip] Typed callout');
  await press('Enter', 2);
  await type(
    'Marks: **bold** *italic* ~~gone~~ ==marked== `code` $x^2$ [site](https://penmoss.app) ',
  );
  await press('Enter');

  // The selection toolbar, from the keyboard: select a word, Alt+F10, arrows, Enter, Escape.
  await type('Format me');
  await press('Shift+ArrowLeft', 2);
  const toolbar = page.getByRole('toolbar', { name: 'Format selection' });
  await expect(toolbar).toBeVisible();
  await press('Alt+F10');
  await expect(toolbar.getByRole('button', { name: 'Bold' })).toBeFocused();
  await press('Enter');
  await expect(toolbar.getByRole('button', { name: 'Bold' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await press('ArrowRight');
  await expect(toolbar.getByRole('button', { name: 'Italic' })).toBeFocused();
  await press('End');
  await expect(toolbar.getByRole('button', { name: /^Turn into/i })).toBeFocused();
  await press('Enter');
  await expect(toolbar.getByRole('menu', { name: 'Turn Into' })).toBeVisible();
  await press('ArrowDown', 3);
  await expect(toolbar.getByRole('menuitemradio', { name: 'Heading 3' })).toBeFocused();
  await press('Enter');
  await expect(editor.locator('h3', { hasText: 'Format me' })).toBeVisible();
  await press('Escape');
  await expect(editor).toBeFocused();

  // Move that heading up past the paragraph above it, from the keyboard.
  await press('Alt+Shift+ArrowUp');

  await press('ControlOrMeta+Shift+KeyM');
  const source = page.getByTestId('note-markdown');
  await expect(source).toContainText(`title: Keyboard ${TAG}`);
  const expected = [
    '# Trip plan',
    'Packing for the weekend.',
    '## Lists',
    '- Tent\n- Stove',
    '1. Drive\n2. Hike',
    '- [ ] Book the site',
    '> Leave no trace.',
    '### Details',
    '---',
    '```\necho packed\n```',
    '| Day | Plan |\n| - | - |\n| Sat | Hike |',
    '> [!warning]\n> Bring water.',
    '> [!note]\n> Plain note.',
    '> [!note]- Gear list\n> Headlamp',
    '```mermaid\ngraph TD\n  A[Pack] --> B[Go]\n```',
    '$$\nE = mc^2\n$$',
    'Area $\\pi r^2$ of the tarp.',
    '## By shortcut',
    '- [ ] typed task',
    '> [!tip]\n> Typed callout',
    'Marks: **bold** *italic* ~~gone~~ ==marked== `code` $x^2$ [site](https://penmoss.app)',
    '### Format **me**\n\nMarks:',
  ];
  for (const text of expected) await expect(source).toContainText(text);
  await expect(source).toContainText(/!\[\]\(attachments\/[0-9a-f]{64}\.png\)/);
  expect(errors).toEqual([]);
});

/** The top-level blocks' text, in order. */
const blockTexts = (page: Page) =>
  body(page).evaluate((root) => [...root.children].map((child) => child.textContent ?? ''));

test('T14: dragging a block by its handle moves it, and one undo puts it back', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await page.goto('/');
  await newNoteByKeyboard(page, `Drag ${TAG}`);
  const editor = body(page);
  await page.keyboard.type('Alpha\nBravo\nCharlie\nDelta');
  await expect.poll(() => blockTexts(page)).toEqual(['Alpha', 'Bravo', 'Charlie', 'Delta']);

  // Hovering a block shows its handle beside it.
  const charlie = editor.locator('p', { hasText: 'Charlie' });
  await charlie.hover();
  const handle = page.getByRole('button', { name: 'Drag to Move Block' });
  await expect(handle).toBeVisible();
  const handleBox = (await handle.boundingBox())!;
  const charlieBox = (await charlie.boundingBox())!;
  expect(
    Math.abs(handleBox.y + handleBox.height / 2 - (charlieBox.y + charlieBox.height / 2)),
  ).toBeLessThan(8);

  // Drag Charlie above Alpha: the drop line shows while dragging.
  const alphaBox = (await editor.locator('p', { hasText: 'Alpha' }).boundingBox())!;
  await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(handleBox.x + 4, alphaBox.y + 10, { steps: 6 });
  await page.mouse.move(handleBox.x + 4, alphaBox.y + 2, { steps: 2 });
  await expect(page.locator('.pm-drop-indicator')).toBeVisible();
  await expect(charlie).toHaveClass(/pm-block-dragging/);
  await page.mouse.up();
  await expect(page.locator('.pm-drop-indicator')).toBeHidden();
  await expect.poll(() => blockTexts(page)).toEqual(['Charlie', 'Alpha', 'Bravo', 'Delta']);

  // Drag Alpha to the end.
  await editor.locator('p', { hasText: 'Alpha' }).hover();
  const box = (await handle.boundingBox())!;
  const deltaBox = (await editor.locator('p', { hasText: 'Delta' }).boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + 4, deltaBox.y + deltaBox.height, { steps: 8 });
  await page.mouse.up();
  await expect.poll(() => blockTexts(page)).toEqual(['Charlie', 'Bravo', 'Delta', 'Alpha']);

  // Each move is one undo step; the typing before them is untouched.
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(() => blockTexts(page)).toEqual(['Charlie', 'Alpha', 'Bravo', 'Delta']);
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(() => blockTexts(page)).toEqual(['Alpha', 'Bravo', 'Charlie', 'Delta']);
  await page.keyboard.press('ControlOrMeta+Shift+z');
  await expect.poll(() => blockTexts(page)).toEqual(['Charlie', 'Alpha', 'Bravo', 'Delta']);

  // Esc cancels a drag.
  await editor.locator('p', { hasText: 'Bravo' }).hover();
  const bravoHandle = (await handle.boundingBox())!;
  await page.mouse.move(bravoHandle.x + 6, bravoHandle.y + 6);
  await page.mouse.down();
  await page.mouse.move(bravoHandle.x + 6, bravoHandle.y - 60, { steps: 5 });
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await expect.poll(() => blockTexts(page)).toEqual(['Charlie', 'Alpha', 'Bravo', 'Delta']);

  // The order is what the note stores.
  await page.keyboard.press('ControlOrMeta+Shift+KeyM');
  await expect(page.getByTestId('note-markdown')).toContainText(
    'Charlie\n\nAlpha\n\nBravo\n\nDelta',
  );
  expect(errors).toEqual([]);
});

const RUN = `h${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
// T53, item 11.
test('lists and quotes keep their place when the cursor leaves the body', async ({ page }) => {
  const errors = collectErrors(page);
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.goto('/');
  await newNote(page, `Steady text ${RUN}`, 'Intro');
  await page.keyboard.press('Enter');
  await page.keyboard.type('1. one');
  await page.keyboard.press('Enter');
  await page.keyboard.type('two');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await page.keyboard.type('> quoted');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await page.keyboard.type('end');
  const boxes = () =>
    page.locator('.note-body .ProseMirror > *').evaluateAll((blocks) =>
      blocks.map((block) => {
        const rect = block.getBoundingClientRect();
        return `${block.tagName} ${rect.top.toFixed(1)} ${rect.height.toFixed(1)}`;
      }),
    );
  const editing = await boxes();
  expect(editing.some((box) => box.startsWith('BLOCKQUOTE'))).toBe(true);
  await page.getByTestId('note-title').click();
  await expect(page.locator('.note-body .ProseMirror')).not.toHaveClass(/ProseMirror-focused/);
  expect(await boxes()).toEqual(editing);
  expect(errors).toEqual([]);
});

const SHOTS = process.env['PENMOSS_EVIDENCE'];

const section = (page: Page, name: string) =>
  page.getByTestId('source-section').and(page.getByRole('region', { name, exact: true }));

async function openNote(page: Page, title: string, notebook = 'Quanta'): Promise<void> {
  await section(page, notebook)
    .getByRole('tree', { name: 'Folders and notes' })
    .getByRole('link', { name: title, exact: true })
    .click();
  await expect(page).toHaveURL(ULID);
  await expect(page.getByTestId('note-title')).toHaveValue(title);
}

const noteViewBody = (page: Page) => page.getByTestId('note-view').locator('.ProseMirror');

/** Puts the caret at the start of the `index`th paragraph of the note body. */
async function caretAtStart(page: Page, selector: string, index = 0): Promise<void> {
  await noteViewBody(page).locator(selector).nth(index).click();
  await page.keyboard.press('Home');
}
test.describe('in Quanta, with notes of links, lists and headings', () => {
  test.use({
    seed: {
      name: 'Quanta',
      notes: [
        { title: 'Links', markdown: 'See the docs here.\n' },
        {
          title: 'Outline',
          markdown: '1. one\n   1. two\n      1. three\n         1. four\n2. five\n',
        },
        { title: 'Lists', markdown: '1. one\n2. two\n3. three\n' },
        { title: 'Heading', markdown: 'first line\n\nsecond line\n' },
      ],
    },
  });

  // Ryan’s feedback of 6 Nov 2026 (Quanta), item 4.
  test('numbered lists read as an outline, 1, A, i, a', async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto('/');
    await openNote(page, 'Outline');
    const types = await noteViewBody(page)
      .locator('ol')
      .evaluateAll((lists) => lists.map((list) => getComputedStyle(list).listStyleType));
    expect(types).toEqual(['decimal', 'upper-alpha', 'lower-roman', 'lower-alpha']);
    if (SHOTS)
      await page
        .getByTestId('note-view')
        .locator('.doc')
        .screenshot({ path: `${SHOTS}/outline.png` });
    expect(errors).toEqual([]);
  });
  // Ryan’s feedback of 6 Nov 2026 (Quanta), item 6.
  test('Backspace at the start of the first line joins it to the title', async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto('/');
    await openNote(page, 'Heading');
    const title = page.getByTestId('note-title');
    await caretAtStart(page, 'p', 0);
    await page.keyboard.press('Backspace');
    await expect(title).toHaveValue('Headingfirst line');
    await expect(title).toBeFocused();
    // The caret is at the join: typing goes there.
    await page.keyboard.type(' — ');
    await expect(title).toHaveValue('Heading — first line');
    await expect(noteViewBody(page).locator('p').first()).toHaveText('second line');
    // An empty first line just goes, and the caret lands at the title's end. Enter in the title
    // moves to the text: the next keys wait until it is there.
    await page.keyboard.press('Enter');
    await expect(page.locator('.note-body .ProseMirror')).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(noteViewBody(page).locator('p')).toHaveCount(2);
    // Onto the new empty first line by a click, as the first case: ArrowUp from the line below
    // left the caret off it at times, on Linux CI and on a busy Mac (A1235).
    await caretAtStart(page, 'p', 0);
    // The caret is on the new empty first line before Backspace.
    await expect
      .poll(() =>
        page.evaluate(() => {
          const node = getSelection()?.anchorNode;
          const first = document.querySelector('.note-body .ProseMirror > p');
          return Boolean(node && first && (node === first || first.contains(node)));
        }),
      )
      .toBe(true);
    await page.keyboard.press('Backspace');
    await expect(title).toHaveValue('Heading — first line');
    await expect(title).toBeFocused();
    await expect(noteViewBody(page).locator('p').first()).toHaveText('second line');
    expect(errors).toEqual([]);
  });
  // Ryan’s feedback of 6 Nov 2026 (Quanta), item 7.
  test('Backspace twice at a numbered item keeps the items below in the same list', async ({
    page,
  }) => {
    const errors = collectErrors(page);
    await page.goto('/');
    await openNote(page, 'Lists');
    await caretAtStart(page, 'li p', 1);
    await page.keyboard.press('Backspace');
    await expect(noteViewBody(page).locator('ol')).toHaveCount(2);
    await page.keyboard.press('Backspace');
    await expect(noteViewBody(page).locator('ol')).toHaveCount(1);
    await expect(noteViewBody(page).locator('ol > li')).toHaveText(['onetwo', 'three']);
    expect(errors).toEqual([]);
  });
});

const LONG = Array.from({ length: 80 }, (_, n) => `Line ${n + 1} of a long note.`).join('\n\n');
test.describe('in Quanta, with a folder, a long note and a source', () => {
  test.use({
    seed: {
      name: 'Quanta',
      folders: ['Miscellaneous'],
      notes: [
        { title: 'Penmoss Roadmap', markdown: 'Plans for Penmoss.\n' },
        { title: 'Long', markdown: `${LONG}\n` },
        { title: 'Source', markdown: '## Plan\n\nFirst line.\n' },
      ],
    },
  });

  // T66, item 4.
  test('the markdown source’s body is edited in place; its frontmatter is not', async ({
    page,
  }) => {
    const errors = collectErrors(page);
    await page.goto('/');
    await openNote(page, 'Source');
    await page.keyboard.press('ControlOrMeta+Shift+KeyM');
    const source = page.getByTestId('note-markdown');
    await expect(source).toContainText('title: Source');
    const front = page.getByTestId('note-markdown-frontmatter');
    const body = page.getByTestId('note-markdown-body');
    await expect(front).toContainText('title: Source');
    await expect(front).not.toHaveAttribute('contenteditable', /true|plaintext-only/);
    await expect(body).toHaveAttribute('contenteditable', 'plaintext-only');
    await expect(body).toHaveText('## Plan\n\nFirst line.\n');

    // Typed at the body's end: a new paragraph with bold text, applied after a pause.
    await body.click();
    await body.evaluate((element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      range.collapse(false);
      getSelection()!.removeAllRanges();
      getSelection()!.addRange(range);
    });
    await page.keyboard.type('\n\nSecond **bold** line.');
    await expect(body).toContainText('Second **bold** line.');
    // Back in the editor, the note has it.
    await page.keyboard.press('ControlOrMeta+Shift+KeyM');
    const editor = page.locator('.note-body .ProseMirror');
    await expect(editor.locator('p strong')).toHaveText('bold');
    await expect(editor.locator('p').last()).toHaveText('Second bold line.');
    await expect(editor.locator('h2')).toHaveText('Plan');

    // Edited again and left by a click elsewhere: applied at once.
    await page.keyboard.press('ControlOrMeta+Shift+KeyM');
    await body.click();
    // The caret at the start (⌘↑ on a Mac, Ctrl+Home elsewhere): set directly.
    await body.evaluate((element) => {
      const range = document.createRange();
      range.setStart(element.firstChild!, 0);
      range.collapse(true);
      getSelection()!.removeAllRanges();
      getSelection()!.addRange(range);
    });
    await page.keyboard.type('# Top\n\n');
    await page.getByTestId('note-markdown-hint').click();
    await expect(body).toHaveText(/^# Top\n\n## Plan/);
    if (SHOTS) await page.locator('.note-source').screenshot({ path: `${SHOTS}/source.png` });
    await page.keyboard.press('ControlOrMeta+Shift+KeyM');
    await expect(editor.locator('h1')).toHaveText('Top');
    // The title stays the note's own: the frontmatter was not touched.
    await expect(page.getByTestId('note-title')).toHaveValue('Source');
    expect(errors).toEqual([]);
  });
  // T66, item 7.
  test('every button of the selection toolbar is an icon', async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto('/');
    await openNote(page, 'Source');
    await page.locator('.note-body .ProseMirror p').first().click();
    await page.keyboard.press('End');
    await page.keyboard.press('Shift+Home');
    const toolbar = page.getByRole('toolbar', { name: 'Format selection' });
    await expect(toolbar).toBeVisible();
    const buttons = toolbar.locator('button:visible');
    const count = await buttons.count();
    expect(count).toBeGreaterThan(6);
    for (let index = 0; index < count; index += 1) {
      const button = buttons.nth(index);
      // An icon, and no words on the button itself: its name is its label.
      await expect(button.locator('svg').first()).toBeVisible();
      expect(((await button.innerText()) ?? '').replace(/[¶\s]/g, '')).toMatch(/^[A-Za-z0-9]?$/);
      await expect(button).toHaveAttribute('aria-label', /.+/);
    }
    if (SHOTS) await toolbar.screenshot({ path: `${SHOTS}/toolbar.png` });
    expect(errors).toEqual([]);
  });
});

const UNDO = 'ControlOrMeta+KeyZ';

const REDO = 'ControlOrMeta+Shift+KeyZ';

async function newNoteFromButtonAndEnter(page: Page, title: string, text = ''): Promise<string> {
  await page
    .getByRole('button', { name: /^New Note/ })
    .first()
    .click();
  await expect(page).toHaveURL(ULID);
  await expect(page.getByTestId('note-title')).toBeFocused();
  await page.keyboard.type(title);
  await page.keyboard.press('Enter');
  if (text) await page.keyboard.type(text);
  await expect(page.getByTestId('note-view')).toHaveAttribute('data-ready', 'true');
  return ULID.exec(new URL(page.url()).pathname)![1]!;
}

// T39 pass 2.
test('Undo and Redo in a new note: one Redo brings the words back, with no stray line', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await page.goto('/');
  await newNoteFromButtonAndEnter(page, `Undo ${RUN}`, 'First words');
  // A pause in typing ends an undo step.
  await page.waitForTimeout(800);
  await page.keyboard.type(' and more');
  await expect(body(page)).toHaveText('First words and more');

  await page.keyboard.press(UNDO);
  await expect(body(page)).toHaveText('First words');
  await page.keyboard.press(UNDO);
  await expect(body(page)).toHaveText('');
  await page.keyboard.press(REDO);
  await expect(body(page)).toHaveText('First words');
  await page.keyboard.press(REDO);
  await expect(body(page)).toHaveText('First words and more');
  // One paragraph, as typed: nothing was added around the steps.
  await expect(body(page).locator(':scope > *')).toHaveCount(1);
  expect(errors).toEqual([]);
});
