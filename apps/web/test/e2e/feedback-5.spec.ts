import { expect, test, type Page } from './fixtures';
import { storedSetting } from './stored';

// Ryan's feedback of 5 Nov 2026 ("Penmoss Feedback 2026-11-05", Personal), in the web app (the
// Mac app runs the same page), T62 and D53: a notebook's page readable and the Primary Notebook
// chosen there (items 1, 9); the sidebar's title rows shaded, a notebook's row shading whole and
// no gap between notebooks (2, 3, 8); pinned metadata and the Metadata tab without Saved (4, 5);
// notes among folders in Manual order (6); Send Feedback's own icon (7); ← Notes to the last
// note in any notebook (10); a picture as tall as itself (12); Rename in a note's menu (13).
// Item 11 (the ⋯ menu's choices in Settings → Display) is in feedback-3.spec.ts.

const SHOTS = process.env['PENMOSS_EVIDENCE'];
const ULID = /\/notes\/([0-9A-HJKMNP-TV-Z]{26})$/;

test.use({
  seed: {
    name: 'Quanta',
    folders: ['Substation', 'Geotech'],
    notes: [{ title: 'Alpha' }, { title: 'Penmoss Feedback' }],
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

const sidebar = (page: Page) => page.locator('#app-sidebar');
const section = (page: Page, name: string) =>
  page.getByTestId('source-section').and(page.getByRole('region', { name, exact: true }));
const tree = (page: Page, name: string) =>
  section(page, name).getByRole('tree', { name: 'Folders and notes' });
const background = (page: Page, selector: string) =>
  page
    .locator(selector)
    .first()
    .evaluate((element) => getComputedStyle(element).backgroundColor);

async function openNote(page: Page, notebook: string, title: string): Promise<string> {
  await tree(page, notebook).getByRole('link', { name: title, exact: true }).click();
  await expect(page).toHaveURL(ULID);
  await expect(page.getByTestId('note-title')).toHaveValue(title);
  return ULID.exec(new URL(page.url()).pathname)![1]!;
}

test('1, 9: a notebook’s page reads on the page’s own background; the Primary Notebook is chosen there', async ({
  page,
  host,
}) => {
  test.setTimeout(120_000);
  const errors = collectErrors(page);
  await host.seed({ name: 'Personal', notes: [{ title: 'Test' }] });
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.goto('/settings/git-notebooks');
  const settings = page.getByTestId('git-notebooks-settings');
  const rows = settings.getByTestId('git-notebook-row');
  await expect(rows).toHaveCount(2);
  // The first notebook added is the primary one until another is chosen.
  await expect(rows.filter({ hasText: 'Quanta' }).getByTestId('git-row-primary')).toBeVisible();
  await expect(rows.filter({ hasText: 'Personal' }).getByTestId('git-row-primary')).toHaveCount(0);

  await rows.filter({ hasText: 'Personal' }).click();
  const page1 = settings.getByTestId('git-notebook');
  await expect(page1.getByRole('heading', { level: 2 })).toHaveText('Personal');
  // No card: the page's background shows through, and its groups have headings of their own.
  expect(await page1.evaluate((element) => getComputedStyle(element).backgroundColor)).toBe(
    'rgba(0, 0, 0, 0)',
  );
  expect(await page1.evaluate((element) => getComputedStyle(element).borderTopWidth)).toBe('0px');
  await expect(page1.getByRole('heading', { level: 3 })).toHaveText([
    'About',
    'Primary Notebook',
    'Sync',
    'Commits',
    'Access',
    'Agent Activity',
  ]);
  // Commits' fields are one width, one under the other.
  const name = await page1.getByTestId('git-author-name').boundingBox();
  const email = await page1.getByTestId('git-author-email').boundingBox();
  expect(Math.round(name!.width)).toBe(Math.round(email!.width));
  expect(email!.y).toBeGreaterThan(name!.y);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/git-notebook-page.png`, fullPage: true });

  await page1.getByTestId('git-make-primary').click();
  await expect(page1.getByTestId('git-primary-chip')).toHaveText('Primary Notebook');
  await expect(page1.getByTestId('git-primary-state')).toContainText('your primary notebook');
  await expect(page1.getByTestId('git-make-primary')).toHaveCount(0);
  // Daily Notes no longer chooses it, and says where it is chosen.
  await page.goto('/settings/journal');
  await expect(page.getByTestId('journal-notebook')).toHaveCount(0);
  await expect(page.getByTestId('journal-settings')).toContainText('Primary Notebook');
  // Today's note goes to it.
  await page.goto('/');
  await page.locator('button[data-command="journal.today"]').first().click();
  await expect(page).toHaveURL(ULID);
  const today = ULID.exec(new URL(page.url()).pathname)![1]!;
  await expect(tree(page, 'Personal').locator(`a[href="/notes/${today}"]`)).toBeVisible();
  await expect(tree(page, 'Quanta').locator(`a[href="/notes/${today}"]`)).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('2, 3, 8, 7: title rows shaded, a notebook’s row shading whole, no gap between notebooks, Feedback’s own icon', async ({
  page,
  host,
}) => {
  test.setTimeout(120_000);
  const errors = collectErrors(page);
  await host.seed({ name: 'Personal', notes: [{ title: 'Test' }] });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/');
  await expect(tree(page, 'Personal').getByRole('treeitem', { name: 'Test' })).toBeVisible({
    timeout: 30_000,
  });

  // 2: Notebooks' title row is shaded; a notebook's own row is not.
  const head = await background(page, '[data-section="notebooks"] .sb-part-head');
  const notebookHead = await background(page, '.sb-source > .sb-section-head');
  expect(head).not.toBe('rgba(0, 0, 0, 0)');
  expect(notebookHead).toBe('rgba(0, 0, 0, 0)');

  // 3: the pointer on a notebook's row shades the whole row, buttons and dot included, and a
  // button under the pointer stands out from it.
  const row = section(page, 'Quanta').locator('.sb-section-head').first();
  await row.locator('.sb-notebook-name').hover();
  const rowBox = (await row.boundingBox())!;
  const shaded = await row.evaluate((element) => getComputedStyle(element).backgroundColor);
  expect(shaded).not.toBe('rgba(0, 0, 0, 0)');
  const sideBox = (await sidebar(page).boundingBox())!;
  expect(rowBox.x + rowBox.width).toBeGreaterThan(sideBox.x + sideBox.width - 2);
  const button = row.locator('.tree-actions .icon-btn').first();
  await button.hover();
  const buttonShade = await button.evaluate((element) => getComputedStyle(element).backgroundColor);
  expect(buttonShade).not.toBe('rgba(0, 0, 0, 0)');
  expect(buttonShade).not.toBe(shaded);
  if (SHOTS) await sidebar(page).screenshot({ path: `${SHOTS}/sidebar.png` });

  // 8: the next notebook's row follows the last row closely.
  const last = (await tree(page, 'Quanta').getByRole('treeitem').last().boundingBox())!;
  const next = (await section(page, 'Personal').locator('.sb-section-head').boundingBox())!;
  expect(next.y - (last.y + last.height)).toBeLessThan(20);

  // 7: Send Feedback's icon is not the comments' bubble.
  await openNote(page, 'Quanta', 'Alpha');
  const feedback = await page
    .getByTestId('sidebar-feedback')
    .locator('svg')
    .evaluate((svg) => svg.innerHTML);
  const comments = await page
    .getByTestId('note-tab-comments')
    .locator('svg')
    .evaluate((svg) => svg.innerHTML);
  expect(feedback).not.toBe(comments);
  expect(errors).toEqual([]);
});

test('4, 5: metadata pinned under the title and in the status bar; the Metadata tab without Saved', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await openNote(page, 'Quanta', 'Alpha');
  await page.getByTestId('note-body').locator('.ProseMirror').click();
  await page.keyboard.type('Three more words');
  const bar = page.getByTestId('status-bar');
  // Unset: the counts, as before.
  await expect(bar.getByTestId('note-counts')).toContainText('3 words');
  await expect(page.getByTestId('pinned-metadata')).toHaveCount(0);

  // 5 and 4: no Saved row; Length is Words, Characters and Reading Time.
  if (!(await page.getByTestId('note-info').isVisible())) {
    await page.getByTestId('note-tab-info').click();
  }
  const details = page.getByTestId('note-details');
  for (const name of ['Words', 'Characters', 'Reading Time']) {
    await expect(details.locator('dt', { hasText: name })).toHaveCount(1);
  }
  await expect(details).not.toContainText('Saved');
  await expect(details).not.toContainText('Length');
  await expect(page.getByTestId('info-words')).toHaveText('3');

  // Settings → Display pins Edited and Tags under the title, and Edited in the status bar for
  // the counts.
  await page.goto('/settings/display');
  await page.getByTestId('metadata-title-edited').check();
  await page.getByTestId('metadata-title-tags').check();
  await page.getByTestId('metadata-status-edited').check();
  for (const field of ['words', 'characters', 'reading']) {
    await page.getByTestId(`metadata-status-${field}`).uncheck();
  }
  // The status bar offers no Tags: they are edited.
  await expect(page.getByTestId('metadata-status-tags')).toHaveCount(0);
  await expect.poll(() => storedSetting(page, 'metadata.underTitle')).toEqual(['edited', 'tags']);
  await expect.poll(() => storedSetting(page, 'metadata.statusBar')).toEqual(['edited']);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/display-metadata.png`, fullPage: true });

  await page.goto('/');
  await openNote(page, 'Quanta', 'Alpha');
  const pinned = page.getByTestId('pinned-metadata');
  await expect(pinned.locator('[data-field="edited"]')).toContainText('Edited');
  // Its tags with + under the title: a tag added there is the note's.
  await pinned.getByRole('button', { name: 'Add a Tag', exact: true }).click();
  await page.keyboard.type('pinned');
  await page.keyboard.press('Enter');
  await expect(pinned.locator('.tag-chip[data-tag="pinned"]')).toBeVisible();
  await expect(bar.getByTestId('note-counts')).toContainText('Edited');
  await expect(bar.getByTestId('note-counts')).not.toContainText('words');
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/pinned-metadata.png` });
  expect(errors).toEqual([]);
});

test('6: in Manual order a note goes above or between folders, and stays there', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/');
  const quanta = tree(page, 'Quanta');
  const names = () =>
    quanta.getByRole('treeitem').evaluateAll((rows) => rows.map((row) => row.ariaLabel));
  await expect.poll(names).toEqual(['Substation', 'Geotech', 'Alpha', 'Penmoss Feedback']);
  // Alt+↑ on the first note steps it past the last folder, then past the first.
  await quanta.getByRole('treeitem', { name: 'Alpha', exact: true }).focus();
  await page.keyboard.press('Alt+ArrowUp');
  await expect.poll(names).toEqual(['Substation', 'Alpha', 'Geotech', 'Penmoss Feedback']);
  await page.keyboard.press('Alt+ArrowUp');
  await expect.poll(names).toEqual(['Alpha', 'Substation', 'Geotech', 'Penmoss Feedback']);
  // A note dropped on a folder's lower edge goes below it.
  const feedback = quanta.getByRole('treeitem', { name: 'Penmoss Feedback', exact: true });
  const substation = quanta.getByRole('treeitem', { name: 'Substation', exact: true });
  const box = (await substation.boundingBox())!;
  await feedback.dragTo(substation, {
    targetPosition: { x: box.width / 2, y: box.height - 2 },
  });
  await expect.poll(names).toEqual(['Alpha', 'Substation', 'Penmoss Feedback', 'Geotech']);
  // Kept after a reload.
  await page.reload();
  await expect.poll(names).toEqual(['Alpha', 'Substation', 'Penmoss Feedback', 'Geotech']);
  if (SHOTS) await sidebar(page).screenshot({ path: `${SHOTS}/manual-order.png` });
  expect(errors).toEqual([]);
});

test('10: ← Notes from Settings returns to the last note, in whichever notebook', async ({
  page,
  host,
}) => {
  test.setTimeout(120_000);
  const errors = collectErrors(page);
  await host.seed({ name: 'Personal', notes: [{ title: 'Test' }] });
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/');
  await expect(tree(page, 'Personal').getByRole('treeitem', { name: 'Test' })).toBeVisible({
    timeout: 30_000,
  });
  // A note in the notebook that is not the primary one.
  const id = await openNote(page, 'Personal', 'Test');
  await page.getByTestId('sidebar-settings').click();
  await expect(page).toHaveURL(/\/settings/);
  await page.getByRole('link', { name: 'Notes', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/notes/${id}$`));
  await expect(page.getByTestId('note-title')).toHaveValue('Test');
  expect(errors).toEqual([]);
});

