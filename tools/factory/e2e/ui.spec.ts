/**
 * The Factory UI's page against a fake state folder (A-NEW-1): the Inbox and Pipeline views, the
 * one detail both open, the health bar's stale and dead states, and a notification's link at
 * phone width. Headless Chromium only (playwright.config.ts); the server is the UI's own, on a
 * free port, with a stand-in writer, so nothing reaches Linear.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import type { UiAction, Writer } from '../src/ui/actions.ts';
import { pageHtml } from '../src/ui/page.ts';
import { viewFromState } from '../src/ui/run.ts';
import { createUiServer, listen } from '../src/ui/server.ts';
import { evening, NOW, writeEvening } from '../test/ui-fixture.ts';

const TOKEN = 'f'.repeat(48);

interface Served {
  readonly url: string;
  readonly actions: UiAction[];
  close(): Promise<void>;
}

async function serve(options: { alive: boolean; writable: boolean }): Promise<Served> {
  const dir = mkdtempSync(join(tmpdir(), 'factory-ui-e2e-'));
  const e = evening(dir);
  writeEvening(dir, e);
  const actions: UiAction[] = [];
  const writer: Writer = {
    perform: (action) => {
      actions.push(action);
      return Promise.resolve('Posted');
    },
  };
  const server: Server = createUiServer({
    port: 0,
    token: TOKEN,
    page: pageHtml,
    refreshMs: 200,
    view: () =>
      Promise.resolve(
        viewFromState(e.config, e.board, {
          busy: new Set([76]),
          alive: () => options.alive,
          now: NOW,
          writable: options.writable,
          readOnly: options.writable ? null : 'no Linear key in the keychain item',
        }),
      ),
    ...(options.writable ? { writer } : {}),
  });
  const port = await listen(server, 0);
  return {
    url: `http://127.0.0.1:${port}/?token=${TOKEN}`,
    actions,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
        rmSync(dir, { recursive: true, force: true });
      }),
  };
}

/** The page's clock at the fixture's moment, so "waiting 3 h" reads the same on any day. */
async function open(page: Page, url: string): Promise<void> {
  await page.clock.setFixedTime(NOW);
  await page.goto(url);
  await expect(page.locator('.health')).toBeVisible();
}

