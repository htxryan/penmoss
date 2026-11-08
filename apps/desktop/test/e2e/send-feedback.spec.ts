import { expect, test, type ElectronApplication, type Page } from '@playwright/test';

import { desktopFakeGitHubPort } from '../../../../packages/core/test/support/checkout-ports';
import {
  body,
  launch,
  mainBounds,
  removeDataDirs,
  gitNotebook,
  ULID,
  type Launched,
} from './support';

// T49 (A798) in the Mac app: Help → Send feedback, the window captured by the main process
// (capturePage) before the form is drawn and offered unticked, the context naming the Mac app
// and the window it was sent from. T57 (A1010–A1012): the main process files it with the
// person's own GitHub token, against the fake GitHub on this checkout's port (A1177; PENMOSS_TEST_GITHUB_API): it
// waits in the outbox until a token is saved in Settings → Status → GitHub Token, a token
// GitHub refuses is said plainly and not kept, and the issue is filed once one is saved. The
// web suite (apps/web/test/e2e/send-feedback.spec.ts) covers the form.

const mac = process.platform === 'darwin';
const NEW_NOTE = mac ? 'Meta+Alt+KeyN' : 'Alt+KeyN';
const RUN = `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
const MARKER = `QUIETMARKER${RUN}`;
const WINDOW = /^app:\/\/penmoss\/window\/notes\/[0-9A-HJKMNP-TV-Z]{26}$/;
const FAKE = `http://127.0.0.1:${desktopFakeGitHubPort()}`;
const opened: Launched[] = [];

test.afterEach(async () => {
  for (const { app } of opened.splice(0)) await app.close().catch(() => undefined);
});
test.afterAll(() => removeDataDirs());

interface Hooks {
  penmossDesktop: {
    noteWindows(): Electron.BrowserWindow[];
    mainWindow(): Electron.BrowserWindow | null;
  };
}

/** Chooses a menu item, as a click on it would. */
const chooseMenu = (app: ElectronApplication, id: string) =>
  app.evaluate(({ Menu }, itemId) => {
    (Menu.getApplicationMenu()?.getMenuItemById(itemId) as unknown as { click(): void }).click();
  }, id);

/** The label of the top-level menu that holds `id`. */
const menuOf = (app: ElectronApplication, id: string) =>
  app.evaluate(({ Menu }, itemId) => {
    const holds = (items: Electron.MenuItem[]): boolean =>
      items.some(
        (item) => item.id === itemId || (item.submenu ? holds(item.submenu.items) : false),
      );
    return (
      Menu.getApplicationMenu()?.items.find((item) => item.submenu && holds(item.submenu.items))
        ?.label ?? null
    );
  }, id);

interface FakeIssue {
  readonly title: string;
  readonly body: string;
  readonly labels: readonly string[];
}

async function fakeIssue(title: string): Promise<FakeIssue | undefined> {
  const issues = (await (await fetch(`${FAKE}/__fake/issues`)).json()) as FakeIssue[];
  return issues.find((issue) => issue.title === title);
}

async function newNote(page: Page, title: string, text: string): Promise<void> {
  await expect(page.locator('button[data-command="note.new"]')).toBeVisible();
  await page.keyboard.press(NEW_NOTE);
  await expect(page).toHaveURL(ULID);
  await expect(page.getByTestId('note-title')).toBeFocused();
  await page.keyboard.type(title);
  await page.keyboard.press('Enter');
  await page.keyboard.type(text);
  await expect(body(page)).toContainText(text);
}

