import { expect, macContext, PREVIEW, test, type Page } from './fixtures';
import { LINE_END, LINE_START } from './keys';
import { noteAction } from './note-menu';

// Phase 2 blocks: code blocks (T9), tables, checklists, callouts and toggles (T11),
// Mermaid and math (T12), each created by typing in a real note.

const ULID = /\/notes\/([0-9A-HJKMNP-TV-Z]{26})$/;
const TAG = `b${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(error.message));
  return errors;
}

const body = (page: Page) => page.getByTestId('note-body').locator('.ProseMirror');

/** Creates a note with a title and leaves the caret in its empty body. */
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

test('T9: a TypeScript code block highlights with theme colours', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/');
  await newNote(page, `Code ${TAG}`);

  await page.keyboard.type('```ts');
  await page.keyboard.press('Enter');
  const block = body(page).locator('.pm-code-block');
  await expect(block).toHaveCount(1);
  await page.keyboard.type('const answer: number = 42; // the answer');
  await page.keyboard.press('Enter');
  // Tab indents inside code instead of leaving the editor.
  await page.keyboard.press('Tab');
  await page.keyboard.type('return answer;');

  const keyword = block.locator('.hljs-keyword').first();
  await expect(keyword).toHaveText('const');
  await expect(block.locator('.hljs-number')).toHaveText('42');
  await expect(block.locator('.hljs-comment')).toHaveText('// the answer');
  await expect(block.locator('code')).toContainText('\n  return answer;');

  // Colours come from the theme's tokens.
  const colours = await keyword.evaluate((element) => {
    const probe = document.createElement('span');
    probe.style.color = 'var(--pm-code-keyword)';
    document.body.append(probe);
    const expected = getComputedStyle(probe).color;
    probe.remove();
    return { actual: getComputedStyle(element).color, expected };
  });
  expect(colours.actual).toBe(colours.expected);

  await expect(block.getByRole('combobox', { name: 'Code block language' })).toHaveValue('ts');
  await block.getByRole('combobox', { name: 'Code block language' }).selectOption('python');
  await expect(block.locator('code')).toHaveClass(/language-python/);
  await expect(block.getByRole('button', { name: 'Copy Code' })).toBeVisible();
  expect(errors).toEqual([]);
});

