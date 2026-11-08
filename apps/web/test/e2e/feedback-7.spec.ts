import { expect, test, type Page } from './fixtures';

// Ryan's feedback of 6 Nov 2026 ("Quanta Penmoss Feedback", Quanta), in the web app (the Mac app
// runs the same page), T64: the link form's icon-and-text buttons above its Text and Link fields
// (item 1); Auto-Update in Settings → Updates and the notice a newer build brings (2); "No tags"
// (3); numbered lists as an outline, 1, A, i, a (4); the notebook first in the breadcrumb with
// two notebooks open (5); Backspace at the start of the first line joins it to the title (6);
// lists that end up side by side are one list again (7).

const SHOTS = process.env['PENMOSS_EVIDENCE'];
const ULID = /\/notes\/([0-9A-HJKMNP-TV-Z]{26})$/;

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

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(error.message));
  return errors;
}

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

/** Puts the caret at the start of the `index`th paragraph of the note body. */
async function caretAtStart(page: Page, selector: string, index = 0): Promise<void> {
  await body(page).locator(selector).nth(index).click();
  await page.keyboard.press('Home');
}

test('1: the link form has icon-and-text buttons above Text and Link, and edits both', async ({
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

test('3: an empty Tags section says "No tags", centred and muted as "No notes" is', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await page.goto('/');
  const empty = page.locator('#tag-pane-body');
  await expect(empty).toHaveText('No tags', { timeout: 30_000 });
  const style = await empty.evaluate((element) => {
    const s = getComputedStyle(element);
    return { align: s.textAlign, color: s.color };
  });
  const muted = await page.evaluate(() => {
    const probe = document.createElement('span');
    probe.style.color = 'var(--pm-muted)';
    document.body.append(probe);
    const color = getComputedStyle(probe).color;
    probe.remove();
    return color;
  });
  expect(style).toEqual({ align: 'center', color: muted });
  expect(errors).toEqual([]);
});

test('4: numbered lists read as an outline, 1, A, i, a', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/');
  await openNote(page, 'Outline');
  const types = await body(page)
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

test('5: with two notebooks open, the breadcrumb starts with the note’s notebook', async ({
  page,
  host,
}) => {
  const errors = collectErrors(page);
  await page.goto('/');
  await openNote(page, 'Links');
  // One notebook: no notebook in the breadcrumb.
  await expect(page.getByTestId('note-source-crumb')).toHaveCount(0);
  await host.seed({ name: 'Work', notes: [{ title: 'Parser' }] });
  await expect(section(page, 'Work')).toBeVisible({ timeout: 40_000 });
  const crumbs = page.getByRole('navigation', { name: 'Breadcrumb' });
  await expect(crumbs.getByTestId('note-source-crumb')).toHaveText('Quanta');
  await openNote(page, 'Parser', 'Work');
  await expect(crumbs.getByTestId('note-source-crumb')).toHaveText('Work');
  await expect(crumbs.locator('li').last()).toHaveText('Parser');
  if (SHOTS) await page.locator('.note-top').screenshot({ path: `${SHOTS}/breadcrumb.png` });
  expect(errors).toEqual([]);
});

test('6: Backspace at the start of the first line joins it to the title', async ({ page }) => {
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
  await expect(body(page).locator('p').first()).toHaveText('second line');
  // An empty first line just goes, and the caret lands at the title's end. Enter in the title
  // moves to the text: the next keys wait until it is there.
  await page.keyboard.press('Enter');
  await expect(page.locator('.note-body .ProseMirror')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(body(page).locator('p')).toHaveCount(2);
  await page.keyboard.press('ArrowUp');
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
  await expect(body(page).locator('p').first()).toHaveText('second line');
  expect(errors).toEqual([]);
});

test('7: Backspace twice at a numbered item keeps the items below in the same list', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await page.goto('/');
  await openNote(page, 'Lists');
  await caretAtStart(page, 'li p', 1);
  await page.keyboard.press('Backspace');
  await expect(body(page).locator('ol')).toHaveCount(2);
  await page.keyboard.press('Backspace');
  await expect(body(page).locator('ol')).toHaveCount(1);
  await expect(body(page).locator('ol > li')).toHaveText(['onetwo', 'three']);
  expect(errors).toEqual([]);
});

test('2: Auto-Update is a switch in Settings → Updates; a newer build is offered, then installed', async ({
  page,
  host,
}) => {
  const errors = collectErrors(page);
  await page.goto('/settings/updates');
  const settings = page.getByTestId('updates-settings');
  await expect(settings).toContainText('This is build 435.');
  const auto = settings.getByTestId('updates-auto');
  await expect(auto).not.toBeChecked();
  await expect(auto).toBeEnabled();
  await page.waitForTimeout(300);
  expect(host.updateFeed.checks).toBe(0);

  // Check Now with nothing newer.
  await settings.getByTestId('updates-check').click();
  await expect(settings.getByTestId('updates-status')).toHaveText('Penmoss is up to date.');
  expect(host.updateFeed.checks).toBe(1);

  // Turned on, it checks at once (and hourly after): build 440 is offered, not downloaded.
  host.updateFeed.offered = '0.1.440';
  await auto.check();
  await expect(auto).toBeChecked();
  // Settings shows it in its section; the notes' window shows the notice.
  await expect(settings.getByTestId('updates-status')).toHaveText('Build 440 is available.');
  await expect(settings.getByTestId('updates-install')).toBeVisible();
  expect(host.updateFeed.installs).toBe(0);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/updates.png` });
  await page.goto('/');
  await expect(page.getByTestId('update-notice')).toContainText('Build 440 is available.');
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/update-notice.png` });

  // Install and Restart: downloads with progress, then restarts into it.
  await page.getByTestId('update-install').click();
  await expect(page.getByTestId('update-notice')).toContainText(/Downloading build 440… \d+%/);
  await expect.poll(() => host.updateFeed.installs).toBe(1);
  await expect(page.getByTestId('update-notice')).toContainText('Build 440 is downloaded');

  // The switch is remembered (this Mac's userData).
  await page.goto('/settings/updates');
  await expect(page.getByTestId('updates-auto')).toBeChecked();
  expect(errors).toEqual([]);
});
