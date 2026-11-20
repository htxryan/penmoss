// PEN-175: `scroll <area>`, how far down each scrolled area is, as the page records it (ac6,
// ac10). A long note, the sidebar's folder tree and Settings → Appearance are each
// scrolled with the mouse's wheel; once each settles, one `scroll <area>` is recorded with the
// position in hundredths, where it came to rest. Settings → Privacy → View Analytics Data then
// lists them. The stand-in Mac's analytics (support/fake-bridge.ts) keep the record in the page.
import type { Locator, Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { collectErrors, holdForProof } from './support/app';

const RUN = `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
const LONG = `Long Note ${RUN}`;
const FOLDERS = ['Garden', 'Kitchen', 'Reading', 'Travel', 'Work'];

test.use({
  seed: {
    name: 'Notes',
    folders: FOLDERS,
    notes: [
      {
        title: LONG,
        markdown: Array.from(
          { length: 80 },
          (_, line) => `Paragraph ${line + 1} of a note long enough to scroll.`,
        ).join('\n\n'),
      },
      // Enough rows that the notebooks' trees scroll by themselves in a 1000 px window.
      ...FOLDERS.flatMap((folder) =>
        Array.from({ length: 6 }, (_, each) => ({ title: `${folder} ${each + 1}`, folder })),
      ),
    ],
  },
  analytics: { consent: 'yes' },
});

interface Recorded {
  readonly kind: string;
  readonly name: string;
  readonly props: Record<string, unknown>;
}

/** What the page has recorded so far, oldest first. */
async function recorded(page: Page): Promise<Recorded[]> {
  const fake = await page.evaluate(() => window.__penmossFakeAnalytics!);
  return [...fake.events]
    .sort((a, b) => a.id - b.id)
    .map(({ kind, name, props }) => ({ kind, name, props }));
}

/** The positions `scroll <area>` has recorded, oldest first. */
const positions = async (page: Page, area: string) =>
  (await recorded(page))
    .filter((event) => event.kind === 'scroll' && event.name === area)
    .map((event) => event.props['position']);

/** Where whatever scrolls around `over` is: its offset, and how far it can scroll. */
const placeOf = (over: Locator) =>
  over.evaluate((element) => {
    let up: Element | null = element;
    for (; up; up = up.parentElement) {
      const { overflowY } = getComputedStyle(up);
      if ((overflowY === 'auto' || overflowY === 'scroll') && up.scrollHeight > up.clientHeight)
        break;
    }
    const scroller = up ?? document.scrollingElement!;
    return { top: scroller.scrollTop, range: scroller.scrollHeight - scroller.clientHeight };
  });

/**
 * Scrolls the area around `over` with the mouse's wheel, as a trackpad would, then waits for its
 * new `scroll <area>`, at the position it came to rest: its offset over its range, in
 * hundredths. Nothing follows it.
 */
async function scrollArea(page: Page, over: Locator, area: string): Promise<void> {
  // Laid out: its length holds still (a page's preview and pictures come in after it).
  let range = -1;
  await expect
    .poll(
      async () => {
        const last = range;
        range = (await placeOf(over)).range;
        return range === last;
      },
      { intervals: [500], timeout: 10_000 },
    )
    .toBe(true);
  const before = (await positions(page, area)).length;
  const start = await placeOf(over);
  expect(start.range, `${area} can scroll`).toBeGreaterThan(40);
  const box = (await over.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + Math.min(box.height / 2, 200));
  for (let step = 0; step < 4; step++) {
    await page.mouse.wheel(0, 150);
    await page.waitForTimeout(40);
  }
  await expect
    .poll(async () => (await placeOf(over)).top - start.top, { timeout: 5_000 })
    .toBeGreaterThan(40);
  // Once it comes to rest (the wheel scrolls smoothly), the last event is where it rests. A
  // slow machine may pause the wheel's scroll long enough to settle on the way: one more, then.
  await expect
    .poll(
      async () => {
        const { top, range: now } = await placeOf(over);
        const recorded = (await positions(page, area)).slice(before);
        return recorded.length > 0 && recorded.at(-1) === Math.round((top / now) * 100) / 100;
      },
      { timeout: 5_000 },
    )
    .toBe(true);
  // Settled: nothing more follows.
  const settled = (await positions(page, area)).length;
  expect(settled - before).toBeLessThanOrEqual(2);
  await page.waitForTimeout(1_200);
  expect(await positions(page, area)).toHaveLength(settled);
}

test('a note, the folder tree and a Settings page each record how far down they are scrolled', async ({
  page,
}) => {
  test.setTimeout(90_000);
  const errors = collectErrors(page);
  // Taller than 54rem, where the notebooks' trees scroll by themselves (A521).
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.goto('/');
  // Every folder open, so the trees run past their room.
  for (const folder of FOLDERS) {
    const row = page.getByRole('treeitem', { name: folder, exact: true });
    if ((await row.getAttribute('aria-expanded')) !== 'true') await row.click();
    await expect(row).toHaveAttribute('aria-expanded', 'true');
  }
  await page.getByTestId('note-list').getByRole('link', { name: LONG, exact: true }).click();
  await expect(page.getByTestId('note-view')).toHaveAttribute('data-ready', 'true');
  await expect(page.getByTestId('note-scroll')).toContainText('Paragraph 80');

  // The note.
  await scrollArea(page, page.getByTestId('note-scroll'), 'note');

  // The folder tree, which scrolls by itself, the sidebar's list staying where it is. Opening
  // the note brought its row into view, at the tree's foot: it starts again from its top, and
  // that settles before the wheel starts.
  const trees = page.locator('.sb-notebooks-body');
  await trees.evaluate((element) => element.scrollTo({ top: 0 }));
  await page.waitForTimeout(1_500);
  const list = page.locator('nav.sb-list');
  const listTop = await list.evaluate((element) => element.scrollTop);
  await scrollArea(page, trees, 'sidebar.folders');
  expect(await list.evaluate((element) => element.scrollTop)).toBe(listTop);
  expect(await positions(page, 'sidebar')).toEqual([]);

  // Settings → Appearance, its page scrolled on its own beside the list of pages.
  await page.getByTestId('sidebar-settings').click();
  await page
    .getByRole('navigation', { name: /settings sections/i })
    .getByRole('link', { name: 'Appearance' })
    .click();
  await expect(page).toHaveURL(/\/settings\/appearance$/);
  await scrollArea(page, page.locator('.settings-content'), 'settings');

  // Each passes core's check as main stores it: only `position`, 0–1 in hundredths.
  const scrolls = (await recorded(page)).filter((event) => event.kind === 'scroll');
  // (Opening the note brought its row into view, a scroll the app made, recorded too.)
  expect([...new Set(scrolls.map((event) => event.name))].sort()).toEqual([
    'note',
    'settings',
    'sidebar.folders',
  ]);
  /** Each area's last position: its newest row in Analytics Data. */
  const lastOf = (area: string) => scrolls.filter((event) => event.name === area).at(-1)!.props;
  for (const { props } of scrolls) {
    expect(Object.keys(props)).toEqual(['position']);
    const position = props['position'] as number;
    expect(position).toBeGreaterThanOrEqual(0);
    expect(position).toBeLessThanOrEqual(1);
    expect(Math.round(position * 100)).toBeCloseTo(position * 100, 6);
  }

  // Privacy → View Analytics Data lists them, waiting to be sent.
  await page
    .getByRole('navigation', { name: /settings sections/i })
    .getByRole('link', { name: 'Privacy', exact: true })
    .click();
  await page.getByRole('link', { name: /View Analytics Data/ }).click();
  await expect(page).toHaveURL(/\/settings\/privacy\/data$/);
  const rows = page.getByTestId('analytics-data').getByTestId('analytics-data-row');
  const rowOf = (name: string) =>
    rows
      .filter({ has: page.locator('td:nth-child(3)', { hasText: /^scroll$/ }) })
      .filter({
        has: page.locator('td:nth-child(4)', {
          hasText: new RegExp(`^${name.replace('.', '\\.')}$`),
        }),
      })
      .first();
  for (const area of ['note', 'sidebar.folders', 'settings']) {
    const row = rowOf(area);
    await expect(row).toBeVisible();
    await expect(row.locator('td:nth-child(5)')).toHaveText(
      `position: ${String(lastOf(area)['position'])}`,
    );
    await expect(row).toContainText('Waiting to Send');
  }
  await rowOf('note').scrollIntoViewIfNeeded();
  await page.mouse.move(0, 0);
  await holdForProof(page, 2_000);
  for (const area of ['note', 'sidebar.folders', 'settings'])
    await expect(rowOf(area)).toBeInViewport();
  expect(errors).toEqual([]);
});
