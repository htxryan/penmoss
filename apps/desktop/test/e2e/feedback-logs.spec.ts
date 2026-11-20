import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { logBlock } from '@penmoss/core/analytics';
import { desktopFakeGitHubPort } from '../../../../scripts/checkout-ports.mjs';
import { canaryHits, CANARIES, logFilePath } from './fake-analytics';
import {
  body,
  gitNotebook,
  go,
  holdForProof,
  launch,
  mainBounds,
  removeDataDirs,
  ULID,
  type Launched,
} from './support';

// PEN-137 ac3 in the Mac app: Send Feedback's Attach Anonymised Logs. A bug report has the box
// ticked, after Captured Context, with the sentence the limits make and the exact text that goes:
// the newest lines of the app's own log file (main's, PENMOSS_LOG_DIR), scrubbed of this Mac's
// paths, the notebook's name and the notes' titles. The issue filed to the fake GitHub (as
// send-feedback.spec.ts) holds them as a collapsed "Anonymised Logs" block before its footer.
// The web suite has the form's own steps (apps/web/test/e2e/feedback-logs.spec.ts).

const mac = process.platform === 'darwin';
const NEW_NOTE = mac ? 'Meta+Alt+KeyN' : 'Alt+KeyN';
const RUN = `f${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
const FAKE = `http://127.0.0.1:${desktopFakeGitHubPort()}`;
const NOTE_TITLE = CANARIES.notes[0]!.title;
const opened: Launched[] = [];

test.afterEach(async () => {
  for (const { app } of opened.splice(0)) await app.close().catch(() => undefined);
});
test.afterAll(() => removeDataDirs());

interface Hooks {
  penmossDesktop: { mainWindow(): Electron.BrowserWindow | null };
}

interface FakeIssue {
  readonly title: string;
  readonly body: string;
}

async function fakeIssue(title: string): Promise<FakeIssue | undefined> {
  const issues = (await (await fetch(`${FAKE}/__fake/issues`)).json()) as FakeIssue[];
  return issues.find((issue) => issue.title === title);
}

/** Help → Send Feedback in the main window, as the menu item does. */
async function sendFeedback(app: ElectronApplication, page: Page) {
  await app.evaluate(() => {
    (globalThis as unknown as Hooks).penmossDesktop.mainWindow()!.emit('focus');
  });
  await app.evaluate(({ Menu }) => {
    (
      Menu.getApplicationMenu()?.getMenuItemById('app.sendFeedback') as unknown as {
        click(): void;
      }
    ).click();
  });
  const form = page.getByRole('dialog', { name: 'Send Feedback' });
  await expect(form).toBeVisible();
  return form;
}

async function newNote(page: Page, title: string, text: string): Promise<void> {
  await expect(page.locator('button[data-command="note.new"]').first()).toBeVisible();
  await page.keyboard.press(NEW_NOTE);
  await expect(page).toHaveURL(ULID);
  await expect(page.getByTestId('note-title')).toBeFocused();
  await page.keyboard.type(title);
  await page.keyboard.press('Enter');
  await page.keyboard.type(text);
  await expect(body(page)).toContainText(text);
}

/** A log line as main writes it: its time, level and source, then the message. */
const LOG_LINE = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z (?:info|warn|error) [\w-]+ /;

