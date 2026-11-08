import { expect, test, type Page } from './fixtures';

// T67, three bugs from the Penmoss board (6 Nov 2026), in the web app (the Mac app runs the same
// page): a key pressed as the note takes focus keeps its selection (#224, A1141); the link form's
// rows inside one padding (#225, A1142); every folder opens and closes, each level indented
// (#231, A1143).

const SHOTS = process.env['PENMOSS_EVIDENCE'];
const ULID = /\/notes\/([0-9A-HJKMNP-TV-Z]{26})$/;

test.use({
  seed: {
    name: 'Personal',
    folders: ['Penmoss', 'Penmoss/Feedback Archive', 'Penmoss/Work/Deep'],
    notes: [
      { title: 'Links', markdown: 'See the docs here.\n' },
      { title: 'Penmoss Feedback', markdown: 'Feedback.\n', folder: 'Penmoss' },
      { title: 'In Deep', markdown: 'Deep down.\n', folder: 'Penmoss/Work/Deep' },
    ],
  },
});

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(error.message));
  return errors;
}

const tree = (page: Page) => page.getByRole('tree', { name: 'Folders and notes' });
const row = (page: Page, name: string) => tree(page).getByRole('treeitem', { name, exact: true });
const body = (page: Page) => page.getByTestId('note-view').locator('.ProseMirror');

async function openNote(page: Page, title: string): Promise<void> {
  await tree(page).getByRole('link', { name: title, exact: true }).click();
  await expect(page).toHaveURL(ULID);
  await expect(page.getByTestId('note-title')).toHaveValue(title);
}

/** Selects "the docs" in the Links note from the keyboard; the selection toolbar shows. */
async function selectTheDocs(page: Page): Promise<void> {
  await body(page).getByText('See the docs here.').click();
  await page.keyboard.press('Home');
  for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowRight');
  for (let i = 0; i < 'the docs'.length; i++) await page.keyboard.press('Shift+ArrowRight');
  await expect(page.getByTestId('selection-toolbar')).toBeVisible();
  await expect.poll(() => page.evaluate(() => getSelection()?.toString())).toBe('the docs');
}

test('#224: a selection a key moves as the note takes focus is kept', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/');
  await openNote(page, 'Links');
  await body(page).getByText('See the docs here.').click();
  await page.keyboard.press('Home');
  await expect.poll(() => page.evaluate(() => getSelection()?.anchorOffset)).toBe(0);
  // Focus leaves the note, then comes back with a key straight after, which moves the page's
  // selection. Under load the browser reports that (`selectionchange`) after ProseMirror's
  // 20 ms restore on focus has run; holding the report back for the moment makes that so.
  await page.getByTestId('note-title').focus();
  const selected = await page.evaluate(async () => {
    const editor = document.querySelector<HTMLElement>('[data-testid="note-view"] .ProseMirror')!;
    const late = (event: Event) => event.stopImmediatePropagation();
    document.addEventListener('selectionchange', late, true);
    editor.focus();
    editor.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'ArrowRight', shiftKey: true, bubbles: true }),
    );
    for (let i = 0; i < 3; i++) getSelection()!.modify('extend', 'forward', 'character');
    await new Promise((done) => setTimeout(done, 120));
    document.removeEventListener('selectionchange', late, true);
    return getSelection()?.toString();
  });
  expect(selected).toBe('See');
  // And the editor took it: typing replaces those three letters.
  await page.keyboard.type('Read');
  await expect(body(page).locator('p').first()).toHaveText('Read the docs here.');

  // Typed fast after a click, Shift+→ selects every letter (the case the issue found under load).
  await body(page).locator('p').first().click();
  await page.keyboard.press('Home');
  for (let i = 0; i < 'Read '.length; i++) await page.keyboard.press('ArrowRight');
  for (let i = 0; i < 'the docs'.length; i++) await page.keyboard.press('Shift+ArrowRight');
  await expect.poll(() => page.evaluate(() => getSelection()?.toString())).toBe('the docs');
  expect(errors).toEqual([]);
});

