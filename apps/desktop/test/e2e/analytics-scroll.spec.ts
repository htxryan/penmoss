import { expect, test, type Locator, type Page } from '@playwright/test';
import {
  analyticsEnv,
  fakeAnalytics,
  sendNow,
  type FakeAnalytics,
  type WireEvent,
} from './fake-analytics';
import {
  bareRepository,
  body,
  firstRunName,
  firstRunPasteUrl,
  gitNotebook,
  go,
  holdForProof,
  launch,
  mainBounds,
  removeDataDirs,
  ULID,
  type Launched,
} from './support';

// PEN-175 in the Mac app. The first run's last step lists how far you scroll under What Is
// Recorded (ac9). Then, with a notebook: a long note, the sidebar's folder tree and Settings →
// Appearance scrolled each record `scroll <area>` with the position in hundredths once the
// scrolling settles (ac6, ac10); Note Actions (the note's ⋯) records its own id, not the retired
// `menu.open` (ac4); Settings → Quick Capture → Show in the Menu Bar turned off records the
// switch's click and main's `setting menuBar.icon` (ac13). Main's check takes them, so they reach
// the endpoint (ac8), and Settings → Privacy → View Analytics Data lists them, where it ends.

const mac = process.platform === 'darwin';
const RUN = `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
const NEW_NOTE = mac ? 'Meta+Alt+KeyN' : 'Alt+KeyN';
/** The consent list's line for the window and scrolling (core's consent.recorded.3). */
const SCROLL_LINE =
  'The app’s and the system’s versions, the window’s size and layout, and how far you scroll';
/**
 * The area scrolling the folder tree records as (core's SCROLL_NAMES). In a window taller than
 * 54rem the notebooks' trees scroll by themselves (A521), as `sidebar.folders`; this spec's
 * window is 1000 px tall for that.
 */
const TREE_AREA = 'sidebar.folders';

const opened: Launched[] = [];
const endpoints: FakeAnalytics[] = [];

test.afterEach(async () => {
  for (const { app } of opened.splice(0)) await app.close().catch(() => undefined);
  for (const endpoint of endpoints.splice(0)) await endpoint.close();
});
test.afterAll(() => removeDataDirs());

async function endpoint(): Promise<FakeAnalytics> {
  const started = await fakeAnalytics();
  endpoints.push(started);
  return started;
}

interface Recorded {
  readonly id: number;
  readonly kind: string;
  readonly name: string;
  readonly props: Readonly<Record<string, unknown>>;
}

/** The record on this Mac, oldest first. */
async function record(page: Page): Promise<Recorded[]> {
  const { events } = await page.evaluate(() =>
    window.penmossDesktop!.analytics!.page({ limit: 1000 }),
  );
  return (events as unknown as Recorded[]).slice().sort((a, b) => a.id - b.id);
}

/** The positions `scroll <area>` has recorded, oldest first. */
const positions = async (page: Page, area: string) =>
  (await record(page))
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
 * Scrolls the area around `over` with the mouse's wheel, as a trackpad would, towards whichever
 * end it is further from (the app may have scrolled it already: typing a long note follows the
 * caret, opening a note shows its row). Then waits for its `scroll <area>` event, one more than
 * before, at the position it came to rest: its offset over its range, in hundredths (ac6).
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
  const down = start.top < start.range / 2;
  const box = (await over.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + Math.min(box.height / 2, 200));
  for (let step = 0; step < 4; step++) {
    await page.mouse.wheel(0, down ? 250 : -250);
    await page.waitForTimeout(60);
  }
  await expect
    .poll(async () => Math.abs((await placeOf(over)).top - start.top))
    .toBeGreaterThan(40);
  await expect
    .poll(async () => {
      const recorded = await positions(page, area);
      const { top, range } = await placeOf(over);
      return recorded.length > before && recorded.at(-1) === Math.round((top / range) * 100) / 100;
    })
    .toBe(true);
  expectPosition((await positions(page, area)).at(-1));
}

/** A position as core sends it: 0–1, in whole hundredths. */
function expectPosition(value: unknown) {
  expect(typeof value).toBe('number');
  const position = value as number;
  expect(position).toBeGreaterThanOrEqual(0);
  expect(position).toBeLessThanOrEqual(1);
  expect(Math.round(position * 100)).toBeCloseTo(position * 100, 6);
}

async function newNote(page: Page, title: string, text?: string): Promise<void> {
  await expect(page.locator('button[data-command="note.new"]').first()).toBeVisible();
  await page.keyboard.press(NEW_NOTE);
  await expect(page).toHaveURL(ULID);
  await expect(page.getByTestId('note-title')).toBeFocused();
  await page.keyboard.type(title);
  if (text === undefined) return;
  await page.keyboard.press('Enter');
  await page.keyboard.type(text);
  await expect(body(page)).toContainText(text.split('\n').at(-1)!);
}

test('the first run’s last step lists how far you scroll under What Is Recorded (ac9)', async () => {
  test.setTimeout(180_000);
  const fake = await endpoint();
  const launched = await launch({ analytics: 'ask', env: analyticsEnv(fake) });
  opened.push(launched);
  const { app, page } = launched;
  await mainBounds(app, { x: 0, y: 0, width: 1280, height: 720 });

  // First Run C: Paste a URL, then Name Your Notebook; set up and synced, the usage question.
  await firstRunPasteUrl(page, `file://${bareRepository()}`);
  await firstRunName(page, 'Notes');
  const consent = page.getByTestId('first-run').getByTestId('first-run-consent');
  await expect(consent).toBeVisible({ timeout: 60_000 });
  await expect(consent.locator('.fr-step')).toHaveText('Last Step');
  await expect(consent.getByRole('heading', { name: 'What Is Recorded' })).toBeVisible();
  const recorded = consent.getByTestId('consent-recorded');
  const line = recorded.getByText(SCROLL_LINE, { exact: true });
  await line.scrollIntoViewIfNeeded();
  await expect(line).toBeInViewport();
  await expect(consent.getByRole('heading', { name: 'What Is Recorded' })).toBeInViewport();
  await page.mouse.move(0, 0);
  await holdForProof(page);
  // Still unanswered, and the line in view as the recording ends.
  await expect(consent).toBeVisible();
  await expect(line).toBeInViewport();
});

