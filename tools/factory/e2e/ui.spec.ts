/**
 * The Factory UI's page against a fake state folder (A1233): the Inbox and Pipeline views, the
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

async function serve(options: {
  alive: boolean;
  writable: boolean;
  /** A new view on every push, as while a run writes its log. */
  ticking?: boolean;
}): Promise<Served> {
  const dir = mkdtempSync(join(tmpdir(), 'factory-ui-e2e-'));
  const e = evening(dir);
  writeEvening(dir, e);
  const actions: UiAction[] = [];
  let tick = 0;
  const writer: Writer = {
    perform: (action) => {
      actions.push(action);
      // As the real writer says it: the fixture's cards in question are Blocked.
      const clears = action.kind === 'complete' || (action.kind === 'reply' && action.unblock);
      return Promise.resolve(clears ? 'Posted, and Blocked cleared' : 'Posted');
    },
  };
  const server: Server = createUiServer({
    port: 0,
    token: TOKEN,
    page: pageHtml,
    refreshMs: 200,
    view: () =>
      Promise.resolve({
        ...viewFromState(e.config, e.board, {
          busy: new Set([76]),
          alive: () => options.alive,
          now: NOW,
          writable: options.writable,
          readOnly: options.writable ? null : 'no Linear key in the keychain item',
        }),
        ...(options.ticking ? { tick: (tick += 1) } : {}),
      }),
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
    // One health pill; the daemon's facts fold behind it.
    await expect(page.locator('.health')).toHaveText('Running · 2 of 2 slots busy');
    await expect(page.locator('.hp .facts')).toBeHidden();
    await page.locator('.health').click();
    await expect(page.locator('.hp .facts')).toBeVisible();
    await expect(page.locator('.hp .facts')).toContainText('pid 4242');
    await expect(page.locator('.hp .facts')).toContainText('e47b20a Factory: fixes');
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
    // Each item says in one line what it needs, not the generic instructions.
    await expect(page.locator('.list .item', { hasText: 'PEN-74' }).locator('.brief')).toHaveText(
      'Review PR #65',
    );
    await expect(page.locator('.list .item', { hasText: 'PEN-78' }).locator('.brief')).toHaveText(
      'Answer 2 questions on the plan',
    );
    // The cards the factory never claimed are counted, folded.
    const outside = page.locator('.list .more');
    await expect(outside.locator('summary')).toHaveText('Not in the factory (2)');
    await expect(outside.locator('p')).toBeHidden();
    await outside.locator('summary').click();
    await expect(outside.locator('p')).toHaveText(
      "2 In Progress or In Review cards aren't the factory's (never claimed): PEN-36, PEN-37.",
    );
    // The oldest is open beside the list.
    await expect(page.locator('.pane .detail h2')).toContainText('PEN-73');
    await expect(page.locator('.pane .todo')).toContainText(
      'CI stayed red after 2 repair rounds: android-emulator',
    );
    // The activity (the slots' runs and the event feed) is on the Pipeline, not here.
    await expect(page.locator('.today')).toHaveCount(0);
    await expect(page.locator('.out')).toHaveCount(0);
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
    // The same component as the Inbox's: the pill, the links, the step marker, the reply box.
    await expect(side.locator('.pill')).toHaveText('Unblock');
    await expect(side.locator('.meta')).toContainText('CI repair 2 of 2');
    await expect(side.locator('.links')).toContainText('PR #64');
    await expect(side.locator('.steps .now')).toContainText('PR + CI');
    await expect(side.getByRole('button', { name: 'Post and retry' })).toHaveClass(/primary/);
    await expect(side.getByRole('button', { name: 'Retry', exact: true })).toBeEnabled();
    // The activity sits under the board: the slots' runs over 12 hours, newest event first.
    await expect(page.locator('.today .lane-row')).toHaveCount(3);
    await expect(page.locator('.today .barx.t-stop')).toHaveCount(2);
    await expect(page.locator('.today .out p').first()).toContainText('PEN-74');
    await expect(page.locator('.today .out p').first()).toContainText('Reached review');
    // The view is remembered.
    await page.goto(s.url);
    await expect(page.locator('.switch [aria-current="page"]')).toContainText('Pipeline');
  });

  test("a reply goes to /action as Ryan, with the page's Origin", async ({ page }) => {
    await open(page, `${s.url}#inbox/issue-73`);
    const detail = page.locator('#issue-73');
    await detail.locator('textarea').fill('Wait for the idle resource, not a sleep.');
    await detail.getByRole('button', { name: 'Post and retry' }).click();
    await expect(detail.locator('.sent .ask')).toHaveText(
      /^Posted, and Blocked cleared on PEN-73 at \d\d:\d\d$/,
    );
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
    // The header takes two lines at most: name and switch, then health and theme.
    const header = await page.locator('.top').boundingBox();
    expect(header?.height).toBeLessThan(100);
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

test.describe("the plan's questions", () => {
  let s: Served;
  test.beforeAll(async () => {
    s = await serve({ alive: true, writable: true });
  });
  test.afterAll(() => s.close());

  test('each question is one block with its proposal once, and the answers go in one reply', async ({
    page,
  }) => {
    await open(page, `${s.url}#inbox/issue-78`);
    const detail = page.locator('#issue-78');
    await expect(detail.locator('.ask')).toHaveText('Answer 2 questions on the plan');
    // The plan, which Ryan reads before answering, is a link right under the title.
    await expect(detail.locator('.links a.em')).toHaveText('Plan');
    const q = detail.locator('.q');
    await expect(q).toHaveCount(2);
    await expect(q.nth(0).locator('.qt')).toHaveText('Include attachments?');
    const context = 'Proposed: attachments go in the zip beside their notes. OK?';
    await expect(q.nth(0).locator('.ctx')).toHaveText(context);
    // Not twice: no separate list of the open points.
    const text = (await detail.textContent()) ?? '';
    expect(text.split(context)).toHaveLength(2);
    // The proposal is tagged, once per question; nothing is picked yet.
    await expect(q.nth(0).locator('.opt', { has: page.locator('.tag') })).toHaveText(
      'Yes, beside their notesproposed',
    );
    await expect(q.nth(1).locator('.tag')).toHaveCount(1);
    await expect(detail.locator('.opt[aria-pressed="true"]')).toHaveCount(0);
    await expect(detail.locator('.count')).toHaveText('0 of 2 picked');

    await q.nth(0).locator('.opt').first().click();
    await q.nth(1).getByRole('button', { name: 'One zip per folder' }).click();
    await expect(q.nth(0).locator('.opt').first()).toHaveAttribute('aria-pressed', 'true');
    await expect(q.nth(1).locator('.opt[aria-pressed="true"]')).toHaveText('One zip per folder');
    await expect(detail.locator('.count')).toHaveText('2 of 2 picked');
    // Picking another option moves the choice.
    await q.nth(1).locator('.opt').first().click();
    await q.nth(1).getByRole('button', { name: 'One zip per folder' }).click();
    await expect(q.nth(1).locator('.opt[aria-pressed="true"]')).toHaveCount(1);

    await detail.locator('textarea').fill('Name it penmoss-export.zip.');
    // One primary; Complete is the secondary; the rest are quiet.
    await expect(detail.locator('button.primary')).toHaveText(['Send answers and continue']);
    await expect(detail.locator('button.secondary')).toHaveText(['Agree the plan (Complete)']);
    await expect(detail.locator('button.quiet')).toHaveText([
      'Post without unblocking',
      'Just unblock',
    ]);
    await detail.getByRole('button', { name: 'Send answers and continue' }).click();
    // Sent: the card says so in place of the questions, rather than showing them again with
    // the picks cleared while the board catches up.
    const done = detail.locator('.sent');
    await expect(done.locator('.ask')).toHaveText(
      /^Posted, and Blocked cleared on PEN-78 at \d\d:\d\d$/,
    );
    await expect(done.locator('.what')).toHaveText(
      'The factory hands it on at its next poll, within a minute or two. Any reply or new question shows here.',
    );
    await expect(detail.locator('.q')).toHaveCount(0);
    await expect(detail.locator('textarea')).toHaveCount(0);
    expect(s.actions).toEqual([
      {
        kind: 'reply',
        issue: 78,
        text: 'On "Include attachments?": Yes, beside their notes (proposed)\nOn "One zip or one per folder?": One zip per folder\n\nName it penmoss-export.zip.',
        unblock: true,
      },
    ]);
    // Until Ryan asks for them back.
    await detail.getByRole('button', { name: 'Show the questions again' }).click();
    await expect(detail.locator('.q')).toHaveCount(2);
    await expect(detail.locator('.opt[aria-pressed="true"]')).toHaveCount(0);
  });
});

test.describe("the activity timeline's chips", () => {
  let s: Served;
  test.beforeAll(async () => {
    s = await serve({ alive: true, writable: true });
  });
  test.afterAll(() => s.close());

  // PEN-73 ran two hours, PEN-75 a few seconds (the fixture's ledger).
  const chip = (page: Page, key: string) =>
    page.locator('.today').getByRole('link', { name: new RegExp(`^${key} `) });
  const fits = (page: Page, key: string) =>
    chip(page, key).evaluate((a) => {
      const box = a as unknown as { scrollWidth: number; clientWidth: number };
      return box.scrollWidth <= box.clientWidth;
    });

  async function pipeline(page: Page): Promise<void> {
    await open(page, s.url);
    await page.locator('.switch a', { hasText: 'Pipeline' }).click();
    await expect(page.locator('.today .lane-row')).toHaveCount(3);
  }

  test('a short run shows its number alone, a long one its full key', async ({ page }) => {
    await pipeline(page);
    await expect(chip(page, 'PEN-73')).toHaveText('PEN-73');
    await expect(chip(page, 'PEN-75')).toHaveText('75');
    // Neither is cut: a run of seconds still gets a chip as wide as its number.
    expect(await fits(page, 'PEN-73')).toBe(true);
    expect(await fits(page, 'PEN-75')).toBe(true);
    // The tooltip and the accessible name keep the full key, the times and the step.
    await expect(chip(page, 'PEN-75')).toHaveAttribute(
      'title',
      /^PEN-75 \d\d:\d\d–\d\d:\d\d: Failed before the agent started/,
    );
    // In dark too, then held on screen for the proof's recording.
    await page.getByRole('button', { name: 'Dark', exact: true }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await chip(page, 'PEN-75').scrollIntoViewIfNeeded();
    await page.waitForTimeout(2000);
    await expect(chip(page, 'PEN-75')).toHaveText('75');
  });

  test('at phone width the chips still show their numbers in full', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await pipeline(page);
    await expect(chip(page, 'PEN-75')).toHaveText('75');
    expect(await fits(page, 'PEN-75')).toBe(true);
    await expect(chip(page, 'PEN-73')).toHaveText('PEN-73');
  });
});

test.describe('the theme', () => {
  let s: Served;
  test.beforeAll(async () => {
    s = await serve({ alive: true, writable: true });
  });
  test.afterAll(() => s.close());
  const LIGHT = 'rgb(246, 245, 242)';
  const DARK = 'rgb(20, 20, 19)';

  test('is light by default, even when the OS is dark', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await open(page, s.url);
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await expect(page.locator('body')).toHaveCSS('background-color', LIGHT);
    await expect(page.getByRole('button', { name: 'Light', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  test('Dark applies at once and survives a reload', async ({ page }) => {
    await open(page, s.url);
    await page.getByRole('button', { name: 'Dark', exact: true }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect(page.locator('body')).toHaveCSS('background-color', DARK);
    await page.reload();
    await expect(page.locator('.health')).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect(page.locator('body')).toHaveCSS('background-color', DARK);
    await expect(page.getByRole('button', { name: 'Dark', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  test('System follows the OS', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'dark' });
    await open(page, s.url);
    await page.getByRole('button', { name: 'System', exact: true }).click();
    await expect(page.locator('body')).toHaveCSS('background-color', DARK);
    await page.emulateMedia({ colorScheme: 'light' });
    await expect(page.locator('body')).toHaveCSS('background-color', LIGHT);
  });

  test('the agent log is readable in both themes', async ({ page }) => {
    await open(page, `${s.url}#inbox/issue-79`);
    await page.locator('#issue-79 summary', { hasText: 'Agent log' }).click();
    const log = page.locator('#issue-79 .log');
    await expect(log).toContainText('Adding Retry-After to the 429 path');
    await expect(log).toHaveCSS('background-color', 'rgb(244, 242, 236)');
    await page.getByRole('button', { name: 'Dark', exact: true }).click();
    await expect(log).toHaveCSS('background-color', 'rgb(15, 15, 14)');
  });
});

test.describe('the link opened from another app or site (A1249)', () => {
  let s: Served;
  test.beforeAll(async () => {
    s = await serve({ alive: true, writable: true });
  });
  test.afterAll(() => s.close());

  test('a cross-site link keeps the cookie and opens the page', async ({ page }) => {
    // A link tapped in a chat app: the navigation starts on another site.
    await page.route('https://elsewhere.example/', (route) =>
      route.fulfill({ contentType: 'text/html', body: `<a id="go" href="${s.url}">Factory</a>` }),
    );
    await page.clock.setFixedTime(NOW);
    await page.goto('https://elsewhere.example/');
    await page.click('#go');
    await expect(page.locator('.health')).toBeVisible();
    expect(page.url()).not.toContain('token=');
    await expect(page.locator('body')).not.toContainText('Forbidden');
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

test.describe('a factory whose view changes every push', () => {
  let s: Served;
  test.beforeAll(async () => {
    s = await serve({ alive: true, writable: true, ticking: true });
  });
  test.afterAll(() => s.close());

  // No DOM types here (tsconfig is Node's): reach the page through globalThis.
  type Doc = { contains(n: unknown): boolean; querySelector(q: string): unknown };
  type Win = { scrollY: number; scrollTo(x: number, y: number): void; document: Doc };
  const redrawn = async (page: Page) => {
    const card = await page.locator('#issue-77').elementHandle();
    await page.waitForFunction((el) => !(globalThis as unknown as Win).document.contains(el), card);
  };

  test('keeps where Ryan scrolled while new views redraw the page', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 400 });
    await open(page, `${s.url}#issue-77`);
    await expect(page.locator('#issue-77')).toBeVisible();
    await page.evaluate(() => (globalThis as unknown as Win).scrollTo(0, 120));
    const at = await page.evaluate(() => (globalThis as unknown as Win).scrollY);
    expect(at).toBeGreaterThan(0);
    // Each push (every 200 ms here) builds the page again; twice, to be sure.
    await redrawn(page);
    await redrawn(page);
    expect(await page.evaluate(() => (globalThis as unknown as Win).scrollY)).toBe(at);
  });
});