test('T11: tables, checklists, callouts and toggles by shortcut, in the markdown source', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await page.goto('/');
  await newNote(page, `Blocks ${TAG}`);
  const editor = body(page);

  // A table from a typed header row; Tab moves on and adds a row at the end.
  await page.keyboard.type('| Item | Qty |');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Tea');
  await page.keyboard.press('Tab');
  await page.keyboard.type('2');
  await page.keyboard.press('Tab');
  await page.keyboard.type('Milk');
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.type('Green tea');
  const table = editor.locator('.pm-table');
  await expect(table.getByRole('toolbar', { name: 'Table' })).toBeVisible();
  await table.getByRole('button', { name: 'Add Column Right' }).click();
  await expect(table.locator('tr').first().locator('th')).toHaveCount(3);
  // The new, empty column goes again.
  await table.locator('tr').nth(1).locator('td').nth(1).click();
  await table.getByRole('button', { name: 'Delete Column' }).click();
  await expect(table.locator('tr').first().locator('th')).toHaveCount(2);
  // The caret is in the cell after the deleted one ("2"); arrows go down and out of the table.
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await expect(table.getByRole('toolbar', { name: 'Table' })).toBeHidden();

  // A checklist.
  await page.keyboard.type('- [ ] Boil water');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Warm the pot');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await editor
    .locator('li[data-checked]', { hasText: 'Warm the pot' })
    .getByRole('checkbox')
    .check();

  // A callout and a toggle.
  await editor.locator('p').last().click();
  await page.keyboard.type('> [!tip] Steep for three minutes.');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await page.keyboard.type('> [!faq]- Milk first?');
  const toggle = editor.locator('.pm-callout', { hasText: 'Milk first?' });
  await expect(toggle).toHaveAttribute('data-open', 'true');
  await toggle.getByRole('textbox', { name: 'Callout title' }).fill('Settled');
  await toggle.getByRole('textbox', { name: 'Callout title' }).press('Enter');
  await toggle.getByRole('button', { name: 'Collapse Toggle' }).click();
  await expect(toggle).toHaveAttribute('data-open', 'false');
  await expect(toggle.locator('.pm-callout-body')).toBeHidden();

  await expect(editor.locator('.pm-callout[data-callout-type="tip"]')).toContainText(
    'Steep for three minutes.',
  );
  const expected = [
    '| Item | Qty |',
    '| - | - |',
    '| Green tea | 2 |',
    '| Milk | |',
    '',
    '- [ ] Boil water',
    '- [x] Warm the pot',
    '',
    '> [!tip]',
    '> Steep for three minutes.',
    '',
    '> [!faq]- Settled',
    '> Milk first?',
  ];

  // The source view shows the stored format, toggled with the button or ⌘⇧M.
  await noteAction(page, 'toggle-markdown');
  const source = page.getByTestId('note-markdown');
  await expect(source).toContainText(`title: Blocks ${TAG}`);
  for (const line of expected) await expect(source).toContainText(line);
  await page.keyboard.press('ControlOrMeta+Shift+KeyM');
  await expect(source).toBeHidden();
  await expect(editor).toBeVisible();

  // Folding is device state: it survives a reload and never changed the note.
  await page.reload();
  const reloaded = body(page).locator('.pm-callout[data-callout-type="question"]');
  await expect(reloaded.getByRole('textbox', { name: 'Callout title' })).toHaveValue('Settled');
  await expect(reloaded).toHaveAttribute('data-open', 'false');
  await page.keyboard.press('ControlOrMeta+Shift+KeyM');
  await expect(page.getByTestId('note-markdown')).toContainText('> [!faq]- Settled');
  expect(errors).toEqual([]);
});

test('T36: a table and a code block keep the note rhythm, with no gap above', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/');
  await newNote(page, `Rhythm ${TAG}`);
  const editor = body(page);

  await page.keyboard.type('Before the table');
  await page.keyboard.press('Enter');
  await page.keyboard.type('| Bed | Crop |');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Tomatoes');
  const table = editor.locator('.pm-table');
  const toolbar = table.getByRole('toolbar', { name: 'Table' });
  await expect(toolbar).toBeVisible();
  const withToolbar = (await table.boundingBox())!;
  // Out of the table: a paragraph after it, then a code block.
  await page.keyboard.press('ArrowDown');
  await expect(toolbar).toBeHidden();
  await page.keyboard.type('Between');
  await page.keyboard.press('Enter');
  await page.keyboard.type('```ts');
  await page.keyboard.press('Enter');
  await page.keyboard.type('const beds = 2;');
  await expect(editor.locator('.pm-code-block')).toHaveCount(1);

  // The space above a block is the paragraph's own margin: the hidden table toolbar takes none.
  const gapAbove = (block: string) =>
    editor.locator(block).evaluate((element) => {
      const previous = element.previousElementSibling!;
      return element.getBoundingClientRect().top - previous.getBoundingClientRect().bottom;
    });
  const tableGap = await gapAbove('.pm-table');
  const codeGap = await gapAbove('.pm-code-block');
  expect(tableGap).toBeGreaterThan(4);
  expect(tableGap).toBeLessThan(24);
  expect(Math.abs(tableGap - codeGap)).toBeLessThanOrEqual(1);
  // The toolbar floats over the text above: showing it never moved the table.
  expect((await table.boundingBox())!.y).toBeCloseTo(withToolbar.y, 0);
  expect(errors).toEqual([]);
});

/**
 * Page-loaded resources of a renderer library (dev: pre-bundled deps; build: chunks), not
 * the editor's own small loader modules (extensions/mermaid.ts, extensions/math.ts).
 */
