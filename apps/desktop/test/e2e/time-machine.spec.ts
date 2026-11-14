import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import {
  STORY_AGENT as AGENT,
  STORY_DEVICE as DEVICE,
  timeMachineStory,
} from '../../../web/test/e2e/support/dated-history';
import {
  body,
  gitConfig,
  gitNotebook,
  go,
  launch,
  notebookSynced,
  removeDataDirs,
  type Launched,
} from './support';

// PEN-21 in the Mac app: the Time Machine. The app makes a notebook, then a device and an agent,
// each on its own clone, push commits dated Thursday 1 October (Projects, Roadmap in it,
// Groceries), Tuesday 13 October (the agent adds a line to Roadmap and makes Ideas) and Wednesday
// 14 October (Ideas renamed, Roadmap moved to the top level, Groceries put in Trash). The Time
// Machine shows the notebook on 5 October and What Changed in the week of 12 October; History's
// Replay plays Roadmap's versions with their writers. The web suite
// (apps/web/test/e2e/time-machine.spec.ts) covers each part in more detail.

const opened: Launched[] = [];

test.afterEach(async () => {
  for (const { app } of opened.splice(0)) await app.close().catch(() => undefined);
});
test.afterAll(() => removeDataDirs());

/** The story's commits, pushed to the notebook's repository from two clones of their own. */
const story = (remote: string) =>
  timeMachineStory(
    {
      root: mkdtempSync(join(tmpdir(), 'penmoss-dated-')),
      env: { GIT_CONFIG_GLOBAL: gitConfig(), GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' },
    },
    `file://${remote}`,
  );

/** Sync now from the notebook's Settings page, so the app has the commits just pushed. */
async function pull(page: Page, name: string): Promise<void> {
  await go(page, '/settings/git-notebooks');
  await page.getByTestId('git-notebook-row').filter({ hasText: name }).click();
  const card = page.getByTestId('git-notebook').filter({ hasText: name });
  await card.getByTestId('git-sync-now').click();
  await expect(card.getByTestId('git-status')).toHaveAttribute('data-phase', 'synced', {
    timeout: 30_000,
  });
  await notebookSynced(page, name);
  await go(page, '/');
}

/** Runs a command from the palette, as a person would. */
async function fromPalette(page: Page, title: string): Promise<void> {
  await page.keyboard.press('ControlOrMeta+KeyK');
  const palette = page.getByRole('dialog', { name: 'Command Palette' });
  await expect(palette).toBeVisible();
  await palette.getByRole('combobox', { name: 'Command Palette' }).fill(title);
  await expect(palette.getByRole('option').first()).toContainText(title);
  await page.keyboard.press('Enter');
  await expect(palette).toBeHidden();
}

test('the Time Machine shows the notebook on a past date and what changed that week', async () => {
  test.setTimeout(150_000);
  const launched = await launch();
  opened.push(launched);
  const { page } = launched;
  const { name, remote } = await gitNotebook(launched);
  await story(remote);
  await pull(page, name);

  await fromPalette(page, 'Time Machine');
  const then = page.getByTestId('tm-then');
  await expect(then).toBeVisible({ timeout: 30_000 });
  const tree = page.getByRole('navigation', { name: 'Folders and notes then' });
  await expect(tree.getByRole('button', { name: 'Review ideas' })).toBeVisible({ timeout: 30_000 });
  // Read in the page's worker, as the app serves it.
  await expect(then).toHaveAttribute('data-where', 'worker');

  // Monday 5 October: Roadmap in Projects, Groceries not yet in Trash, no Ideas.
  await page.getByLabel('Date', { exact: true }).fill('2026-10-05');
  await expect(page.getByTestId('tm-place')).toContainText(DEVICE);
  const projects = tree.locator('[data-folder="Projects"]');
  await expect(projects.getByRole('button', { name: 'Roadmap' })).toBeVisible();
  await expect(tree.getByRole('button', { name: 'Groceries' })).toBeVisible();
  await projects.getByRole('button', { name: 'Roadmap' }).click();
  await expect(page.getByTestId('tm-note-text')).toContainText('Ship the scrubber');
  await expect(page.getByTestId('tm-note-text')).not.toContainText('Agent added replay');
  await expect(page.getByRole('button', { name: 'Restore This Version' })).toBeVisible();
  await page.waitForTimeout(1_500);

  // What Changed, the week of Monday 12 October.
  await page.getByRole('tab', { name: 'What Changed' }).click();
  await page.getByLabel('From', { exact: true }).fill('2026-10-12');
  await page.getByLabel('To', { exact: true }).fill('2026-10-18');
  await expect(page.getByTestId('tm-summary')).toContainText('3 notes changed');
  const list = page.getByRole('list', { name: 'Changed notes' });
  await expect(list.locator('li.tm-change[data-kinds="created edited"]')).toContainText(
    'Review ideas',
  );
  await expect(list.locator('li.tm-change[data-kinds="deleted"]')).toContainText('Groceries');
  const moved = list.locator('li.tm-change[data-kinds="moved edited"]');
  await expect(moved).toContainText('Moved from Projects');
  await expect(moved.locator('.history-author[data-kind="agent"]')).toContainText(AGENT);
  await moved.getByRole('button', { name: 'Show Changes' }).click();
  await expect(
    moved.locator('[data-op="add"] ins', { hasText: 'Agent added replay' }),
  ).toBeVisible();
  await moved.scrollIntoViewIfNeeded();
  await page.waitForTimeout(2_000);
});

test('History’s Replay plays a note’s versions forward, with who made each', async () => {
  test.setTimeout(150_000);
  const launched = await launch();
  opened.push(launched);
  const { page } = launched;
  const { name, remote } = await gitNotebook(launched);
  const { roadmap } = await story(remote);
  await pull(page, name);

  await go(page, `/notes/${roadmap}`);
  await expect(body(page)).toContainText('Agent added replay', { timeout: 30_000 });
  await page.getByTestId('note-tab-history').click();
  const panel = page.getByTestId('history-panel');
  await panel.getByTestId('history-replay-start').click();
  const replay = panel.getByTestId('history-replay');
  const place = replay.getByTestId('replay-place');
  await expect(place).toContainText('Version 1 of 2');
  await expect(place).toContainText(DEVICE);
  await expect(place).toContainText('Version 2 of 2', { timeout: 5_000 });
  await expect(place).toContainText(AGENT);
  await expect(
    replay.getByTestId('replay-text').locator('[data-op="add"] ins', {
      hasText: 'Agent added replay',
    }),
  ).toBeVisible();
  await page.waitForTimeout(2_000);
});
