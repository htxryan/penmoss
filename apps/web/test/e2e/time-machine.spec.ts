import { expect, macContext, PREVIEW, test, type GitHost, type Page } from './fixtures';
import { STORY_AGENT, STORY_DEVICE, timeMachineStory, type Story } from './support/dated-history';

// PEN-21: the Time Machine. A notebook built with known commits on known days, by a device and an
// agent: Thursday 1 October, the device makes Projects, Roadmap in it and Groceries; Tuesday 13
// October, Claude Code adds a line to Roadmap and makes Ideas; Wednesday 14 October, the device
// renames Ideas, moves Roadmap to the top level and puts Groceries in Trash. The page shows the
// right tree and text for a past date, Replay steps through a note's versions in order with their
// writers, and What Changed lists each kind of change for the week of 12 October.

test.use({ seed: null });

const DEVICE = STORY_DEVICE;
const AGENT = STORY_AGENT;

/** The story's notebook, made on an empty remote and added on the stand-in Mac. */
async function story(host: GitHost): Promise<Story> {
  const remote = host.bare();
  const info = await host.add(remote, 'Notes');
  return timeMachineStory(host, remote, { id: info.notebookId, name: 'Notes' });
}

const tree = (page: Page) => page.getByRole('navigation', { name: 'Folders and notes then' });

async function openTimeMachine(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.getByTestId('source-section')).toHaveCount(1);
  // The notebook's own button, on its name's row, goes to its Time Machine.
  await expect(page.getByTestId('section-time-machine')).toHaveAttribute(
    'href',
    /^\/time-machine\?source=/,
  );
  // The command opens the one in use.
  await page.keyboard.press('ControlOrMeta+KeyK');
  const palette = page.getByRole('dialog', { name: 'Command Palette' });
  await palette.getByRole('combobox', { name: 'Command Palette' }).fill('Time Machine');
  await expect(palette.getByRole('option').first()).toContainText('Time Machine');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/time-machine\?source=/);
  await expect(page.getByTestId('tm-then')).toBeVisible();
}

test('shows the notebook’s tree and a note’s text as they were on a past date', async ({
  page,
  host,
}) => {
  test.setTimeout(120_000);
  const { groceries } = await story(host);
  await openTimeMachine(page);
  // Now: Roadmap moved to the top level, Ideas renamed, Groceries in Trash.
  await expect(tree(page).getByRole('button', { name: 'Review ideas' })).toBeVisible();
  await expect(tree(page).getByRole('button', { name: 'Groceries' })).toHaveCount(0);
  // History is read off the page's thread.
  await expect(page.getByTestId('tm-then')).toHaveAttribute('data-where', 'worker');

  // Monday 5 October: the first day's notebook.
  await page.getByLabel('Date', { exact: true }).fill('2026-10-05');
  await expect(page.getByTestId('tm-place')).toContainText('Oct 1, 2026');
  await expect(page.getByTestId('tm-place')).toContainText(DEVICE);
  const projects = tree(page).locator('[data-folder="Projects"]');
  await expect(projects.getByRole('button', { name: 'Roadmap' })).toBeVisible();
  await expect(tree(page).getByRole('button', { name: 'Groceries' })).toBeVisible();
  await expect(tree(page).getByRole('button', { name: /ideas/i })).toHaveCount(0);

  // Roadmap's text then, read-only, without the agent's line; it still exists, so Restore This
  // Version is offered.
  await projects.getByRole('button', { name: 'Roadmap' }).click();
  const text = page.getByTestId('tm-note-text');
  await expect(text).toContainText('Ship the scrubber');
  await expect(text).not.toContainText('Agent added replay');
  await expect(page.getByRole('button', { name: 'Restore This Version' })).toBeVisible();

  // The next commit: the agent's, with its line.
  await page.getByRole('button', { name: 'Later Commit' }).click();
  await expect(page.getByTestId('tm-place')).toContainText(AGENT);
  await expect(text).toContainText('Agent added replay');

  // Back to 5 October: Groceries, deleted since, comes back with Restore Note.
  await page.getByLabel('Date', { exact: true }).fill('2026-10-05');
  await tree(page).getByRole('button', { name: 'Groceries' }).click();
  await expect(text).toContainText('Milk and eggs');
  await expect(page.getByTestId('tm-note')).toContainText('In Trash now');
  await page.getByRole('button', { name: 'Restore Note' }).click();
  await expect(page).toHaveURL(new RegExp(`/notes/${groceries}$`), { timeout: 60_000 });
  await expect(page.getByTestId('note-body').locator('.ProseMirror')).toHaveText('Milk and eggs');
});