/**
 * Lets the page record every resource it loads. The dev server serves each module
 * separately, and the browser's Resource Timing buffer keeps only the first 250
 * entries: once the app's own modules fill it, later loads (KaTeX after Mermaid)
 * would go unrecorded and a "never loaded" check would pass by default.
 */
const recordAllLoads = (page: Page) =>
  page.addInitScript(() => {
    performance.setResourceTimingBufferSize(100_000);
    performance.addEventListener('resourcetimingbufferfull', () => {
      document.documentElement.dataset['resourceBufferFull'] = 'true';
    });
  });

const rendererLoads = async (page: Page) => {
  const { full, names } = await page.evaluate(() => ({
    full: document.documentElement.dataset['resourceBufferFull'] === 'true',
    names: performance
      .getEntriesByType('resource')
      .map((entry) => entry.name)
      .filter((name) => /katex|mermaid/i.test(name) && !name.includes('/packages/editor/src/')),
  }));
  expect(full, 'the Resource Timing buffer filled up, so loads went unrecorded').toBe(false);
  return names;
};

/** Types a flowchart, a formula and an invalid formula and diagram; checks how each renders. */
async function writeDiagramsAndMath(page: Page) {
  const editor = body(page);
  await page.keyboard.type('```mermaid');
  await page.keyboard.press('Enter');
  await page.keyboard.type('graph TD\n  A[Write] --> B{Render?}\n  B -->|yes| C[Diagram]');
  const diagram = editor.locator('.pm-code-block[data-language="mermaid"]');
  await expect(diagram).toHaveAttribute('data-mode', 'edit');
  await expect(diagram.locator('.pm-diagram-output svg')).toBeVisible({ timeout: 15_000 });
  await expect(diagram.locator('.pm-diagram-output svg')).toContainText('Diagram');
  await diagram.getByRole('button', { name: 'Preview Diagram' }).click();
  await expect(diagram).toHaveAttribute('data-mode', 'preview');
  await expect(diagram.locator('pre')).toBeHidden();

  await editor.locator('p').last().click();
  await page.keyboard.type('Euler: $e^{i\\pi} + 1 = 0$ holds.');
  await page.keyboard.press('Enter');
  await page.keyboard.type('$$');
  await page.keyboard.press('Enter');
  const field = editor.getByRole('textbox', { name: 'Formula (LaTeX)' });
  await expect(field).toBeFocused();
  await page.keyboard.type('\\int_0^1 x^2 \\, dx = \\frac{1}{3}');
  await page.keyboard.press('ControlOrMeta+Enter');
  await expect(editor.locator('.pm-math-inline .katex')).toBeVisible();
  await expect(editor.locator('.pm-math-block .katex-display')).toBeVisible();

  // Invalid input shows its source and an error, never a blank block.
  await editor.locator('p').last().click();
  await page.keyboard.type('Broken: $\\frac{1$ here.');
  const broken = editor
    .locator('.pm-math-inline', { hasText: 'Broken' })
    .or(editor.locator('.pm-math-output[data-state="error"]'));
  await expect(broken.locator('.pm-math-source')).toHaveText('$\\frac{1$');
  await expect(broken.locator('.pm-math-error')).toContainText('KaTeX parse error');
  await page.keyboard.press('Enter');
  await page.keyboard.type('```mermaid');
  await page.keyboard.press('Enter');
  await page.keyboard.type('graph TD\n  A -->');
  const invalid = editor.locator('.pm-code-block[data-diagram="error"]');
  await expect(invalid.locator('.pm-diagram-error')).toContainText('Mermaid:', { timeout: 15_000 });
  await expect(invalid.locator('pre')).toBeVisible();
}

