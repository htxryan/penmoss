// The link form: its buttons, its rows and what it edits.
import { expect, type Page, test } from './fixtures';
import { collectErrors, ULID } from './support/app';

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

const body = (page: Page) => page.getByTestId('note-view').locator('.ProseMirror');
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

  // Ryan’s feedback of 6 Nov 2026 (Quanta), item 1.
  test('the link form has icon-and-text buttons above Text and Link, and edits both', async ({
    page,
  }) => {
    const errors = collectErrors(page);
    await page.goto('/');
    await openNote(page, 'Links');
    const words = body(page).getByText('See the docs here.');
    await words.click();
    // Select "the docs".
    await page.keyboard.press('Home');
    for (let i = 0; i < 'See '.length; i++) await page.keyboard.press('ArrowRight');
    for (let i = 0; i < 'the docs'.length; i++) await page.keyboard.press('Shift+ArrowRight');
    const toolbar = page.getByTestId('selection-toolbar');
    await expect(toolbar).toBeVisible();
    // A43: the selection settles before the next key.
    await expect.poll(() => page.evaluate(() => getSelection()?.toString())).toBe('the docs');
    await page.keyboard.press('ControlOrMeta+KeyK');
    const address = page.getByRole('textbox', { name: 'Link address' });
    const text = page.getByRole('textbox', { name: 'Link text' });
    await expect(address).toBeFocused();
    await expect(text).toHaveValue('the docs');
    const apply = toolbar.getByRole('button', { name: 'Apply' });
    const remove = toolbar.getByRole('button', { name: 'Remove Link' });
    for (const button of [apply, remove]) {
      await expect(button.locator('svg')).toHaveCount(1);
    }
    await expect(toolbar.getByRole('button', { name: 'Comment' })).toBeHidden();
    // The buttons sit above the fields.
    const buttonsBottom = await apply.evaluate((element) => element.getBoundingClientRect().bottom);
    const textTop = await text.evaluate((element) => element.getBoundingClientRect().top);
    expect(buttonsBottom).toBeLessThanOrEqual(textTop);
    await address.fill('penmoss.app/docs');
    if (SHOTS) await toolbar.screenshot({ path: `${SHOTS}/link-form.png` });
    await page.keyboard.press('Enter');
    await expect(body(page).locator('a[href="https://penmoss.app/docs"]')).toHaveText('the docs');

    // Back on the link (a double-click selects it all): both fields filled; new words and a new address
    // in one go.
    await body(page)
      .locator('a')
      .getByText('the docs')
      .dblclick({ position: { x: 40, y: 8 } });
    await expect(toolbar).toBeVisible();
    await expect.poll(() => page.evaluate(() => getSelection()?.toString())).toBe('the docs');
    await page.keyboard.press('ControlOrMeta+KeyK');
    await expect(text).toHaveValue('the docs');
    await expect(address).toHaveValue('https://penmoss.app/docs');
    await text.fill('the guide');
    await address.fill('https://penmoss.app/guide');
    if (SHOTS) {
      await toolbar.screenshot({ path: `${SHOTS}/link-form-edit.png` });
      // In place, over the note, as it opens on a link.
      const near = await toolbar.boundingBox();
      if (near) {
        await page.screenshot({
          path: `${SHOTS}/link-form-in-note.png`,
          clip: {
            x: Math.max(0, near.x - 60),
            y: Math.max(0, near.y - 40),
            width: near.width + 120,
            height: near.height + 110,
          },
        });
      }
    }
    await apply.click();
    await expect(body(page).locator('a[href="https://penmoss.app/guide"]')).toHaveText('the guide');
    await expect(body(page)).toContainText('See the guide here.');
    expect(errors).toEqual([]);
  });
});

const tree = (page: Page) => page.getByRole('tree', { name: 'Folders and notes' });

async function openNoteFromTree(page: Page, title: string): Promise<void> {
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
test.describe('in Personal, with nested folders', () => {
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

  // T67, item #225.
  test('the link form keeps every row inside one padding; Apply and Remove alike', async ({
    page,
  }) => {
    const errors = collectErrors(page);
    await page.goto('/');
    await openNoteFromTree(page, 'Links');
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
});