test('a bug report attaches the app’s own log, anonymised, exactly as previewed, before the footer (ac3)', async () => {
  test.setTimeout(180_000);
  const launched = await launch({ env: { PENMOSS_TEST_GITHUB_API: FAKE } });
  opened.push(launched);
  const { app, page } = launched;
  await mainBounds(app, { x: 0, y: 0, width: 1280, height: 720 });
  await gitNotebook(launched, CANARIES.notebook);
  await newNote(page, NOTE_TITLE, `${CANARIES.body[0]} here.`);

  // The fake's token, kept in Settings → GitHub, so the report is filed at once.
  await go(page, '/settings/github');
  const github = page.getByTestId('github-token');
  const open = github.getByTestId('github-token-open');
  await expect(github.getByTestId('github-token-input').or(open)).toBeVisible();
  if (await open.isVisible()) await open.click();
  await github.getByTestId('github-token-input').fill('fake-local-token');
  await github.getByTestId('github-token-save').click();
  await expect(github.getByTestId('github-account')).toContainText('htxryan');

  // The app's own log file has lines by now (its start, the window, the notebook's sync).
  const file = await logFilePath(app);
  await expect
    .poll(() => readFileSync(file, 'utf8').split('\n').filter(Boolean).length)
    .toBeGreaterThan(0);

  const form = await sendFeedback(app, page);
  await form.getByTestId('feedback-type-bug').check();
  await form.getByTestId('feedback-priority-2').check();
  const title = `[e2e] Mac logs attached ${RUN}`;
  await form.getByTestId('feedback-title').fill(title);

  // After Captured Context, ticked for a bug, with the sentence the limits make.
  const logs = form.getByTestId('feedback-logs');
  await expect(logs).toBeVisible({ timeout: 15_000 });
  await expect(logs.getByRole('checkbox', { name: 'Attach Anonymised Logs' })).toBeChecked();
  await expect(logs).toContainText(
    'The app’s logs from the last 24 hours, at most 300 lines and 16 KB, with names, paths, IDs and secrets replaced. This is exactly what is attached.',
  );
  const order = await form.evaluate((element) =>
    [...element.querySelectorAll('[data-testid="feedback-context"], [data-testid="feedback-logs"]')]
      .map((each) => each.getAttribute('data-testid'))
      .join(' '),
  );
  expect(order).toBe('feedback-context feedback-logs');

  // The exact text, collapsed under its count and size.
  const summary = logs.getByTestId('feedback-logs-preview').locator('summary');
  await expect(summary).toHaveText(/^Anonymised Logs · \d+ lines · [\d.]+ (?:B|KB)$/);
  const text = logs.getByTestId('feedback-logs-text');
  await expect(text).toBeHidden();
  await summary.click();
  await expect(text).toBeVisible();
  const shown = (await text.textContent()) ?? '';
  const lines = shown.split('\n');
  expect(lines.length).toBeGreaterThan(0);
  expect((await summary.textContent())!).toContain(`· ${lines.length} lines ·`);
  // Lines of the app's own log file, as main wrote them (a stack's lines follow their own).
  expect(lines[0]).toMatch(LOG_LINE);
  expect(lines.filter((line) => LOG_LINE.test(line)).length).toBeGreaterThanOrEqual(
    Math.ceil(lines.length / 2),
  );
  const written = new Set(readFileSync(file, 'utf8').split('\n'));
  const fromFile = lines.filter((line) => written.has(line));
  expect(fromFile.length).toBeGreaterThanOrEqual(Math.max(1, Math.floor(lines.length / 2)));
  // Anonymised: no path of this Mac, no notebook's name, no note's title, nothing it holds.
  for (const path of [homedir(), launched.userData, launched.home, launched.logDir]) {
    expect(shown).not.toContain(path);
  }
  expect(canaryHits(shown)).toEqual([]);
  await holdForProof(page);

  await form.getByTestId('feedback-send').click();
  await expect(page.getByTestId('feedback-sent-toast')).toBeVisible({ timeout: 20_000 });
  await expect.poll(() => fakeIssue(title).then(Boolean), { timeout: 20_000 }).toBe(true);
  const issue = (await fakeIssue(title))!.body;
  const context = issue.indexOf('<details><summary>Captured Context</summary>');
  const block = issue.indexOf(
    `<details>\n<summary>Anonymised Logs (${lines.length} lines)</summary>`,
  );
  const footer = issue.search(/Sent from Penmoss Mac .+ · submission [0-9A-HJKMNP-TV-Z]{26}/);
  expect(context).toBeGreaterThanOrEqual(0);
  expect(block).toBeGreaterThan(context);
  expect(footer).toBeGreaterThan(block);
  // Exactly what was previewed.
  expect(issue).toContain(logBlock(lines));
  expect(canaryHits(issue)).toEqual([]);
  for (const path of [homedir(), launched.userData, launched.logDir]) {
    expect(issue).not.toContain(path);
  }

  // The proof: a new bug report, its logs' exact text open on screen.
  await page.getByTestId('feedback-sent-toast').getByRole('button', { name: 'Dismiss' }).click();
  const again = await sendFeedback(app, page);
  await again.getByTestId('feedback-type-bug').check();
  await again.getByTestId('feedback-title').fill(`[e2e] Mac logs again ${RUN}`);
  const preview = again.getByTestId('feedback-logs').getByTestId('feedback-logs-preview');
  await preview.locator('summary').click();
  const openText = again.getByTestId('feedback-logs-text');
  await expect(openText).toBeVisible();
  await openText.evaluate((element) => element.scrollIntoView({ block: 'end' }));
  expect(canaryHits((await openText.textContent()) ?? '')).toEqual([]);
  await holdForProof(page);
});