test('T12: Mermaid and KaTeX load only for notes that need them, and render', async ({ page }) => {
  const errors = collectErrors(page);
  // The dev server loads every module as its own resource, and Mermaid alone is hundreds:
  // past Chrome's default buffer of 250 entries, later loads (KaTeX) would go unrecorded.
  await recordAllLoads(page);
  await page.goto('/');
  await newNote(page, `Plain ${TAG}`);
  await page.keyboard.type('Just words, and a code block:');
  await page.keyboard.press('Enter');
  await page.keyboard.type('```ts');
  await page.keyboard.press('Enter');
  await page.keyboard.type('const cost = "$5";');
  await expect(body(page).locator('.hljs-string')).toBeVisible();
  expect(await rendererLoads(page)).toEqual([]);

  await page.reload();
  await expect(body(page)).toContainText('const cost');
  await newNote(page, `Diagrams ${TAG}`);
  await writeDiagramsAndMath(page);
  const loads = await rendererLoads(page);
  expect(loads.some((name) => /katex/i.test(name))).toBe(true);
  expect(loads.some((name) => /mermaid/i.test(name))).toBe(true);

  await noteAction(page, 'toggle-markdown');
  const source = page.getByTestId('note-markdown');
  for (const line of [
    '```mermaid',
    '  A[Write] --> B{Render?}',
    'Euler: $e^{i\\pi} + 1 = 0$ holds.',
    '$$',
    '\\int_0^1 x^2 \\, dx = \\frac{1}{3}',
  ]) {
    await expect(source).toContainText(line);
  }
  expect(errors).toEqual([]);
});

test('T12: the production build renders diagrams, formulas and code under the app CSP', async ({
  browser,
  host,
}) => {
  test.setTimeout(90_000);
  const context = await macContext(browser, host, { baseURL: PREVIEW });
  try {
    const page = await context.newPage();
    const errors = collectErrors(page);
    await page.addInitScript(() => {
      const seen: string[] = [];
      Object.assign(window, { cspViolations: seen });
      document.addEventListener('securitypolicyviolation', (event) =>
        seen.push(`${event.violatedDirective} ${event.blockedURI}`),
      );
    });
    const response = await page.goto('/');
    expect(response?.headers()['content-security-policy']).toContain("script-src 'self'");
    expect(response?.headers()['content-security-policy']).not.toContain('unsafe-eval');
    // The Mac app serves the bundle from its own files: no service worker (T59, D49).
    expect(await page.evaluate(() => navigator.serviceWorker.controller)).toBeNull();
    await newNote(page, `CSP ${TAG}`);
    await page.keyboard.type('```ts');
    await page.keyboard.press('Enter');
    await page.keyboard.type('let ok = true;');
    await expect(body(page).locator('.hljs-keyword')).toHaveText('let');
    await body(page).locator('p').last().click();
    await writeDiagramsAndMath(page);
    // KaTeX's fonts load from this origin.
    await expect
      .poll(() =>
        page.evaluate(() =>
          performance
            .getEntriesByType('resource')
            .some((entry) => /KaTeX_.*\.woff2/.test(entry.name)),
        ),
      )
      .toBe(true);
    // Mermaid loaded when the diagram first needed it (A23).
    expect(
      await page.evaluate(() =>
        performance
          .getEntriesByType('resource')
          .some((entry) => /\/mermaid\.core-[^/]+\.js$/.test(entry.name)),
      ),
    ).toBe(true);
    expect(
      await page.evaluate(() => (window as unknown as { cspViolations: string[] }).cspViolations),
    ).toEqual([]);
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});

/**
 * ProseMirror reads a caret moved by the browser (Home, a click) on the next
 * selectionchange event; a key pressed before that sees the old selection.
 */
const caretSettles = (page: Page) => page.waitForTimeout(100);

test('T12: diagram text cannot run script, follow a link or lower the security level', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await page.goto('/');
  await newNote(page, `Untrusted ${TAG}`);
  await page.keyboard.type('```mermaid');
  await page.keyboard.press('Enter');
  await page.keyboard.type(
    [
      '%%{init: {"securityLevel": "loose"}}%%',
      'graph TD',
      '  A["<img src=data:, onerror=window.pwned=1>Label"] --> B[Link]',
      '  click B href "javascript:window.pwned=2"',
      '  click A call alert(3)',
    ].join('\n'),
  );
  const diagram = body(page).locator('.pm-code-block[data-language="mermaid"]');
  const output = diagram.locator('.pm-diagram-output');
  await expect(output.locator('svg')).toBeVisible({ timeout: 15_000 });
  await expect(output.locator('svg')).toContainText('Link');
  expect(await output.locator('[onerror], [onclick]').count()).toBe(0);
  expect(
    await output.evaluate((element) =>
      [...element.querySelectorAll('a')].map(
        (link) => link.getAttribute('href') ?? link.getAttribute('xlink:href') ?? '',
      ),
    ),
  ).not.toContainEqual(expect.stringMatching(/^javascript:/i));
  await output.getByText('Link', { exact: true }).click();
  await output.getByText('Label', { exact: true }).click();
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => (window as { pwned?: unknown }).pwned)).toBeUndefined();
  await expect(page).toHaveURL(ULID);
  expect(errors).toEqual([]);
});

