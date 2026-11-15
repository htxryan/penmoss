import { expect, test, type Page } from './fixtures';

// PEN-135 (A1360): ↓ on the title's last line goes to the start of the note's first line, and ↑
// on the first line comes back to the end of the title. And moving the caret between the title
// and the body moves no text, not by 1 px, on any frame: the unfocused editor contains its blocks
// (content-visibility, T31), which kept a nested list's inner margins inside it, so a list three
// levels deep was 2.4 px taller while the caret was in the title.

const LONG_TITLE =
  'A title long enough to wrap onto several lines in the column of the note at this width';

const NOTES = {
  Plain: [
    'First line of the note',
    'A second paragraph, long enough to wrap onto a second line in the column at the default ' +
      'width of the note, with more words and more words and more words still.',
    'Last line',
    '',
  ].join('\n\n'),
  [LONG_TITLE]: 'First line under a long title\n\nLast line\n',
  Wrapped:
    'A first line long enough to wrap onto a second line in the column at the default width ' +
    'of the note, with more words and more words.\n\nLast line\n',
  Nested: [
    'Intro',
    '- one\n  - two\n    - three',
    '1. a\n   1. b\n      1. c\n         1. d\n            1. e',
    '- [ ] task\n  - [ ] nested task\n    - [ ] deeper task',
    '> > > > > five quotes deep',
    '> a quote\n>\n> - with a list\n>   - nested\n>\n> ```\n> code\n> ```',
    '## A heading',
    '- item\n\n  ```\n  code in a list\n  ```',
    'Last line',
    '',
  ].join('\n\n'),
};

test.use({
  seed: {
    name: 'Caret',
    notes: Object.entries(NOTES).map(([title, markdown]) => ({ title, markdown })),
  },
});

const title = (page: Page) => page.getByTestId('note-title');
const body = (page: Page) => page.getByTestId('note-body').locator('.ProseMirror');

async function openNote(page: Page, name: string): Promise<void> {
  await page.goto('/');
  await page.getByTestId('note-list').getByRole('link', { name, exact: true }).click();
  await expect(title(page)).toHaveValue(name);
  await expect(body(page)).toContainText('Last line');
}

/** Puts the title's caret at `at` (the end when left out). */
async function titleCaret(page: Page, at?: number): Promise<void> {
  await title(page).evaluate((field: HTMLTextAreaElement, offset) => {
    field.focus();
    const to = offset ?? field.value.length;
    field.setSelectionRange(to, to);
  }, at);
}

const titleSelection = (page: Page) =>
  title(page).evaluate((field: HTMLTextAreaElement) => [field.selectionStart, field.selectionEnd]);

test('↓ in the title goes to the start of the note’s first line', async ({ page }) => {
  await openNote(page, 'Plain');
  await titleCaret(page, 2);
  await page.keyboard.press('ArrowDown');
  await expect(body(page)).toBeFocused();
  await page.keyboard.type('>');
  await expect(body(page).locator('p').first()).toHaveText('>First line of the note');
  await expect(title(page)).toHaveValue('Plain');
});

test('↓ in a wrapped title moves down its lines first, then to the note', async ({ page }) => {
  await openNote(page, LONG_TITLE);
  const lines = await title(page).evaluate((field) => {
    const style = getComputedStyle(field);
    return Math.round(
      (field.clientHeight - parseFloat(style.paddingBottom)) / parseFloat(style.lineHeight),
    );
  });
  expect(lines).toBeGreaterThanOrEqual(2);
  // From the first line, each ↓ but the last stays in the title, a line further down.
  await titleCaret(page, 0);
  let before = 0;
  for (let line = 1; line < lines; line++) {
    await page.keyboard.press('ArrowDown');
    await expect(title(page)).toBeFocused();
    const [start] = await titleSelection(page);
    expect(start).toBeGreaterThan(before);
    before = start!;
  }
  // On the last line, ↓ goes to the start of the note.
  await page.keyboard.press('ArrowDown');
  await expect(body(page)).toBeFocused();
  await page.keyboard.type('>');
  await expect(body(page).locator('p').first()).toHaveText('>First line under a long title');
  await expect(title(page)).toHaveValue(LONG_TITLE);
});

test('Shift+↓ in the title selects in the title, and leaves the caret there', async ({ page }) => {
  await openNote(page, 'Plain');
  await titleCaret(page, 0);
  await page.keyboard.press('Shift+ArrowDown');
  await expect(title(page)).toBeFocused();
  expect(await titleSelection(page)).toEqual([0, 'Plain'.length]);
});

test('↑ on the note’s first line goes to the end of the title', async ({ page }) => {
  await openNote(page, 'Plain');
  await titleCaret(page);
  await page.keyboard.press('Enter');
  await expect(body(page)).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowUp');
  await expect(title(page)).toBeFocused();
  expect(await titleSelection(page)).toEqual(['Plain'.length, 'Plain'.length]);
  // And ↓ goes back down, to the start of the first line.
  await page.keyboard.press('ArrowDown');
  await expect(body(page)).toBeFocused();
  await page.keyboard.type('>');
  await expect(body(page).locator('p').first()).toHaveText('>First line of the note');
});

