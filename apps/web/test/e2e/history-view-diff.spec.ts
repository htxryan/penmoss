import { expect, type Page, seeded, test } from './fixtures';
import { asAgent, syncNow } from './support/sync';
import { collectErrors } from './support/app';

// History's View in Diff (A1572, amended): the changed blocks, each with 3 of the same around it,
// a fold for the rest that opens on a click; Full File every block; each side's blocks numbered
// by their lines in the markdown; the version's short commit over the left side; the line
// between the sides' names and the one between the sides one line, with a scrollbar beside them.

const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
/** Where to save the screenshots, when a run asks for them. */
const SHOTS = process.env['PENMOSS_HISTORY_VIEW_SHOTS'];

const panel = (page: Page) => page.getByTestId('history-panel');
const view = (page: Page) => page.getByRole('dialog', { name: /^Version of / });
const side = (page: Page, which: 'left' | 'right') => page.getByTestId(`history-view-${which}`);

/** A note of 30 short paragraphs, `Point 1.` to `Point 30.`, the nth on line 2n + 3. */
const POINTS = Array.from({ length: 30 }, (_, i) => `Point ${i + 1}.`).join('\n\n');

test.use({
  seed: { name: 'Notes', notes: [{ title: 'Long', markdown: `${POINTS}\n` }] },
  // Scrollbars that take room, as on a Mac with a mouse: headless Chromium hides them.
  launchOptions: { ignoreDefaultArgs: ['--hide-scrollbars'] },
});