test('T11/T12: hidden diagram source and folded toggle bodies take no stray edits', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await page.goto('/');
  await newNote(page, `Hidden ${TAG}`);
  await page.keyboard.type('```mermaid');
  await page.keyboard.press('Enter');
  await page.keyboard.type('graph TD\n  A --> B');
  const diagram = body(page).locator('.pm-code-block[data-language="mermaid"]');
  await expect(diagram.locator('.pm-diagram-output svg')).toBeVisible({ timeout: 15_000 });
  // ArrowDown at the end of the source leaves the block for a new paragraph.
  await page.keyboard.press('ArrowDown');
  await page.keyboard.type('After');
  await diagram.getByRole('button', { name: 'Preview Diagram' }).click();
  await expect(diagram.locator('pre')).toBeHidden();
  await body(page).locator(':scope > p', { hasText: 'After' }).click();
  await caretSettles(page);
  await page.keyboard.press(LINE_START);
  await caretSettles(page);
  await page.keyboard.press('Backspace');
  await expect(diagram).toHaveClass(/ProseMirror-selectednode/);
  await expect(body(page).locator(':scope > p').last()).toHaveText('After');
  await page.keyboard.press('ArrowDown');
  await caretSettles(page);
  await page.keyboard.press('ArrowUp');
  await expect(diagram).toHaveClass(/ProseMirror-selectednode/);
  await expect(diagram).toHaveAttribute('data-mode', 'preview');
  await page.keyboard.press('Enter');
  await expect(diagram).toHaveAttribute('data-mode', 'edit');
  await page.keyboard.type('X');
  await expect(diagram.locator('code')).toHaveText('graph TD\n  A --> BX');

  // A paragraph, a folded toggle above it, then Backspace at its start.
  await body(page).locator(':scope > p').last().click();
  await caretSettles(page);
  await page.keyboard.press(LINE_END);
  await caretSettles(page);
  await page.keyboard.press('Enter');
  await page.keyboard.type('Tail');
  await body(page).locator(':scope > p', { hasText: 'After' }).click();
  await caretSettles(page);
  await page.keyboard.press(LINE_END);
  await caretSettles(page);
  await page.keyboard.press('Enter');
  await page.keyboard.type('> [!faq]- Answer');
  const toggle = body(page).locator('.pm-callout');
  await toggle.getByRole('button', { name: 'Collapse Toggle' }).click();
  await expect(toggle).toHaveAttribute('data-open', 'false');
  const tail = body(page).locator(':scope > p', { hasText: 'Tail' });
  await tail.click();
  await caretSettles(page);
  await page.keyboard.press(LINE_START);
  await caretSettles(page);
  await page.keyboard.press('Backspace');
  await expect(toggle).toHaveClass(/ProseMirror-selectednode/);
  await expect(toggle.locator('.pm-callout-body')).toBeHidden();
  await expect(tail).toHaveText('Tail');
  expect(errors).toEqual([]);
});
