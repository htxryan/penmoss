// PEN-174: `app layout`, the main window's layout as the page records it (ac6, ac7). The page
// records one as it starts, then one 500 ms after each change that differs from the last: the
// sidebar collapsed to its rail, expanded and dragged wider, the note panel closed and opened,
// Full Width, the theme's mode and the tabs. A change that records its own command or setting
// still records it, before the layout. Settings → Privacy → View Analytics Data then lists them.
// The stand-in Mac's analytics (support/fake-bridge.ts) keep the record in the page.
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { collectErrors, holdForProof } from './support/app';

const RUN = `l${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
const FIRST = `Layout One ${RUN}`;
const SECOND = `Layout Two ${RUN}`;

test.use({
  seed: {
    name: 'Notes',
    notes: [
      { title: FIRST, markdown: 'The first note.' },
      { title: SECOND, markdown: 'The second note.' },
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
    .map(({ kind, name, props }) => ({ kind, name, props: props }));
}

const layouts = async (page: Page) =>
  (await recorded(page)).filter((event) => event.kind === 'app' && event.name === 'layout');

/**
 * Runs `change`, then waits for the one `app layout` it records, with `expected` among its props;
 * no second one follows. Answers the record's events from before the change to that layout.
 */
async function expectLayout(
  page: Page,
  change: () => Promise<void>,
  expected: Record<string, unknown>,
): Promise<Recorded[]> {
  const before = (await recorded(page)).length;
  const newLayouts = async () =>
    (await recorded(page))
      .slice(before)
      .filter((event) => event.kind === 'app' && event.name === 'layout');
  await change();
  await expect
    .poll(async () => (await newLayouts()).at(-1)?.props, { timeout: 5_000 })
    .toMatchObject(expected);
  // Settled: no second one follows.
  await page.waitForTimeout(800);
  expect(await newLayouts()).toHaveLength(1);
  return (await recorded(page)).slice(before);
}

const note = (page: Page, title: string) =>
  page.getByTestId('note-list').getByRole('link', { name: title, exact: true });

test('the main window records its layout as it starts and after each change', async ({ page }) => {
  test.setTimeout(90_000);
  const errors = collectErrors(page);
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto('/');
  await note(page, FIRST).click();
  await expect(page.getByTestId('note-view')).toHaveAttribute('data-ready', 'true');

  // At the start: the main window, its sidebar shown with its width, no Full Width, one tab.
  await expect
    .poll(async () => (await layouts(page)).slice(-1)[0]?.props, { timeout: 10_000 })
    .toMatchObject({
      window: 'main',
      sidebar: 'shown',
      sidebarWidth: expect.any(Number),
      fullWidth: false,
      themeMode: 'system',
      tabs: '1',
    });
  const start = (await layouts(page)).slice(-1)[0]!.props;
  expect((start.sidebarWidth as number) % 10).toBe(0);
  expect(start.sidebarWidth).toBeGreaterThan(150);

  // The sidebar to its rail: the command first, then the layout, with no width.
  const collapse = await expectLayout(page, () => page.getByTestId('toggle-sidebar').click(), {
    sidebar: 'rail',
  });
  expect(collapse.map((event) => `${event.kind} ${event.name}`)).toEqual([
    'command app.toggleSidebar',
    'app layout',
  ]);
  expect((await layouts(page)).slice(-1)[0]!.props).not.toHaveProperty('sidebarWidth');
  await expectLayout(page, () => page.getByTestId('toggle-sidebar').click(), {
    sidebar: 'shown',
    sidebarWidth: start.sidebarWidth,
  });

  // Dragged wider by its edge, a rem at a time: one layout once it settles.
  const edge = page.getByTestId('sidebar-resizer');
  await expectLayout(
    page,
    async () => {
      await edge.focus();
      for (let step = 0; step < 4; step++) await page.keyboard.press('ArrowRight');
    },
    { sidebar: 'shown' },
  );
  const wider = (await layouts(page)).slice(-1)[0]!.props.sidebarWidth as number;
  expect(wider).toBeGreaterThan(start.sidebarWidth as number);

  // The note's panel closed, then opened on its Metadata tab.
  const panelNow = (await layouts(page)).slice(-1)[0]!.props.panel;
  if (panelNow === 'open') {
    await expectLayout(page, () => page.getByTestId('note-panel-close').click(), {
      panel: 'closed',
    });
  }
  await expectLayout(page, () => page.getByTestId('note-tab-info').click(), { panel: 'open' });
  await expectLayout(page, () => page.getByTestId('note-panel-close').click(), {
    panel: 'closed',
  });

  // Full Width, from the note's bar: its own event first.
  const full = await expectLayout(page, () => page.getByTestId('toggle-full-width').click(), {
    fullWidth: true,
  });
  expect(full.findIndex((event) => event.kind === 'app')).toBe(full.length - 1);

  // A second tab (⌘-click in the tree): two tabs, as a bucket.
  await expectLayout(page, () => note(page, SECOND).click({ modifiers: ['ControlOrMeta'] }), {
    tabs: '2–4',
  });

  // The theme to Dark in Settings → Appearance. Settings fills the window: no notes sidebar there,
  // and no note.
  await page.getByTestId('sidebar-settings').click();
  await page
    .getByRole('navigation', { name: /settings sections/i })
    .getByRole('link', {
      name: 'Appearance',
    })
    .click();
  const dark = await expectLayout(
    page,
    () => page.getByTestId('theme-mode').getByText('Dark', { exact: true }).click(),
    { themeMode: 'dark', sidebar: 'hidden', panel: 'none' },
  );
  const setting = dark.findIndex(
    (event) => event.kind === 'setting' && event.name === 'theme.mode',
  );
  expect(setting).toBeGreaterThanOrEqual(0);
  expect(setting).toBeLessThan(dark.findIndex((event) => event.kind === 'app'));

  // Every layout recorded passes core's check, as main stores it.
  for (const event of await layouts(page)) {
    expect(Object.keys(event.props).sort()).toEqual(
      expect.arrayContaining(['fullWidth', 'panel', 'sidebar', 'themeMode', 'window']),
    );
  }

  // Privacy → View Analytics Data lists them, newest first, waiting to be sent.
  await page
    .getByRole('navigation', { name: /settings sections/i })
    .getByRole('link', {
      name: 'Privacy',
      exact: true,
    })
    .click();
  await page.getByRole('link', { name: /View Analytics Data/ }).click();
  await expect(page).toHaveURL(/\/settings\/privacy\/data$/);
  const data = page.getByTestId('analytics-data');
  const rows = data.getByTestId('analytics-data-row');
  const layoutRow = rows.filter({ hasText: 'layout' }).first();
  await expect(layoutRow).toBeVisible();
  await expect(layoutRow).toContainText('themeMode');
  await expect(layoutRow).toContainText('dark');
  await expect(layoutRow).toContainText('Waiting to Send');
  await data.getByRole('heading', { level: 1 }).scrollIntoViewIfNeeded();
  await page.mouse.move(0, 0);
  await holdForProof(page, 2_000);
  await expect(layoutRow).toBeVisible();
  expect(errors).toEqual([]);
});
