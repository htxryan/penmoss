import { expect, test, type Page } from './fixtures';
import { LINE_END, NEW_FOLDER } from './keys';

// T39 pass 1 (web): what using the app end to end turned up. A long title wraps instead of
// being cut off; a note moves to another folder from the keyboard or a phone; Tab stays in a
// modal dialog, which has a close button; a note opened by its address shows in the tree; a
// double click on New note makes one note; the note column keeps its width beside the
// Backlinks panel.

const ULID = /\/notes\/([0-9A-HJKMNP-TV-Z]{26})$/;
const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
const PALETTE = 'ControlOrMeta+KeyK';
const SEARCH = 'ControlOrMeta+Shift+KeyF';

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(error.message));
  return errors;
}

const treeOf = (page: Page) => page.getByRole('tree', { name: 'Folders and notes' });
const row = (page: Page, name: string) => treeOf(page).getByRole('treeitem', { name, exact: true });
const body = (page: Page) => page.getByTestId('note-body').locator('.ProseMirror');

async function newNote(page: Page, title: string, text = ''): Promise<string> {
  await page
    .getByRole('button', { name: /^New Note/ })
    .first()
    .click();
  await expect(page).toHaveURL(ULID);
  await expect(page.getByTestId('note-title')).toBeFocused();
  await page.keyboard.type(title);
  if (text) {
    await page.keyboard.press('Enter');
    await page.keyboard.type(text);
  }
  await expect(page.getByTestId('note-view')).toHaveAttribute('data-ready', 'true');
  return ULID.exec(new URL(page.url()).pathname)![1]!;
}

async function newFolder(page: Page, name: string) {
  await page.keyboard.press(NEW_FOLDER);
  const input = page.getByRole('textbox', { name: 'New folder name' });
  await expect(input).toBeFocused();
  await input.fill(name);
  await input.press('Enter');
  await expect(row(page, name)).toBeVisible();
}

async function runFromPalette(page: Page, title: string) {
  await page.keyboard.press(PALETTE);
  const palette = page.getByRole('dialog', { name: 'Command Palette' });
  await expect(palette).toBeVisible();
  await page.keyboard.type(title);
  await palette
    .getByRole('option', { name: new RegExp(title.replace('…', '')) })
    .first()
    .click();
}

test('a long title wraps and stays one line of text', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/');
  const title = `A title ${RUN} long enough to need a second line in the note column, and then some more words so it surely wraps twice`;
  await newNote(page, title);
  const field = page.getByTestId('note-title');
  await expect(field).toHaveValue(title);
  // All of it shows: the field grew instead of scrolling its text out of sight.
  const size = await field.evaluate((element) => ({
    height: element.getBoundingClientRect().height,
    lineHeight: parseFloat(getComputedStyle(element).lineHeight),
    hidden: element.scrollHeight - element.clientHeight,
    sideways: element.scrollWidth - element.clientWidth,
  }));
  expect(size.height).toBeGreaterThan(size.lineHeight * 1.5);
  expect(size.hidden).toBeLessThanOrEqual(1);
  expect(size.sideways).toBeLessThanOrEqual(1);

  // Still one line: Enter goes to the body, a pasted line break becomes a space.
  await field.focus();
  await page.keyboard.press(LINE_END);
  await page.keyboard.press('Enter');
  await expect(body(page)).toBeFocused();
  await field.focus();
  await field.evaluate((element) => {
    const data = new DataTransfer();
    data.setData('text/plain', ' first\nsecond');
    element.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
    );
  });
  await expect(field).toHaveValue(`${title} first second`);
  expect(errors).toEqual([]);
});