test('#225: the link form keeps every row inside one padding; Apply and Remove alike', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await page.goto('/');
  await openNote(page, 'Links');
  await selectTheDocs(page);
  const toolbar = page.getByTestId('selection-toolbar');
  await toolbar.getByRole('button', { name: 'Link', exact: true }).click();
  const address = page.getByRole('textbox', { name: 'Link address' });
  await expect(address).toBeFocused();
  const apply = toolbar.getByRole('button', { name: 'Apply' });
  const remove = toolbar.getByRole('button', { name: 'Remove Link' });

  const geometry = await toolbar.evaluate((element) => {
    const box = (node: Element) => node.getBoundingClientRect();
    const style = getComputedStyle(element);
    const inner = {
      left: box(element).left + parseFloat(style.borderLeftWidth) + parseFloat(style.paddingLeft),
      right:
        box(element).right - parseFloat(style.borderRightWidth) - parseFloat(style.paddingRight),
    };
    const fields = [...element.querySelectorAll('.pm-toolbar-link-input')].map(box);
    const labels = [...element.querySelectorAll('.pm-toolbar-link-field > span')].map(box);
    const buttons = [...element.querySelectorAll('.pm-toolbar-link-action')].map(box);
    const icon = box(element.querySelector('.pm-toolbar-link-action svg')!);
    return { inner, fields, labels, buttons, icon };
  });
  // Every field ends inside the border, at the inset the buttons start from on the left.
  for (const field of geometry.fields) {
    expect(field.right).toBeLessThanOrEqual(geometry.inner.right + 0.5);
    expect(geometry.inner.right - field.right).toBeCloseTo(
      geometry.buttons[0]!.left - geometry.inner.left,
      0,
    );
  }
  // The labels start where the first button's icon does; the two fields line up.
  for (const label of geometry.labels) expect(label.left).toBeCloseTo(geometry.icon.left, 0);
  expect(geometry.fields[0]!.left).toBeCloseTo(geometry.fields[1]!.left, 1);

  // A pointer left where it was when the form opened is no hover (clicking Link leaves it
  // where Remove then shows): Remove, hovered by such a pointer, looks like Apply. Chromium's
  // DevTools protocol holds Remove in :hover without moving the pointer.
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('DOM.enable');
  await cdp.send('CSS.enable');
  const { root } = await cdp.send('DOM.getDocument');
  const { nodeId } = await cdp.send('DOM.querySelector', {
    nodeId: root.nodeId,
    selector: '.pm-toolbar-link-action[aria-label="Remove Link"]',
  });
  await cdp.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: ['hover'] });
  const background = (locator: typeof apply) =>
    locator.evaluate((element) => getComputedStyle(element).backgroundColor);
  expect(await background(remove)).toBe(await background(apply));
  if (SHOTS) await toolbar.screenshot({ path: `${SHOTS}/link-form.png` });
  // Once the pointer moves over the form, a hover shows as anywhere else.
  const textBox = (await page.getByRole('textbox', { name: 'Link text' }).boundingBox())!;
  await page.mouse.move(textBox.x + 4, textBox.y + 4);
  await page.mouse.move(textBox.x + 8, textBox.y + 6);
  await expect.poll(() => background(remove)).not.toBe(await background(apply));
  await cdp.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: [] });
  expect(errors).toEqual([]);
});

test('#231: every folder opens and closes, an empty one too; each level is indented', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await page.goto('/');
  await expect(tree(page)).toBeVisible();
  const penmoss = row(page, 'Penmoss');
  await penmoss.locator('.twisty').click();
  await expect(penmoss).toHaveAttribute('aria-expanded', 'true');

  // The empty subfolder has a chevron, opens to say it is empty, and closes again.
  const archive = row(page, 'Feedback Archive');
  await expect(archive).toHaveAttribute('aria-expanded', 'false');
  await expect(archive.locator('.twisty')).toBeVisible();
  await archive.locator('.twisty').click();
  await expect(archive).toHaveAttribute('aria-expanded', 'true');
  await expect(tree(page).getByTestId('tree-empty-folder')).toHaveText('Empty');
  await archive.locator('.twisty').click();
  await expect(archive).toHaveAttribute('aria-expanded', 'false');
  await expect(tree(page).getByTestId('tree-empty-folder')).toHaveCount(0);
  // From the keyboard too: → opens it, ← closes it.
  await archive.focus();
  await page.keyboard.press('ArrowRight');
  await expect(archive).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.press('ArrowLeft');
  await expect(archive).toHaveAttribute('aria-expanded', 'false');

  // Two levels down, a subfolder opens and closes like a top-level one.
  const work = row(page, 'Work');
  await work.locator('.twisty').click();
  const deep = row(page, 'Deep');
  await deep.locator('.twisty').click();
  await expect(row(page, 'In Deep')).toBeVisible();
  await deep.locator('.twisty').click();
  await expect(row(page, 'In Deep')).toBeHidden();
  await deep.locator('.twisty').click();

  // Each level is indented: a row's chevron sits under its parent's icon, and a note's icon
  // one step in from its folder's.
  const centre = async (locator: ReturnType<typeof row>, part: string) => {
    const found = (await locator.locator(part).first().boundingBox())!;
    return found.x + found.width / 2;
  };
  expect(await centre(work, '.twisty')).toBeCloseTo(await centre(penmoss, '.tree-icon'), 0);
  expect(await centre(deep, '.twisty')).toBeCloseTo(await centre(work, '.tree-icon'), 0);
  const step =
    (await centre(row(page, 'In Deep'), '.tree-icon')) - (await centre(deep, '.tree-icon'));
  expect(step).toBeGreaterThan(20);
  expect(await centre(row(page, 'Penmoss Feedback'), '.tree-icon')).toBeCloseTo(
    (await centre(penmoss, '.tree-icon')) + step,
    0,
  );
  if (SHOTS) await page.locator('.sidebar').screenshot({ path: `${SHOTS}/nested-folders.png` });
  expect(errors).toEqual([]);
});