test('Replay steps through a note’s versions in order, with who made each', async ({
  page,
  host,
}) => {
  test.setTimeout(120_000);
  const { roadmap } = await story(host);
  await page.goto(`/notes/${roadmap}`);
  await expect(page.getByTestId('note-body').locator('.ProseMirror')).toContainText(
    'Agent added replay',
    { timeout: 30_000 },
  );
  await page.getByTestId('note-tab-history').click();
  const panel = page.getByTestId('history-panel');
  await panel.getByTestId('history-replay-start').click();
  const replay = panel.getByTestId('history-replay');
  const place = replay.getByTestId('replay-place');
  // It plays from the first version: the device's, then the agent's with its line marked.
  await expect(place).toContainText('Version 1 of 2');
  await expect(place).toContainText(DEVICE);
  await expect(replay.getByTestId('replay-text')).toContainText('Ship the scrubber');
  await expect(place).toContainText('Version 2 of 2', { timeout: 5_000 });
  await expect(place).toContainText(AGENT);
  await expect(
    replay
      .getByTestId('replay-text')
      .locator('[data-op="add"] ins', { hasText: 'Agent added replay' }),
  ).toBeVisible();
  // Played to the end, it pauses; a step back and the speed are the person's.
  await expect(replay.getByRole('button', { name: 'Play', exact: true })).toBeVisible();
  await replay.getByRole('button', { name: 'Previous Version' }).click();
  await expect(place).toContainText('Version 1 of 2');
  await replay.getByRole('button', { name: '4×' }).click();
  await expect(replay.getByRole('button', { name: '4×' })).toHaveAttribute('aria-pressed', 'true');
  await replay.getByRole('button', { name: 'Play', exact: true }).click();
  await expect(place).toContainText('Version 2 of 2');
  await expect(place).toContainText(AGENT);
  await page.waitForTimeout(2_000);
});

test('What Changed lists each kind of change in a week, with who and a diff', async ({
  page,
  host,
}) => {
  test.setTimeout(120_000);
  const { roadmap, groceries, ideas } = await story(host);
  await page.goto('/');
  await expect(page.getByTestId('source-section')).toHaveCount(1);

  // A weekly note links to its week's changes, under its title.
  await page.keyboard.press('ControlOrMeta+KeyK');
  const palette = page.getByRole('dialog', { name: 'Command Palette' });
  await palette.getByRole('combobox', { name: 'Command Palette' }).fill("This Week's Note");
  await page.keyboard.press('Enter');
  await page.getByTestId('week-changes').click();
  await expect(page).toHaveURL(/\/time-machine\?source=.*tab=changes&week=\d{4}-W\d{2}/);
  await expect(page.getByTestId('tm-changes')).toBeVisible();

  // The week of Monday 12 October.
  await page.getByLabel('From', { exact: true }).fill('2026-10-12');
  await page.getByLabel('To', { exact: true }).fill('2026-10-18');
  const summary = page.getByTestId('tm-summary');
  await expect(summary).toContainText('3 notes changed in 2 commits');
  await expect(summary).toContainText('Monday 12 October 2026 to Sunday 18 October 2026');
  const list = page.getByRole('list', { name: 'Changed notes' });
  const row = (id: string) => list.locator(`li.tm-change[data-note="${id}"]`);

  await expect(row(ideas)).toHaveAttribute('data-kinds', 'created edited');
  await expect(row(ideas)).toContainText('Review ideas');
  await expect(row(ideas).locator('.history-author')).toContainText([AGENT, DEVICE]);

  await expect(row(roadmap)).toHaveAttribute('data-kinds', 'moved edited');
  await expect(row(roadmap)).toContainText('Moved from Projects');
  await expect(row(roadmap).locator('.history-author[data-kind="agent"]')).toContainText(AGENT);

  await expect(row(groceries)).toHaveAttribute('data-kinds', 'deleted');
  await expect(row(groceries).locator('.history-author')).toHaveText([`Device: ${DEVICE}`]);

  // A rename on its own: the Wednesday alone.
  await page.getByLabel('From', { exact: true }).fill('2026-10-14');
  await page.getByLabel('To', { exact: true }).fill('2026-10-14');
  await expect(row(ideas)).toHaveAttribute('data-kinds', 'renamed');
  await expect(row(ideas)).toContainText('Renamed from “Ideas”');

  // Back to the week, and Roadmap's diff.
  await page.getByLabel('From', { exact: true }).fill('2026-10-12');
  await page.getByLabel('To', { exact: true }).fill('2026-10-18');
  await row(roadmap).getByRole('button', { name: 'Show Changes' }).click();
  await expect(
    row(roadmap).locator('[data-op="add"] ins', { hasText: 'Agent added replay' }),
  ).toBeVisible();
  await row(roadmap).scrollIntoViewIfNeeded();
  await page.waitForTimeout(2_000);
});

test('the production build reads history in its worker, under the page’s policy', async ({
  browser,
  host,
}) => {
  test.setTimeout(120_000);
  await story(host);
  // The Mac app serves the built page (T29): its worker is a file of its own on the app's origin.
  const context = await macContext(browser, host, { baseURL: PREVIEW });
  try {
    const page = await context.newPage();
    const warnings: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'error' || message.type() === 'warning') warnings.push(message.text());
    });
    await page.addInitScript(() => {
      const seen: string[] = [];
      Object.assign(window, { cspViolations: seen });
      document.addEventListener('securitypolicyviolation', (event) =>
        seen.push(`${event.violatedDirective} ${event.blockedURI}`),
      );
    });
    // With no notebook named, the page opens on the one in use.
    await page.goto('/time-machine');
    await expect(tree(page).getByRole('button', { name: 'Review ideas' })).toBeVisible();
    await expect(page.getByTestId('tm-then')).toHaveAttribute('data-where', 'worker');
    await page.getByLabel('Date', { exact: true }).fill('2026-10-05');
    await expect(tree(page).getByRole('button', { name: 'Groceries' })).toBeVisible();
    expect(
      await page.evaluate(() => (window as unknown as { cspViolations: string[] }).cspViolations),
    ).toEqual([]);
    expect(warnings.filter((text) => text.includes('time-machine'))).toEqual([]);
  } finally {
    await context.close();
  }
});