test('Move to folder… files the open note from the keyboard', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/');
  await expect(treeOf(page)).toBeVisible();
  await page.getByTestId('tree-root-drop').click();
  const folder = `Filing ${RUN}`;
  await newFolder(page, folder);
  await page.getByTestId('tree-root-drop').click();
  const title = `Loose note ${RUN}`;
  await newNote(page, title, 'To be filed.');
  await expect(row(page, title)).toHaveAttribute('aria-level', '1');

  await runFromPalette(page, 'Move to Folder…');
  const picker = page.getByRole('dialog', { name: `Move “${title}” to a folder` });
  await expect(picker).toBeVisible();
  // Where the note is now is marked, and typing finds a folder by its path.
  await expect(picker.getByRole('option', { name: /Top level/ })).toHaveAttribute(
    'aria-current',
    'location',
  );
  await page.keyboard.type(`filing ${RUN}`);
  await page.keyboard.press('Enter');
  await expect(picker).toBeHidden();
  await expect(page.getByTestId('move-status')).toHaveText(`Moved to ${folder}`);
  // Focus goes back to the note, where it was before the palette (T39 review).
  await expect(body(page)).toBeFocused();
  await expect(row(page, title)).toHaveAttribute('aria-level', '2');
  await expect(row(page, folder)).toHaveAttribute('aria-expanded', 'true');

  // Choosing where it already is changes nothing, and says so.
  await runFromPalette(page, 'Move to Folder…');
  await page.keyboard.type(`filing ${RUN}`);
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('move-status')).toHaveText(`Already in ${folder}`);
  expect(errors).toEqual([]);
});

test('Tab stays in a modal dialog, and its close button closes it', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/');
  await newNote(page, `Dialog note ${RUN}`, 'Text.');
  for (const [keys, name, close] of [
    [PALETTE, 'Command Palette', 'Close the Palette'],
    [SEARCH, 'Search', 'Close Search'],
  ] as const) {
    await page.keyboard.press(keys);
    const dialog = page.getByRole('dialog', { name });
    await expect(dialog).toBeVisible();
    // However often Tab is pressed, forwards or back, focus stays in the dialog.
    for (const key of ['Tab', 'Tab', 'Tab', 'Tab', 'Tab', 'Shift+Tab', 'Shift+Tab']) {
      await page.keyboard.press(key);
      expect(
        await dialog.evaluate((element) => element.contains(document.activeElement)),
        `${name}: ${key}`,
      ).toBe(true);
    }
    await dialog.getByRole('button', { name: close }).click();
    await expect(dialog).toBeHidden();
  }
  expect(errors).toEqual([]);
});

test('a note opened by its address shows in the tree, its folders open', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/');
  await expect(treeOf(page)).toBeVisible();
  await page.getByTestId('tree-root-drop').click();
  const outer = `Outer ${RUN}`;
  const inner = `Inner ${RUN}`;
  await newFolder(page, outer);
  await newFolder(page, inner);
  const title = `Nested note ${RUN}`;
  const id = await newNote(page, title, 'Deep down.');
  await expect(row(page, title)).toHaveAttribute('aria-level', '3');
  // Close the folders, then open the note by its address (a reload, a link, the Mac app).
  await row(page, outer).click();
  await page.keyboard.press('ArrowLeft');
  await expect(row(page, outer)).toHaveAttribute('aria-expanded', 'false');
  await page.waitForTimeout(500); // The expanded state is stored on this device.
  await page.goto(`/notes/${id}`);
  await expect(page.getByTestId('note-title')).toHaveValue(title);
  await expect(row(page, title)).toBeVisible();
  await expect(row(page, title)).toBeInViewport();
  await expect(row(page, outer)).toHaveAttribute('aria-expanded', 'true');
  await expect(row(page, inner)).toHaveAttribute('aria-expanded', 'true');
  expect(errors).toEqual([]);
});

test('a double click on New note makes one note', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/');
  await expect(treeOf(page)).toBeVisible();
  await page.getByTestId('tree-root-drop').click();
  const folder = `Double ${RUN}`;
  await newFolder(page, folder);
  await page
    .getByRole('button', { name: /^New Note/ })
    .first()
    .dblclick();
  await expect(page).toHaveURL(ULID);
  await expect(page.getByTestId('note-title')).toBeFocused();
  const title = `Once ${RUN}`;
  await page.keyboard.type(title);
  await expect(page.getByTestId('note-view')).toHaveAttribute('data-ready', 'true');
  // The new folder holds this note and nothing else: no empty "Untitled" beside it.
  await expect(row(page, title)).toHaveAttribute('aria-level', '2');
  await expect(row(page, title)).toHaveAttribute('aria-setsize', '1');
  expect(errors).toEqual([]);
});