test.describe('a healthy factory', () => {
  let s: Served;
  test.beforeAll(async () => {
    s = await serve({ alive: true, writable: true });
  });
  test.afterAll(() => s.close());

  test('the Inbox lists only what needs Ryan, and opens the oldest', async ({ page }) => {
    await open(page, s.url);
    await expect(page.locator('.health')).toHaveText('Running');
    await expect(page.locator('.top .facts')).toContainText('pid 4242');
    await expect(page.locator('.switch [aria-current="page"]')).toContainText('Inbox');
    await expect(page.locator('.switch .badge')).toHaveText('6');
    await expect(page.locator('.list .item .head')).toContainText([
      'PEN-73',
      'PEN-75',
      'PEN-74',
      'PEN-78',
      'PEN-77',
      'PEN-84',
      'PEN-79',
      'PEN-76',
    ]);
    await expect(page.locator('.list .item')).toHaveCount(8);
    await expect(page.locator('.list .item', { hasText: 'PEN-36' })).toHaveCount(0);
    await expect(page.locator('.list')).toContainText(
      "2 In Progress or In Review cards aren't the factory's (never claimed): PEN-36, PEN-37.",
    );
    // The oldest is open beside the list.
    await expect(page.locator('.pane .detail h2')).toContainText('PEN-73');
    await expect(page.locator('.pane .todo')).toContainText(
      'CI stayed red after 2 repair rounds: android-emulator',
    );
    // Today's slots.
    await expect(page.locator('.today .lane-row')).toHaveCount(3);
    await expect(page.locator('.today .barx.t-stop')).toHaveCount(2);
  });

  test('a run that failed before the agent started says so, with the fix', async ({ page }) => {
    await open(page, `${s.url}#inbox/issue-75`);
    const detail = page.locator('#issue-75');
    await expect(detail.locator('.pill')).toHaveText('Fix the Mac');
    await expect(detail.locator('.todo')).toContainText(
      'Failed before the agent started: claude: command not found (exit 127)',
    );
    await expect(detail).not.toContainText('round 0');
    await expect(detail.locator('.todo .cmd code')).toHaveText('task factory:install');
    await expect(detail.locator('.steps .now')).toContainText('Build');
  });

  test('a Pipeline row opens the same detail as the Inbox', async ({ page }) => {
    await open(page, s.url);
    await page.locator('.switch a', { hasText: 'Pipeline' }).click();
    await expect(page.locator('.grid .hd')).toHaveText([
      'Card',
      'Todo 3',
      'Plan 2',
      'Build 2',
      'Gate',
      'Proof 1',
      'PR + CI 1',
      'Review 1',
      'Merge',
      'Done 1',
    ]);
    const row = page.locator('.prow', { hasText: 'PEN-73' });
    await expect(row.locator('.mark.t-stop')).toContainText('Unblock');
    await row.click();
    await expect(page).toHaveURL(/#pipeline\/issue-73$/);
    const side = page.locator('.side #issue-73');
    await expect(side.locator('.todo')).toContainText('CI stayed red after 2 repair rounds');
    // The same component as the Inbox's: the pill, the chips, the step marker, the reply box.
    await expect(side.locator('.pill')).toHaveText('Unblock');
    await expect(side.locator('.chips')).toContainText('PR #64');
    await expect(side.locator('.steps .now')).toContainText('PR + CI');
    await expect(side.getByRole('button', { name: 'Retry', exact: true })).toBeEnabled();
    // The view is remembered.
    await page.goto(s.url);
    await expect(page.locator('.switch [aria-current="page"]')).toContainText('Pipeline');
  });

  test("a reply goes to /action as Ryan, with the page's Origin", async ({ page }) => {
    await open(page, `${s.url}#inbox/issue-73`);
    const detail = page.locator('#issue-73');
    await detail.locator('textarea').fill('Wait for the idle resource, not a sleep.');
    await detail.getByRole('button', { name: 'Post and retry' }).click();
    await expect(detail.locator('.reply .said')).toHaveText('Posted');
    expect(s.actions).toEqual([
      { kind: 'reply', issue: 73, text: 'Wait for the idle resource, not a sleep.', unblock: true },
    ]);
  });

  test("at phone width, a notification's #issue-n opens that card in one column", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await open(page, `${s.url}#issue-77`);
    await expect(page.locator('#issue-77')).toBeVisible();
    await expect(page.locator('#issue-77 .todo')).toContainText("the VM penmoss-test isn't made");
    await expect(page.locator('.list')).toBeHidden();
    // No DOM types here (tsconfig is Node's): read the page's width through globalThis.
    const width = await page.evaluate(
      () =>
        (globalThis as unknown as { document: { documentElement: { scrollWidth: number } } })
          .document.documentElement.scrollWidth,
    );
    expect(width).toBeLessThanOrEqual(390);
    // Closing it goes back to the list.
    await page.locator('#issue-77 .close').click();
    await expect(page.locator('.list')).toBeVisible();
    await expect(page.locator('.pane')).toBeHidden();
  });
  test('a link to a card the factory never claimed says so', async ({ page }) => {
    await open(page, `${s.url}#issue-36`);
    await expect(page.locator('.pane .empty')).toContainText(
      "Card 36 isn't one the factory is handling now",
    );
  });
});

test.describe('a dead daemon, read-only', () => {
  let s: Served;
  test.beforeAll(async () => {
    s = await serve({ alive: false, writable: false });
  });
  test.afterAll(() => s.close());

  test('says the daemon is not running, dims the rest, and keeps the buttons off', async ({
    page,
  }) => {
    await open(page, `${s.url}#inbox/issue-73`);
    await expect(page.locator('.health')).toHaveText('Daemon not running');
    await expect(page.locator('.alert').first()).toContainText('pid 4242 has exited');
    await expect(page.locator('.alert .cmd code').first()).toHaveText('task factory:start');
    await expect(page.locator('body')).toHaveClass(/stale/);
    await expect(page.locator('.alert.info')).toContainText('Read-only: no Linear key');
    await expect(
      page.locator('#issue-73').getByRole('button', { name: 'Retry', exact: true }),
    ).toBeDisabled();
    // Nothing is shown as live: PEN-79's run is no longer running.
    await expect(page.locator('.list')).toContainText('Stopped mid-run');
  });
});