test('scrolling the note, the folder tree and Settings, Note Actions and the menu bar icon reach Analytics Data (ac4, ac8, ac10, ac13)', async () => {
  test.setTimeout(300_000);
  const fake = await endpoint();
  const launched = await launch({ analytics: 'yes', env: analyticsEnv(fake) });
  opened.push(launched);
  const { app, page } = launched;
  // Taller than 54rem, so the folder tree scrolls by itself, not the sidebar as one (A521).
  await mainBounds(app, { x: 0, y: 0, width: 1280, height: 1000 });
  await gitNotebook(launched);

  // Enough notes that the sidebar's folder tree runs past its foot, then a long note, open.
  for (let n = 1; n <= 18; n++) await newNote(page, `Row ${String(n).padStart(2, '0')} ${RUN}`);
  await newNote(
    page,
    `Long ${RUN}`,
    Array.from({ length: 60 }, (_, n) => `Line ${n + 1} of a long note.`).join('\n'),
  );
  await expect(page.getByTestId('note-view')).toHaveAttribute('data-ready', 'true');

  // Note Actions, the note's ⋯: its own id (ac4).
  await page.getByTestId('note-menu').click();
  const menu = page.getByRole('menu', { name: 'Note Actions' });
  await expect(menu).toBeVisible();
  await holdForProof(page, 1_000);
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await expect
    .poll(async () =>
      (await record(page)).filter((event) => event.kind === 'click').map((event) => event.name),
    )
    .toContain('note.actions.open');
  expect((await record(page)).map((event) => `${event.kind} ${event.name}`)).not.toContain(
    'click menu.open',
  );

  // The note scrolled: `scroll note` once it settles, its position in hundredths (ac6, ac10).
  await scrollArea(page, page.getByTestId('note-scroll'), 'note');
  await holdForProof(page, 1_000);

  // The folder tree scrolled by itself, the sidebar's list staying where it is.
  const listTop = () => page.locator('nav.sb-list').evaluate((list) => list.scrollTop);
  const listBefore = await listTop();
  // The wheel over the notebooks' body, the trees' own scroller, not a tree's rows (whose box
  // runs past the part of them in view).
  await scrollArea(page, page.locator('.sb-notebooks-body'), TREE_AREA);
  expect(await listTop()).toBe(listBefore);
  await holdForProof(page, 1_000);

  // Settings → Quick Capture → Show in the Menu Bar, off: the switch's click, then main records
  // the setting once the icon is gone (ac13).
  await go(page, '/settings/quick-capture');
  const menuBarIcon = page.getByTestId('menu-bar-icon');
  await expect(menuBarIcon).toBeChecked();
  await expect(menuBarIcon).toBeEnabled();
  await menuBarIcon.uncheck();
  await expect(menuBarIcon).not.toBeChecked();
  await expect(menuBarIcon).toBeEnabled();
  await expect
    .poll(async () =>
      (await record(page))
        .filter(
          (event) =>
            (event.kind === 'setting' && event.name === 'menuBar.icon') ||
            (event.kind === 'click' && event.name === 'settings.menu-bar-icon'),
        )
        .map((event) => ({ kind: event.kind, props: event.props })),
    )
    .toEqual(
      expect.arrayContaining([
        { kind: 'click', props: { state: 'off' } },
        { kind: 'setting', props: { value: false } },
      ]),
    );
  await holdForProof(page, 1_000);

  // Settings → Appearance scrolled.
  await go(page, '/settings/appearance');
  await expect(page.getByTestId('theme-mode')).toBeVisible();
  await scrollArea(page, page.locator('.settings-content'), 'settings');
  await holdForProof(page, 1_000);

  // Sent as recorded: main's check took them, from the Mac (ac8).
  const sent = (events: readonly WireEvent[]) =>
    events.map((event) => `${event.kind} ${event.name}`);
  await expect
    .poll(
      async () => {
        await sendNow(app);
        return sent(fake.events());
      },
      { timeout: 30_000, intervals: [500, 1000, 2000] },
    )
    .toEqual(
      expect.arrayContaining([
        'scroll note',
        `scroll ${TREE_AREA}`,
        'scroll settings',
        'click note.actions.open',
        'click settings.menu-bar-icon',
        'setting menuBar.icon',
      ]),
    );
  expect(sent(fake.events())).not.toContain('click menu.open');
  for (const event of fake.events().filter((each) => each.kind === 'scroll')) {
    expect(event.client).toBe('mac');
    expect(Object.keys(event.props)).toEqual(['position']);
    expectPosition(event.props['position']);
  }
  expect(
    fake.events().find((event) => event.kind === 'setting' && event.name === 'menuBar.icon')?.props,
  ).toEqual({ value: false });

  // Settings → Privacy → View Analytics Data: the scroll rows, Note Actions' click and the menu
  // bar icon's setting beside its switch's click, newest first, where it ends.
  await go(page, '/settings/privacy');
  await page.getByRole('link', { name: /View Analytics Data/ }).click();
  await expect(page).toHaveURL(/\/settings\/privacy\/data$/);
  const data = page.getByTestId('analytics-data');
  await expect(data.getByRole('heading', { level: 1 })).toHaveText('Analytics Data');
  const rows = data.getByTestId('analytics-data-row');
  const rowOf = (kind: string, name: string) =>
    rows
      .filter({ has: page.locator('td:nth-child(3)', { hasText: new RegExp(`^${kind}$`) }) })
      .filter({
        has: page.locator('td:nth-child(4)', {
          hasText: new RegExp(`^${name.replaceAll('.', '\\.')}$`),
        }),
      })
      .first();
  const noteRow = rowOf('scroll', 'note');
  const treeRow = rowOf('scroll', TREE_AREA);
  const settingsRow = rowOf('scroll', 'settings');
  const actionsRow = rowOf('click', 'note.actions.open');
  const settingRow = rowOf('setting', 'menuBar.icon');
  const switchRow = rowOf('click', 'settings.menu-bar-icon');
  for (const scrolled of [noteRow, treeRow, settingsRow]) {
    await expect(scrolled).toBeVisible();
    await expect(scrolled.locator('td:nth-child(5)')).toHaveText(/^position: (0|1)(\.\d{1,2})?$/);
  }
  await expect(settingRow.locator('td:nth-child(5)')).toHaveText('value: false');
  await expect(switchRow.locator('td:nth-child(5)')).toHaveText('state: off');
  await expect(actionsRow).toBeVisible();
  // The oldest of them, Note Actions' click, at the foot of the window: the rest above it.
  await actionsRow.evaluate((row) => row.scrollIntoView({ block: 'end' }));
  await page.mouse.move(0, 0);
  for (const row of [noteRow, treeRow, settingsRow, actionsRow, settingRow, switchRow])
    await expect(row).toBeInViewport();
  await holdForProof(page);
  for (const row of [noteRow, treeRow, settingsRow, actionsRow, settingRow, switchRow])
    await expect(row).toBeInViewport();
});