// T41: the Backlinks panel is the Info panel (A502); only its names changed here.
test('the note column keeps its width beside the Info panel', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  const narrow = await newNote(page, `Narrow ${RUN}`, 'Short.');
  const wide = await newNote(
    page,
    `Wide ${RUN}`,
    'A paragraph long enough to fill the whole column from one side to the other, and more. '.repeat(
      3,
    ),
  );
  const widthOf = async (id: string) => {
    await page.goto(`/notes/${id}`);
    await expect(page.getByTestId('note-view')).toHaveAttribute('data-ready', 'true');
    // The panel's Metadata tab, open (T53 item 9): its icon opens it, or closes it while it shows.
    const info = page.getByTestId('note-tab-info');
    if ((await info.getAttribute('aria-selected')) !== 'true') await info.click();
    await expect(info).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('complementary', { name: 'Metadata' })).toBeVisible();
    return page
      .locator('.doc:not([hidden])')
      .evaluate((element) => element.getBoundingClientRect());
  };
  const a = await widthOf(narrow);
  const b = await widthOf(wide);
  expect(a.width).toBe(b.width);
  expect(a.left).toBe(b.left);
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test('the note sheet moves a note, and search has a close button', async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto('/');
    const title = `Phone filing ${RUN}`;
    await page.getByRole('button', { name: 'New Note', exact: true }).tap();
    await expect(page).toHaveURL(ULID);
    await page.keyboard.type(title);
    await page.keyboard.press('Enter');
    await page.keyboard.type('Filed from a phone.');
    await expect(page.getByTestId('note-view')).toHaveAttribute('data-ready', 'true');

    // A folder to move it to, made in the drawer.
    const folder = `Phone folder ${RUN}`;
    const appBar = page.getByTestId('app-bar');
    await appBar.getByRole('button', { name: 'Open Navigation' }).tap();
    const drawer = page.getByRole('complementary', { name: 'Notes' });
    await expect(drawer).toBeVisible();
    await drawer.getByRole('button', { name: 'New Folder' }).tap();
    const input = page.getByRole('textbox', { name: 'New folder name' });
    await input.fill(folder);
    await input.press('Enter');
    await expect(row(page, folder)).toBeVisible();
    await expect(row(page, title)).toHaveAttribute('aria-level', '1');
    await page.getByRole('button', { name: 'Close Navigation' }).tap();
    await expect(drawer).toBeHidden();

    // The picker's close button is a touch target and closes it.
    await appBar.getByRole('button', { name: 'Note Actions' }).tap();
    await page.getByRole('menuitem', { name: 'Move to Folder…' }).tap();
    const picker = page.getByRole('dialog', { name: `Move “${title}” to a folder` });
    await expect(picker).toBeVisible();
    const close = picker.getByRole('button', { name: 'Close the Folder Picker' });
    const box = await close.boundingBox();
    expect(box!.width).toBeGreaterThanOrEqual(44);
    expect(box!.height).toBeGreaterThanOrEqual(44);
    // No keyboard hints on a touch screen.
    await expect(picker.locator('.dlg-foot')).toBeHidden();
    await close.tap();
    await expect(picker).toBeHidden();

    // Moved by touch: the toast says where, and the note has focus again.
    await appBar.getByRole('button', { name: 'Note Actions' }).tap();
    await page.getByRole('menuitem', { name: 'Move to Folder…' }).tap();
    await expect(picker).toBeVisible();
    await picker.getByRole('option', { name: folder }).tap();
    await expect(picker).toBeHidden();
    await expect(page.getByTestId('move-status')).toHaveText(`Moved to ${folder}`);
    await expect(body(page)).toBeFocused();
    // The app bar shows where the note is now (T39 pass 3, A907).
    await expect(appBar.getByTestId('app-bar-path')).toHaveText(folder);
    // Each part isolated, so a name with a bidi override can't reorder the others (review).
    await expect(appBar.getByTestId('app-bar-path').locator('bdi')).toHaveText([folder]);
    await appBar.getByRole('button', { name: 'Open Navigation' }).tap();
    await expect(row(page, title)).toHaveAttribute('aria-level', '2');
    await page.getByRole('button', { name: 'Close Navigation' }).tap();
    await expect(drawer).toBeHidden();

    await page.getByTestId('app-bar').getByRole('button', { name: 'Search Notes' }).tap();
    const search = page.getByRole('dialog', { name: 'Search' });
    await expect(search).toBeVisible();
    await search.getByRole('button', { name: 'Close Search' }).tap();
    await expect(search).toBeHidden();
    expect(errors).toEqual([]);
  });
});
