// The note column, its width and scrolling, the status bar and the panes beside it.
import { expect, type GitHost, type Page, seeded, test } from './fixtures';
import { body, collectErrors, newNote, ULID } from './support/app';
import { FULL_WIDTH, LINE_END, SELECT_TO_LINE_START } from './keys';
import { storedSetting } from './stored';
import { readRemote } from './support/remote';

const RUN = `f${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;

/**
 * Waits until this device's stored workspace holds full width as `full`. A page that goes
 * (reload, navigation) right after a change keeps only what was stored, and a reload reads the
 * stored copy first (A624): a change written a moment after the click can otherwise be lost.
 */
async function widthStored(page: Page, full: boolean) {
  await expect.poll(() => storedSetting(page, 'note.fullWidth'), { timeout: 10_000 }).toBe(full);
}

/** The notebook's remote never holds the note's width: it is this device's own (A1626). */
async function widthNotSynced(host: GitHost, remote: string) {
  expect((await readRemote(host, remote)).setting('note.fullWidth')).toBeUndefined();
}

const docWidth = (page: Page) =>
  page.locator('.doc:not([hidden])').evaluate((element) => element.getBoundingClientRect().width);

// T41.
test('the note column: 52rem by default, the full window when asked, remembered', async ({
  page,
  host,
  notebook,
}) => {
  test.setTimeout(150_000);
  const errors = collectErrors(page);
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.goto('/');
  const id = await newNote(page, `Width ${RUN}`, 'A line of text. '.repeat(40));
  // The side panel closed, whichever tab it shows (T51, A936), so the column has the room.
  const closePanel = page.getByTestId('note-panel-close');
  if (await closePanel.isVisible()) await closePanel.click();
  await expect(page.locator('.note-columns')).toHaveAttribute('data-panel', 'closed');
  await expect(
    page.getByRole('tablist', { name: 'Note panel' }).getByRole('tab', { selected: true }),
  ).toHaveCount(0);
  const toggle = page.getByTestId('toggle-full-width');
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  // 52rem of text plus 3rem gutters either side (A500).
  expect(await docWidth(page)).toBe(58 * 16);
  try {
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('note-view')).toHaveAttribute('data-width', 'full');
    const main = await page
      .locator('.note-main')
      .evaluate((element) => element.getBoundingClientRect().width);
    // The whole pane but the panel's strip of tab icons at its right edge (T53 item 9).
    const strip = await page
      .getByTestId('note-rail')
      .evaluate((element) => element.getBoundingClientRect().width);
    expect(strip).toBeGreaterThan(0);
    expect(await docWidth(page)).toBeGreaterThan(main - strip - 20);

    // This device's own: after a reload and in Settings → Note, never in the notebook's remote.
    await widthStored(page, true);
    await widthNotSynced(host, seeded(notebook).remote);
    await page.reload();
    await expect(page.getByTestId('note-view')).toHaveAttribute('data-width', 'full');
    await page.goto('/settings/note');
    const setting = page.getByTestId('note-width-setting');
    await expect(setting.getByRole('radio', { name: /Full Window/ })).toBeChecked();
    // The segmented control's radios are hidden behind their labels: choose as a person would.
    await setting.locator('label', { hasText: 'The Theme’s' }).click();
    await expect(setting.getByRole('radio', { name: /The Theme’s/ })).toBeChecked();
    await widthStored(page, false);
    await page.goBack();
    await expect(page.getByTestId('note-view')).toHaveAttribute('data-ready', 'true');
    await expect(page.getByTestId('note-view')).not.toHaveAttribute('data-width', 'full');

    // Its shortcut, from the note's body.
    await body(page).click();
    await page.keyboard.press(FULL_WIDTH);
    await expect(page.getByTestId('note-view')).toHaveAttribute('data-width', 'full');
    await page.keyboard.press(FULL_WIDTH);
    await expect(page.getByTestId('note-view')).not.toHaveAttribute('data-width', 'full');
  } finally {
    // Off again. A step that failed in Settings left the note: back to it, so the toggle is
    // there to press.
    if (!(await toggle.isVisible())) await page.goto(`/notes/${id}`);
    if ((await toggle.getAttribute('aria-pressed')) === 'true') await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await widthNotSynced(host, seeded(notebook).remote);
  }
  expect(errors).toEqual([]);
});

// T41.
test('the status bar: save status, counts, and the selection’s counts', async ({ page, host }) => {
  test.setTimeout(120_000);
  const errors = collectErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await newNote(page, `Status ${RUN}`, 'one two three four five');
  const bar = page.getByTestId('status-bar');
  await expect(bar).toBeVisible();
  await expect(bar.getByTestId('save-status')).toHaveAttribute('data-state', 'synced', {
    timeout: 40_000,
  });
  // A git notebook's words (A860): saved here, and pushed to git.
  await expect(bar.getByTestId('save-status')).toContainText('Saved · in git');
  // Routine saving and syncing is not read out; only states that need attention are.
  await expect(bar.getByTestId('save-status')).not.toHaveAttribute('role', /.+/);
  await expect(bar.getByTestId('save-alert')).toHaveText('');
  await expect(bar.getByTestId('note-counts')).toContainText('5 words');
  await expect(bar.getByTestId('note-counts')).toContainText('23 characters');
  await expect(bar.getByTestId('note-counts')).toContainText('1 min read');

  await page.keyboard.type(' six');
  await expect(bar.getByTestId('note-counts')).toContainText('6 words');
  // A selection's counts replace the note's while it lasts.
  await page.keyboard.press(SELECT_TO_LINE_START);
  await expect(bar.getByTestId('selection-counts')).toHaveText(
    '6 words and 27 characters selected',
  );
  await page.keyboard.press(LINE_END);
  await expect(bar.getByTestId('selection-counts')).toHaveCount(0);

  // Offline, the note is saved here and waits. A remote on this Mac needs no network (#174
  // review): git's goes too, so the push fails as it would.
  await page.context().setOffline(true);
  host.network = 'down';
  await page.keyboard.type(' seven');
  await expect(bar.getByTestId('save-status')).toHaveAttribute('data-state', 'offline', {
    timeout: 40_000,
  });
  await expect(bar.getByTestId('save-alert')).toHaveText('');
  host.network = 'up';
  await page.context().setOffline(false);
  await expect(bar.getByTestId('save-status')).toHaveAttribute('data-state', 'synced', {
    timeout: 60_000,
  });
  expect(errors.filter((e) => !/ERR_INTERNET_DISCONNECTED|WebSocket/.test(e))).toEqual([]);
});

const SHOTS = process.env['PENMOSS_EVIDENCE'];

const LONG = Array.from({ length: 80 }, (_, n) => `Line ${n + 1} of a long note.`).join('\n\n');

const tree = (page: Page) =>
  page
    .getByTestId('source-section')
    .and(page.getByRole('region', { name: 'Quanta', exact: true }))
    .getByRole('tree', { name: 'Folders and notes' });

async function openNote(page: Page, title: string): Promise<void> {
  await tree(page).getByRole('link', { name: title, exact: true }).click();
  await expect(page).toHaveURL(ULID);
  await expect(page.getByTestId('note-title')).toHaveValue(title);
}

const box = async (page: Page, selector: string) =>
  (await page.locator(selector).first().boundingBox())!;
test.describe('in Quanta, with a folder and a long note', () => {
  test.use({
    seed: {
      name: 'Quanta',
      folders: ['Miscellaneous'],
      notes: [{ title: 'Josh Onboarding' }, { title: 'Long', markdown: `${LONG}\n` }],
    },
  });

  // T65, item 4.
  test('the sidebar and the note’s panel are resized by their edges, within limits, and kept', async ({
    page,
  }) => {
    const errors = collectErrors(page);
    await page.setViewportSize({ width: 1600, height: 900 });
    await page.goto('/');
    await openNote(page, 'Josh Onboarding');
    const sidebar = page.locator('.sidebar');
    const width = async (selector: string) => (await box(page, selector)).width;
    expect(await width('.sidebar')).toBeCloseTo(17 * 16, 0);

    // Dragged by its edge: wider, live, and kept.
    const edge = page.getByTestId('sidebar-resizer');
    await expect(edge).toHaveAttribute('role', 'separator');
    const at = await edge.boundingBox();
    const y = at!.y + 300;
    const x = at!.x + at!.width / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 60, y, { steps: 4 });
    await page.mouse.move(x + 100, y, { steps: 4 });
    expect(await width('.sidebar')).toBeCloseTo(17 * 16 + 100, 0);
    await page.mouse.up();
    await expect(edge).toHaveAttribute('aria-valuenow', String(17 + 100 / 16));
    // Never wider than 30rem, nor narrower than 14.5rem (13rem until PEN-135 item 8).
    const wide = (await edge.boundingBox())!;
    await page.mouse.move(wide.x + 3, y);
    await page.mouse.down();
    await page.mouse.move(wide.x + 600, y, { steps: 6 });
    await page.mouse.up();
    expect(await width('.sidebar')).toBeCloseTo(30 * 16, 0);
    const widest = (await edge.boundingBox())!;
    await page.mouse.move(widest.x + 3, y);
    await page.mouse.down();
    await page.mouse.move(widest.x - 600, y, { steps: 6 });
    await page.mouse.up();
    expect(await width('.sidebar')).toBeCloseTo(14.5 * 16, 0);
    // From the keyboard: → a rem wider, End the widest, a double-click back to the first width.
    await edge.focus();
    await page.keyboard.press('ArrowRight');
    expect(await width('.sidebar')).toBeCloseTo(15.5 * 16, 0);
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Shift+ArrowRight');
    expect(await width('.sidebar')).toBeCloseTo(20.5 * 16, 0);
    await page.reload();
    await expect(sidebar).toBeVisible();
    await expect.poll(() => width('.sidebar')).toBeCloseTo(20.5 * 16, 0);
    await page.getByTestId('sidebar-resizer').dblclick();
    await expect.poll(() => width('.sidebar')).toBeCloseTo(17 * 16, 0);

    // The panel: dragged left from its edge, wider; never so wide the note has under 34rem.
    const side = page.locator('.note-side');
    if (!(await side.isVisible())) await page.getByTestId('note-tab-info').click();
    await expect(side).toBeVisible();
    await expect(page.locator('.note-columns')).not.toHaveAttribute('data-over', '');
    expect(await width('.note-side')).toBeCloseTo(26 * 16, 0);
    const panelEdge = page.getByTestId('panel-resizer');
    const pe = (await panelEdge.boundingBox())!;
    await page.mouse.move(pe.x + pe.width / 2, pe.y + 200);
    await page.mouse.down();
    await page.mouse.move(pe.x + pe.width / 2 - 96, pe.y + 200, { steps: 6 });
    await page.mouse.up();
    expect(await width('.note-side')).toBeCloseTo(26 * 16 + 96, 0);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/resized.png` });
    const pe2 = (await panelEdge.boundingBox())!;
    await page.mouse.move(pe2.x + 3, pe2.y + 200);
    await page.mouse.down();
    await page.mouse.move(pe2.x - 900, pe2.y + 200, { steps: 8 });
    await page.mouse.up();
    const pane = await width('.note-main');
    // As wide as leaves the note its 34rem (the pane less the panel and the tab strip), and still beside it.
    expect(await width('.note-side')).toBeLessThanOrEqual(pane - 34 * 16 + 1);
    expect(await width('.note-side')).toBeGreaterThan(26 * 16 + 96);
    await expect(page.locator('.note-columns')).not.toHaveAttribute('data-over', '');
    await page.reload();
    await expect(page.locator('.note-side')).toBeVisible();
    const kept = await width('.note-side');
    expect(kept).toBeGreaterThan(26 * 16 + 96);
    // Narrower, it lies over the text again at the width it was given (capped by the pane).
    await page.setViewportSize({ width: 1000, height: 900 });
    await expect(page.locator('.note-columns')).toHaveAttribute('data-over', '');
    await expect(page.getByTestId('panel-resizer')).toHaveCount(0);
    expect(errors).toEqual([]);
  });
});