test('Diff shows the changes with context and folds, Full File every block, lines numbered', async ({
  page,
  host,
  notebook,
}) => {
  test.setTimeout(150_000);
  const errors = collectErrors(page);
  const { remote, noteIds } = seeded(notebook);
  const id = noteIds[0]!;
  // An agent changes two points far apart: 10 and 25.
  await asAgent(host, remote, `Claude ${RUN}`, (local) => {
    for (const [find, replace] of [
      ['Point 10.', 'Point ten.'],
      ['Point 25.', 'Point twenty-five.'],
    ] as const) {
      local.edit(id, { op: 'replace', find, replace, all: false, scope: 'markdown' }, null);
    }
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/notes/${id}`);
  await expect(page.getByTestId('note-view')).toHaveAttribute('data-ready', 'true');
  await page.getByTestId('note-tab-history').click();
  const rows = panel(page).getByRole('list', { name: 'Versions' }).locator('.history-entry');
  await expect(async () => {
    await syncNow(page);
    await expect(rows).toHaveCount(2, { timeout: 2_000 });
  }).toPass({ timeout: 40_000 });

  // The note as seeded, beside now, in Diff: each change with 3 blocks either side.
  await rows.last().click();
  await panel(page).getByRole('button', { name: 'View This Version' }).click();
  await expect(view(page)).toBeVisible();
  const toggle = view(page).getByTestId('history-view-mode');
  await expect(toggle).toHaveAccessibleName('Show Full File');
  await expect(toggle).toHaveAttribute('data-tip', 'Show Full File');
  const folds = view(page).getByTestId('history-view-fold');
  // The title (line 2) to Point 6 (15), Point 14 (31) to 21 (45), Point 29 (61) to 30 (63).
  await expect(folds).toHaveText([
    '⋯ 14 unchanged lines',
    '⋯ 15 unchanged lines',
    '⋯ 3 unchanged lines',
  ]);
  const points = (which: 'left' | 'right') => side(page, which).locator('p');
  await expect(points('left')).toHaveCount(14);
  await expect(points('right')).toHaveCount(14);
  await expect(points('left').first()).toHaveText('Point 7.');
  await expect(side(page, 'left')).not.toContainText('Point 1.');
  await expect(side(page, 'left').locator('[data-change="removed"]')).toHaveText([
    'Not in now: Point 10.',
    'Not in now: Point 25.',
  ]);
  // Each side numbers its blocks by their lines in the markdown: Point n on line 2n + 3.
  const numbers = (which: 'left' | 'right') => side(page, which).getByTestId('history-view-line');
  const hunks = [7, 8, 9, 10, 11, 12, 13, 22, 23, 24, 25, 26, 27, 28].map((n) => `${2 * n + 3}`);
  await expect(numbers('left')).toHaveText(hunks);
  await expect(numbers('right')).toHaveText(hunks);
  // Each number on its block's first line, the two sides level.
  const [leftNumber, leftBlock, rightBlock] = await Promise.all([
    numbers('left').first().boundingBox(),
    points('left').first().boundingBox(),
    points('right').first().boundingBox(),
  ]);
  expect(leftNumber!.x + leftNumber!.width).toBeLessThan(leftBlock!.x);
  const firstLine = await points('left')
    .first()
    .evaluate((element) => parseFloat(getComputedStyle(element).lineHeight));
  // On the same line as the block's text: their baselines meet.
  const baseline = (element: HTMLElement) => {
    const probe = document.createElement('span');
    probe.style.display = 'inline-block';
    element.prepend(probe);
    const y = probe.getBoundingClientRect().bottom;
    probe.remove();
    return y;
  };
  const [numberLine, blockLine] = await Promise.all([
    numbers('left').first().evaluate(baseline),
    points('left').first().evaluate(baseline),
  ]);
  expect(Math.abs(numberLine - blockLine)).toBeLessThan(1);
  expect(leftNumber!.y).toBeGreaterThan(leftBlock!.y);
  expect(leftNumber!.y + leftNumber!.height).toBeLessThan(leftBlock!.y + firstLine);
  // Each side in its own half, either side of the line between them.
  const [leftSide, rightSide, middle] = await Promise.all([
    side(page, 'left').boundingBox(),
    side(page, 'right').boundingBox(),
    view(page).locator('.history-view-grid > .history-view-divider').boundingBox(),
  ]);
  expect(leftSide!.x + leftSide!.width).toBeLessThanOrEqual(middle!.x + 0.5);
  expect(rightSide!.x).toBeGreaterThanOrEqual(middle!.x);
  expect(Math.abs(leftBlock!.y - rightBlock!.y)).toBeLessThan(1);

  // The version's commit, short, over the left side; a click copies it.
  const sha = view(page).getByTestId('history-view-sha');
  await expect(sha).toHaveText(/^[0-9a-f]{7}$/);
  await expect(sha).toHaveAttribute('data-tip', 'Copy Commit SHA');
  await expect(sha).toHaveCSS('font-family', /mono|Menlo|Monaco|Courier/i);
  await expect(view(page).getByTestId('history-view-sides-head')).toContainText(
    (await sha.textContent())! + '·',
  );
  await sha.click();
  await expect(panel(page).getByTestId('history-status')).toContainText('commit SHA');

  // A fold opens on a click: the first's blocks show, the others stay folded.
  await folds.first().click();
  await expect(folds).toHaveText(['⋯ 15 unchanged lines', '⋯ 3 unchanged lines']);
  await expect(points('left')).toHaveCount(20);
  await expect(points('left').first()).toHaveText('Point 1.');
  await expect(side(page, 'left').locator('h1')).toHaveText('Long');
  await expect(numbers('left').first()).toHaveText('2');
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/history-view-diff.png` });

  // Full File: every block, no folds.
  await toggle.click();
  await expect(toggle).toHaveAccessibleName('Show Diff');
  await expect(folds).toHaveCount(0);
  await expect(points('left')).toHaveCount(30);
  await expect(points('right')).toHaveCount(30);
  await expect(numbers('right').last()).toHaveText('63');

  // The line between the sides' names and the one between the sides are one, to half a pixel,
  // with a scrollbar beside them, at any width.
  const scroll = view(page).getByTestId('history-view-scroll');
  const bar = () =>
    scroll.evaluate((element: HTMLElement) => element.offsetWidth - element.clientWidth);
  expect(await bar()).toBeGreaterThan(0);
  expect(await scroll.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(
    true,
  );
  const dividers = async () => {
    const [head, body] = await Promise.all([
      view(page)
        .getByTestId('history-view-sides-head')
        .locator('.history-view-divider')
        .boundingBox(),
      view(page).locator('.history-view-grid > .history-view-divider').boundingBox(),
    ]);
    return Math.abs(head!.x - body!.x);
  };
  for (const width of [1440, 1180, 1013]) {
    await page.setViewportSize({ width, height: 900 });
    await expect.poll(dividers).toBeLessThanOrEqual(0.5);
  }
  // Scrolled, the sides' names stay over them.
  await scroll.evaluate((element) => element.scrollBy(0, 600));
  await expect.poll(dividers).toBeLessThanOrEqual(0.5);
  await page.setViewportSize({ width: 1440, height: 900 });

  // The agent's version is the note now: one placeholder in the middle of the view, in Full File
  // and in Diff alike, with no sides and no toggle.
  const empty = view(page).getByTestId('history-view-no-changes');
  const placeholder = async () => {
    await expect(empty.getByRole('heading', { name: 'No Changes' })).toBeVisible();
    await expect(empty).toContainText('is the same as the note is now');
    await expect(empty).toContainText(/[0-9a-f]{7}, /);
    await expect(toggle).toHaveCount(0);
    await expect(side(page, 'left')).toHaveCount(0);
    await expect(side(page, 'right')).toHaveCount(0);
    await expect(view(page).getByTestId('history-view-sides-head')).toHaveCount(0);
    const [box, area] = await Promise.all([
      empty.locator('h2').boundingBox(),
      scroll.boundingBox(),
    ]);
    expect(Math.abs(box!.x + box!.width / 2 - (area!.x + area!.width / 2))).toBeLessThan(2);
    expect(Math.abs(box!.y + box!.height / 2 - (area!.y + area!.height / 2))).toBeLessThan(48);
  };
  await rows.first().click();
  await placeholder();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/history-view-same.png` });
  // Another version keeps the choice; Diff shows the same placeholder.
  await rows.last().click();
  await expect(toggle).toHaveAccessibleName('Show Diff');
  await expect(points('left')).toHaveCount(30);
  await toggle.click();
  await expect(toggle).toHaveAccessibleName('Show Full File');
  await rows.first().click();
  await placeholder();
  await rows.last().click();

  // This device remembers it: Full File again, after a reload.
  await toggle.click();
  await expect(toggle).toHaveAccessibleName('Show Diff');
  await page.reload();
  await expect(page.getByTestId('note-view')).toHaveAttribute('data-ready', 'true');
  if (!(await panel(page).isVisible())) await page.getByTestId('note-tab-history').click();
  await rows.last().click();
  await panel(page).getByRole('button', { name: 'View This Version' }).click();
  await expect(toggle).toHaveAccessibleName('Show Diff');
  await expect(folds).toHaveCount(0);
  expect(errors).toEqual([]);
});