const go = (page: Page, path: string) =>
  page.evaluate((to) => {
    window.history.pushState(null, '', to);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, path);

test('Help → Send feedback in a note window: the window offered unticked, filed with your GitHub token', async () => {
  const launched = await launch({ env: { PENMOSS_TEST_GITHUB_API: FAKE } });
  opened.push(launched);
  const { app, page } = launched;
  await mainBounds(app, { x: 0, y: 0, width: 1100, height: 760 });
  await gitNotebook(launched);
  expect(await menuOf(app, 'app.sendFeedback')).toBe('Help');

  const title = `Feedback ${RUN}`;
  await newNote(page, title, `Private words ${MARKER} here.`);
  const [window] = await Promise.all([
    app.waitForEvent('window'),
    chooseMenu(app, 'note.openInNewWindow'),
  ]);
  await expect(window).toHaveURL(WINDOW);
  await expect(window.getByTestId('note-view')).toHaveAttribute('data-ready', 'true');
  await app.evaluate(() => {
    (globalThis as unknown as Hooks).penmossDesktop.noteWindows()[0]!.emit('focus');
  });

  // The menu command acts in the window in front: the note window.
  await chooseMenu(app, 'app.sendFeedback');
  const form = window.getByRole('dialog', { name: 'Send Feedback' });
  await expect(form).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'Send Feedback' })).toHaveCount(0);

  // A git notebook's note sends nothing of the notebook (A889): no capture of a window showing
  // it. Every note is a git notebook's since T59; the main window's capture is checked below.
  await expect(form.getByTestId('feedback-shot')).toHaveCount(0);
  // The web's Capture this window is the browser's; the Mac app captures for itself.
  await expect(form.getByTestId('feedback-capture-tab')).toHaveCount(0);

  await form.getByTestId('feedback-context').locator('summary').click();
  const preview = form.getByTestId('feedback-preview');
  await expect(preview).toContainText('| Client | Mac |');
  await expect(preview).toContainText('| Window | note window |');
  await expect(preview).toContainText('| Opened from | Mac menu |');
  await expect(preview).toContainText('| Screen | note (in its own window) |');
  await expect(preview).not.toContainText(MARKER);

  const issueTitle = `[e2e] Mac feedback ${RUN}`;
  await form.getByTestId('feedback-type-feature').check();
  await form.getByTestId('feedback-priority-3').check();
  await form.getByTestId('feedback-title').fill(issueTitle);
  await form.getByTestId('feedback-send').click();
  // No GitHub token yet: it waits in the outbox, and says where to add one.
  await expect(form.getByTestId('feedback-queued')).toContainText(
    'Add your GitHub token in Settings → Status → GitHub Token to send it.',
    { timeout: 20_000 },
  );
  expect(await fakeIssue(issueTitle)).toBeUndefined();
  await form.getByTestId('feedback-close').click();

  // Settings → Status → GitHub Token, in the main window.
  await go(page, '/settings/status');
  const section = page.getByTestId('github-token');
  await expect(section.getByTestId('github-token-none')).toBeVisible();
  // A token GitHub does not accept is refused in plain words, and not kept.
  await section.getByTestId('github-token-input').fill('ghp_notthefaketoken000000000000000000000');
  await section.getByTestId('github-token-save').click();
  await expect(section.getByTestId('github-token-message')).toHaveText(
    'GitHub does not accept this token: it may have expired or been revoked.',
  );
  await expect(section.getByTestId('github-token-none')).toBeVisible();
  // The fake's token: kept, its account named, and the report waiting for it is filed.
  await section.getByTestId('github-token-input').fill('fake-local-token');
  await section.getByTestId('github-token-save').click();
  await expect(section.getByTestId('github-token-saved')).toHaveText('Saved for htxryan.');
  await expect(section.getByTestId('github-token-input')).toHaveValue('');
  await expect(page.getByText('fake-local-token')).toHaveCount(0);

  // The note window's outbox holds it, and sends it once the token is saved (A1012).
  await expect.poll(() => fakeIssue(issueTitle).then(Boolean), { timeout: 20_000 }).toBe(true);
  const issue = (await fakeIssue(issueTitle))!;
  expect(issue.labels).toEqual(['in-app feedback', 'feature request', 'P3']);
  expect(issue.body).not.toContain('![screenshot-');
  expect(issue.body).toMatch(/Sent from Penmoss Mac .+ · submission [0-9A-HJKMNP-TV-Z]{26}/);
  expect(issue.body).not.toContain(MARKER);

  // Away from a note (Settings, in the main window), the window's capture, taken by the main
  // process before the form was drawn, is offered unticked (A798).
  await app.evaluate(() => {
    (globalThis as unknown as Hooks).penmossDesktop.mainWindow()!.emit('focus');
  });
  await chooseMenu(app, 'app.sendFeedback');
  const again = page.getByRole('dialog', { name: 'Send Feedback' });
  await expect(again).toBeVisible();
  const shot = again.getByTestId('feedback-shot');
  await expect(shot).toHaveCount(1);
  await expect(shot).toContainText('Send this capture of the window');
  await expect(shot.locator('img')).toHaveAttribute('alt', 'Screenshot 1: This window.png');
  await expect(shot.getByTestId('feedback-shot-include')).not.toBeChecked();
});