test('12, 13: a picture’s line is as tall as the picture; Rename in a note’s menu', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/');
  await openNote(page, 'Quanta', 'Alpha');
  await page.getByTestId('note-body').locator('.ProseMirror').click();
  await page.keyboard.type('Line above');
  await page.keyboard.press('Enter');
  await page.evaluate(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 200;
    canvas.height = 100;
    const context = canvas.getContext('2d')!;
    context.fillStyle = '#3f7d4e';
    context.fillRect(0, 0, 200, 100);
    const blob = await new Promise<Blob>((resolve) =>
      canvas.toBlob((made) => resolve(made!), 'image/png'),
    );
    const transfer = new DataTransfer();
    transfer.items.add(new File([blob], 'Shot.png', { type: 'image/png' }));
    const editor = document.querySelector<HTMLElement>('[data-testid="note-body"] .ProseMirror')!;
    editor.focus();
    editor.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }),
    );
  });
  const picture = page.locator('.pm-image img');
  await expect(picture).toBeVisible();
  // Its paragraph is the picture's height: no empty line above or below it.
  const heights = await picture.evaluate((img) => [
    img.getBoundingClientRect().height,
    img.closest('p')!.getBoundingClientRect().height,
  ]);
  expect(Math.abs(heights[1]! - heights[0]!)).toBeLessThan(1);
  // The cursor still reaches the end of its line: End, then Enter, starts a line below it.
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Line below');
  const lines = await page
    .getByTestId('note-body')
    .locator('.ProseMirror > p')
    .evaluateAll((paragraphs) =>
      paragraphs.map((p) => (p.querySelector('.pm-image') ? '[picture]' : p.textContent)),
    );
  expect(lines).toEqual(['Line above', '[picture]', 'Line below']);

  // 13: Rename from a note's menu edits its title in its row.
  const quanta = tree(page, 'Quanta');
  await quanta.getByRole('treeitem', { name: 'Penmoss Feedback', exact: true }).click({
    button: 'right',
  });
  await page.getByTestId('note-menu-rename').click();
  const field = page.getByRole('textbox', { name: 'Rename note Penmoss Feedback' });
  await expect(field).toBeFocused();
  await field.fill('Feedback, renamed');
  await page.keyboard.press('Enter');
  await expect(
    quanta.getByRole('treeitem', { name: 'Feedback, renamed', exact: true }),
  ).toBeVisible();
  await openNote(page, 'Quanta', 'Feedback, renamed');
  // Escape leaves a title as it was.
  await quanta.getByRole('treeitem', { name: 'Alpha', exact: true }).click({ button: 'right' });
  await page.getByTestId('note-menu-rename').click();
  await page.keyboard.type('Nope');
  await page.keyboard.press('Escape');
  await expect(quanta.getByRole('treeitem', { name: 'Alpha', exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});
