import { expect, test, type Page } from './fixtures';
import { SLOW_SHELL_MS } from './support/git-host';

// Ryan's feedback of 6 Nov 2026 ("Quanta Penmoss Feedback 2", Quanta), T65, in the web app (the
// Mac app runs the same page): the sidebar's bottom row's buttons flush (item 1, A1121); a
// folder's row with New Note alone on hover (2, A1120); no tooltip on a note's row (3, A1119);
// the sidebar and the note's panel resized by their edges (4, A1122); Settings → Agents with the
// command's card at once, and a list of notebooks opening pages (5, A1124, A1125); a note's top
// bar dragging the window while the note is scrolled (6, A1123).

const SHOTS = process.env['PENMOSS_EVIDENCE'];
const ULID = /\/notes\/([0-9A-HJKMNP-TV-Z]{26})$/;
const LONG = Array.from({ length: 80 }, (_, n) => `Line ${n + 1} of a long note.`).join('\n\n');

test.use({
  seed: {
    name: 'Quanta',
    folders: ['Miscellaneous'],
    notes: [{ title: 'Josh Onboarding' }, { title: 'Long', markdown: `${LONG}\n` }],
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

test('1: Settings and Send Feedback sit flush in the sidebar’s bottom row, square, the row’s height', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');
  await expect(tree(page)).toBeVisible({ timeout: 30_000 });
  const foot = await box(page, '.sb-foot');
  const sidebar = await box(page, '.sidebar');
  const settings = await box(page, '[data-testid="sidebar-settings"]');
  const feedback = await box(page, '[data-testid="sidebar-feedback"]');
  // Square, as tall as the row under its top border, no gap between them or at the row's ends.
  for (const button of [settings, feedback]) {
    expect(button.width).toBeCloseTo(button.height, 0);
    expect(button.y).toBeCloseTo(foot.y + 1, 0);
    expect(button.y + button.height).toBeCloseTo(foot.y + foot.height, 0);
  }
  expect(settings.x).toBeCloseTo(sidebar.x, 0);
  expect(feedback.x).toBeCloseTo(settings.x + settings.width, 0);
  await page.getByTestId('sidebar-feedback').hover();
  if (SHOTS) {
    await page.screenshot({
      path: `${SHOTS}/sidebar-foot.png`,
      clip: { x: sidebar.x, y: foot.y - 40, width: sidebar.width, height: foot.height + 40 },
    });
  }
  expect(errors).toEqual([]);
});

test('2 and 3: a folder’s row shows New Note alone on hover; a note’s row has no tooltip', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');
  const folder = tree(page).getByRole('treeitem', { name: 'Miscellaneous', exact: true });
  await expect(folder).toBeVisible({ timeout: 30_000 });
  await folder.hover();
  const actions = folder.locator('.row-actions');
  await expect(actions).toBeVisible();
  await expect(actions.getByRole('button')).toHaveCount(1);
  await expect(actions.getByRole('button', { name: 'New Note in Miscellaneous' })).toBeVisible();
  if (SHOTS) await folder.screenshot({ path: `${SHOTS}/folder-row.png` });
  // Rename and Delete stay in its menu.
  await folder.click({ button: 'right' });
  const menu = page.getByRole('menu', { name: 'Folder Miscellaneous' });
  await expect(menu.getByRole('menuitem', { name: 'Rename' })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: 'Delete Folder…' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();

  // A note's row: no tooltip, however long the pointer rests on it.
  const note = tree(page).getByRole('treeitem', { name: 'Josh Onboarding', exact: true });
  await expect(note).not.toHaveAttribute('data-tip');
  await note.hover();
  await page.waitForTimeout(1500);
  await expect(page.getByTestId('tooltip')).toBeHidden();
  if (SHOTS) {
    const rows = await tree(page).boundingBox();
    if (rows) await page.screenshot({ path: `${SHOTS}/note-row-hover.png`, clip: rows });
  }
  expect(errors).toEqual([]);
});

test('4: the sidebar and the note’s panel are resized by their edges, within limits, and kept', async ({
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
  // Never wider than 30rem, nor narrower than 15.5rem (13rem, then 14.5rem: PEN-135 item 8).
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
  expect(await width('.sidebar')).toBeCloseTo(15.5 * 16, 0);
  // From the keyboard: → a rem wider, End the widest, a double-click back to the first width.
  await edge.focus();
  await page.keyboard.press('ArrowRight');
  expect(await width('.sidebar')).toBeCloseTo(16.5 * 16, 0);
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Shift+ArrowRight');
  expect(await width('.sidebar')).toBeCloseTo(21.5 * 16, 0);
  await page.reload();
  await expect(sidebar).toBeVisible();
  await expect.poll(() => width('.sidebar')).toBeCloseTo(21.5 * 16, 0);
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

test('5: Settings → Agents shows the command’s card at once, and its notebooks as a list', async ({
  page,
  host,
}) => {
  const errors = collectErrors(page);
  await page.goto('/settings/agents');
  const agents = page.getByTestId('agents-settings');
  const card = agents.getByTestId('git-cli');
  // At once, though the login shell takes 3 s to say its PATH the first time.
  await expect(card).toBeVisible({ timeout: 1000 });
  await expect(card.getByRole('heading', { name: 'The penmoss Command' })).toBeVisible();
  await expect(agents.getByTestId('agents-notebook-row')).toHaveCount(1);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/agents-list.png` });
  await expect(card.getByTestId('git-cli-state')).toHaveText(/^Not installed\./, {
    timeout: SLOW_SHELL_MS + 5000,
  });
  // The PATH is kept: next time, the card is whole at once.
  await page.reload();
  await expect(page.getByTestId('git-cli-state')).toHaveText(/^Not installed\./, {
    timeout: 1000,
  });

  // A notebook's agents, on a page of its own.
  await agents.getByTestId('agents-notebook-row').click();
  await expect(page).toHaveURL(/\/settings\/agents\/[0-9A-Z]{26}$/);
  const notebook = agents.getByTestId('notebook-agents');
  await expect(notebook.getByRole('heading', { level: 2 })).toHaveText('Quanta');
  await expect(notebook).toContainText('penmoss mcp --notebook Quanta');
  await expect(notebook.getByTestId('git-local-agents')).toBeVisible();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/agents-notebook.png` });
  // Its git notebook page links here, and here back to it.
  await notebook.getByTestId('agents-notebook-git').click();
  await expect(page).toHaveURL(/\/settings\/git-notebooks\/[0-9A-Z]{26}$/);
  await page.getByTestId('git-notebook-agents-link').click();
  await expect(page).toHaveURL(/\/settings\/agents\/[0-9A-Z]{26}$/);
  await page.getByTestId('agents-back').click();
  await expect(page).toHaveURL(/\/settings\/agents$/);
  void host;
  expect(errors).toEqual([]);
});

/**
 * The region Electron gives a point (A723, A1123): of the elements with one there, the last in
 * the DOM wins, as later regions are applied over earlier ones.
 */
const regionAt = (page: Page, x: number, y: number) =>
  page.evaluate(
    ([px, py]) => {
      let won = 'none';
      for (const element of document.querySelectorAll<HTMLElement>('body *')) {
        const style = getComputedStyle(element);
        const value = style.getPropertyValue('-webkit-app-region');
        if (value !== 'drag' && value !== 'no-drag') continue;
        if (style.visibility !== 'visible') continue;
        const at = element.getBoundingClientRect();
        if (px >= at.left && px < at.right && py >= at.top && py < at.bottom) won = value;
      }
      return won;
    },
    [x, y] as const,
  );

test('6: a scrolled note’s top bar still drags the Mac window by its empty part', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await page.setViewportSize({ width: 1400, height: 800 });
  await page.goto('/');
  await openNote(page, 'Long');
  // The Mac app's compact title bar, as mac-window.ts sets it.
  await page.evaluate(() => (document.documentElement.dataset['titlebar'] = 'compact'));
  const bar = await box(page, '.note-top');
  const actions = await box(page, '.note-top .note-actions');
  const crumbs = await box(page, '.note-top .crumbs li[aria-current="page"]');
  const text = await box(page, '.note-body');
  // Over the text's column, past the breadcrumb's words and short of the buttons: the bar's
  // empty part, where the title and the text pass under it.
  const empty = { x: text.x + text.width / 2, y: bar.y + bar.height / 2 };
  expect(empty.x).toBeGreaterThan(crumbs.x + crumbs.width);
  expect(empty.x).toBeLessThan(actions.x);
  const words = { x: crumbs.x + 4, y: empty.y };
  expect(await regionAt(page, empty.x, empty.y)).toBe('drag');

  // Scrolled: the title and the text go up under the bar, which still drags; its buttons click.
  // The text scrolls in its own column since A1132.
  const scroller = page.getByTestId('note-scroll');
  await scroller.evaluate((element) => (element.scrollTop = 900));
  await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBe(900);
  expect(await box(page, '.note-top')).toEqual(bar);
  const under = await box(page, '.note-body .ProseMirror');
  expect(under.y).toBeLessThan(bar.y);
  expect(under.x).toBeLessThan(empty.x);
  expect(under.x + under.width).toBeGreaterThan(empty.x);
  expect(await regionAt(page, empty.x, empty.y)).toBe('drag');
  expect(await regionAt(page, words.x, words.y)).toBe('drag');
  expect(await regionAt(page, actions.x + 10, empty.y)).toBe('no-drag');
  // The editor's own surfaces stay clickable over the bar: the selection toolbar is one.
  expect(
    await page.evaluate(() => {
      const probe = document.createElement('div');
      probe.setAttribute('role', 'toolbar');
      const button = document.createElement('button');
      probe.append(button);
      document.querySelector('.note-columns')!.append(probe);
      const regions = [probe, button].map((element) =>
        getComputedStyle(element).getPropertyValue('-webkit-app-region'),
      );
      probe.remove();
      return regions;
    }),
  ).toEqual(['no-drag', 'no-drag']);
  expect(errors).toEqual([]);
});