const section = (page: Page, name: string) =>
  page.getByTestId('source-section').and(page.getByRole('region', { name, exact: true }));

async function openNoteIn(page: Page, title: string, notebook = 'Quanta'): Promise<void> {
  await section(page, notebook)
    .getByRole('tree', { name: 'Folders and notes' })
    .getByRole('link', { name: title, exact: true })
    .click();
  await expect(page).toHaveURL(ULID);
  await expect(page.getByTestId('note-title')).toHaveValue(title);
}
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

  // T66, items 1, 6.
  test('the note scrolls in its own column, left of the panel; the bars show an arrow', async ({
    page,
  }) => {
    const errors = collectErrors(page);
    await page.setViewportSize({ width: 1400, height: 800 });
    await page.goto('/');
    await openNoteIn(page, 'Long');
    // The panel shows on a wide window; opened if it was closed here before.
    if ((await page.locator('.note-side').count()) === 0) {
      await page.getByRole('tab', { name: 'Metadata' }).click();
    }
    await expect(page.locator('.note-side')).toBeVisible();
    const scroller = page.getByTestId('note-scroll');
    const scroll = await box(page, '[data-testid="note-scroll"]');
    const side = await box(page, '.note-side');
    // The text's scroller ends where the panel starts: its scrollbar is at the text's edge.
    expect(scroll.x + scroll.width).toBeLessThanOrEqual(side.x + 1);
    expect(await scroller.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(
      true,
    );
    // The page itself does not scroll: only the text does.
    expect(
      await page.evaluate(() => document.scrollingElement!.scrollHeight <= window.innerHeight),
    ).toBe(true);
    await scroller.evaluate((element) => (element.scrollTop = 600));
    await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBe(600);
    expect((await box(page, '.note-side')).y).toBe(side.y);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/scroll.png` });

    // Item 6: an arrow over the title bar and the status bar, not the I-beam.
    // The main window's title bar is its tab strip since PEN-140 (A1505), the tab's words where
    // the breadcrumb's were.
    for (const selector of ['.tab-strip', '.tab-strip .tab-title', '.status-bar']) {
      expect(
        await page
          .locator(selector)
          .first()
          .evaluate((element) => getComputedStyle(element).cursor),
      ).toBe('default');
    }
    expect(errors).toEqual([]);
  });
});

async function newNoteFromButton(page: Page, title: string, text = ''): Promise<string> {
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

// T39 pass 1.
test('a long title wraps and stays one line of text', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/');
  const title = `A title ${RUN} long enough to need a second line in the note column, and then some more words so it surely wraps twice`;
  await newNoteFromButton(page, title);
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

// T39 pass 1.
// T41: the Backlinks panel is the Info panel (A502); only its names changed here.
test('the note column keeps its width beside the Info panel', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  const narrow = await newNoteFromButton(page, `Narrow ${RUN}`, 'Short.');
  const wide = await newNoteFromButton(
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