test('↑ on a wrapped first line’s second line stays in the note', async ({ page }) => {
  await openNote(page, 'Wrapped');
  const first = body(page).locator('p').first();
  // Two lines: taller than one line of 1.7 × 16 px. Waited for: until its first layout, the
  // unfocused editor's block has the height it is given ahead of it, one line (styles.css).
  await expect.poll(() => first.evaluate((p: HTMLElement) => p.offsetHeight)).toBeGreaterThan(40);
  /** Where the page's caret is: in the first paragraph's text, at which character. */
  const caret = () =>
    page.evaluate(() => {
      const selection = getSelection()!;
      const p = document.querySelector('[data-testid="note-body"] .ProseMirror > p');
      return p?.contains(selection.focusNode) ? selection.focusOffset : -1;
    });
  // To the start of the note, then down to the first paragraph's second line.
  await titleCaret(page);
  await page.keyboard.press('ArrowDown');
  await expect(body(page)).toBeFocused();
  await expect.poll(caret).toBe(0);
  await page.keyboard.press('ArrowDown');
  await expect.poll(caret).toBeGreaterThan(20);
  // ↑ goes up to the first line, in the note; one more goes to the title.
  await page.keyboard.press('ArrowUp');
  await expect(body(page)).toBeFocused();
  await expect.poll(caret).toBe(0);
  await page.keyboard.press('ArrowUp');
  await expect(title(page)).toBeFocused();
});

/**
 * Every line of text in the note and the title, and every block, where it is now; then, for 30
 * frames after `act`, each one that is anywhere else.
 */
async function moves(page: Page, act: () => Promise<void>): Promise<string[]> {
  await page.evaluate(() => {
    const where = () => {
      const scroll = document.querySelector('[data-testid="note-scroll"]')!;
      const found = new Map<Node, string>();
      const walker = document.createTreeWalker(scroll, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (node.parentElement?.closest('.pm-drag-handle, .pm-table-toolbar')) continue;
        const range = document.createRange();
        range.selectNodeContents(node);
        const lines = Array.from(range.getClientRects(), (r) => `${r.left},${r.top},${r.width}`);
        found.set(node, lines.join(' '));
      }
      for (const block of document.querySelectorAll('.note-body .ProseMirror > *')) {
        const r = block.getBoundingClientRect();
        found.set(block, `${r.left},${r.top},${r.width},${r.height}`);
      }
      const field = document.querySelector('[data-testid="note-title"]')!;
      const r = field.getBoundingClientRect();
      found.set(field, `${r.left},${r.top},${r.width},${r.height},${field.scrollTop}`);
      found.set(scroll, `${scroll.scrollTop},${scroll.clientWidth}`);
      return found;
    };
    const before = where();
    const seen: string[] = [];
    (window as unknown as { __moves: string[] }).__moves = seen;
    let frame = 0;
    const check = () => {
      for (const [node, now] of where()) {
        const was = before.get(node);
        if (was !== now) {
          const name = node.nodeType === Node.TEXT_NODE ? node.textContent : node.nodeName;
          seen.push(`frame ${frame}: ${JSON.stringify(name?.slice(0, 30))} ${was} → ${now}`);
        }
      }
      if (++frame < 30) requestAnimationFrame(check);
      else seen.push('done');
    };
    requestAnimationFrame(check);
  });
  await act();
  const seen = () =>
    page.evaluate(() => (window as unknown as { __moves: string[] }).__moves.slice());
  await expect.poll(async () => (await seen()).includes('done')).toBe(true);
  return (await seen()).filter((line) => line !== 'done');
}

test('moving the caret between the title and the note moves no text', async ({ page }) => {
  // Tall enough for the whole note: a click below the fold would scroll it.
  await page.setViewportSize({ width: 1280, height: 1400 });
  await openNote(page, 'Nested');
  await titleCaret(page);
  // Settled in the title.
  await page.evaluate(() => new Promise((done) => setTimeout(done, 300)));
  expect(await moves(page, () => page.keyboard.press('ArrowDown'))).toEqual([]);
  await expect(body(page)).toBeFocused();
  expect(await moves(page, () => page.keyboard.press('ArrowUp'))).toEqual([]);
  await expect(title(page)).toBeFocused();
  expect(await moves(page, () => page.keyboard.press('Enter'))).toEqual([]);
  await expect(body(page)).toBeFocused();
  // By the mouse: a click on the title, then on the last line.
  expect(await moves(page, () => title(page).click())).toEqual([]);
  await expect(title(page)).toBeFocused();
  expect(await moves(page, () => body(page).getByText('Last line').click())).toEqual([]);
  await expect(body(page)).toBeFocused();
});
