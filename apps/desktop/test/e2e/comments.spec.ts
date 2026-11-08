import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import {
  body,
  launch,
  mainBounds,
  removeDataDirs,
  gitNotebook,
  ULID,
  type Launched,
} from './support';

// T48 in the Mac app: comment threads on a note, the View menu's Comments, and a note window
// (T45) showing the same threads, where a reply written there shows at once in the main window.
// The web suite (apps/web/test/e2e/comments.spec.ts) covers the panel and the agent round trip.

const mac = process.platform === 'darwin';
const NEW_NOTE = mac ? 'Meta+Alt+KeyN' : 'Alt+KeyN';
const RUN = `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
const WINDOW = /^app:\/\/penmoss\/window\/notes\/[0-9A-HJKMNP-TV-Z]{26}$/;
const opened: Launched[] = [];

test.afterEach(async () => {
  for (const { app } of opened.splice(0)) await app.close().catch(() => undefined);
});
test.afterAll(() => removeDataDirs());

/** Chooses a menu item, as a click on it would. */
const chooseMenu = (app: ElectronApplication, id: string) =>
  app.evaluate(({ Menu }, itemId) => {
    (Menu.getApplicationMenu()?.getMenuItemById(itemId) as unknown as { click(): void }).click();
  }, id);

/** Brings a window to the front as macOS does: its `focus` event (xvfb has no window manager). */
const focus = (app: ElectronApplication, which: 'main' | number) =>
  app.evaluate((_electron, target) => {
    const hooks = (
      globalThis as unknown as {
        penmossDesktop: {
          mainWindow(): Electron.BrowserWindow | null;
          noteWindows(): Electron.BrowserWindow[];
        };
      }
    ).penmossDesktop;
    const window = target === 'main' ? hooks.mainWindow() : hooks.noteWindows()[target];
    window!.emit('focus');
  }, which);

async function selectText(page: Page, text: string): Promise<void> {
  await body(page).evaluate((root, wanted) => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const at = node.textContent?.indexOf(wanted) ?? -1;
      if (at < 0) continue;
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + wanted.length);
      window.getSelection()!.removeAllRanges();
      window.getSelection()!.addRange(range);
      (root as HTMLElement).focus();
      return;
    }
    throw new Error(`no "${wanted}"`);
  }, text);
}

test('comments in the Mac app: the View menu, and a note window showing the same threads live', async () => {
  const launched = await launch();
  opened.push(launched);
  const { app, page } = launched;
  await mainBounds(app, { x: 0, y: 0, width: 1300, height: 800 });
  await gitNotebook(launched);
  await expect(page.locator('button[data-command="note.new"]')).toBeVisible();
  await page.keyboard.press(NEW_NOTE);
  await expect(page).toHaveURL(ULID);
  const title = `Mac comments ${RUN}`;
  await page.keyboard.type(title);
  await page.keyboard.press('Enter');
  await page.keyboard.type('The garden plan needs work.');

  await selectText(page, 'garden plan');
  await page.getByTestId('selection-toolbar').getByRole('button', { name: 'Comment' }).click();
  // Written floating over the note at the selection (T52 item 5), not in the panel.
  await expect(page.getByTestId('comment-popover').getByTestId('comment-draft')).toContainText(
    'garden plan',
  );
  await page.getByTestId('comment-new').fill('Make this tighter');
  await page.getByTestId('comment-new-send').click();
  await expect(page.getByTestId('comment-popover')).toHaveCount(0);
  await expect(body(page).locator('.pm-comment')).toHaveText('garden plan');
  if (!(await page.getByTestId('comments-panel').isVisible())) {
    await chooseMenu(app, 'note.comments');
  }
  await expect(page.getByTestId('comment-thread')).toHaveCount(1);

  // View → Comments closes the panel and opens it again.
  await chooseMenu(app, 'note.comments');
  await expect(page.getByTestId('comments-panel')).toHaveCount(0);
  await chooseMenu(app, 'note.comments');
  await expect(page.getByTestId('comments-panel')).toBeVisible();

  // A note window (T45): the same thread, and a reply there shows in the main window.
  const [window] = await Promise.all([
    app.waitForEvent('window'),
    chooseMenu(app, 'note.openInNewWindow'),
  ]);
  await expect(window).toHaveURL(WINDOW);
  await expect(window.getByTestId('note-view')).toHaveAttribute('data-ready', 'true');
  await focus(app, 0);
  await expect(window.locator('.ProseMirror .pm-comment')).toHaveText('garden plan');
  if (!(await window.getByTestId('comments-panel').isVisible())) {
    await chooseMenu(app, 'note.comments');
  }
  const thread = window.getByTestId('comment-thread');
  await expect(thread.getByTestId('comment-body')).toHaveText('Make this tighter');
  await thread.getByRole('button', { name: 'Reply' }).click();
  await window.getByTestId('comment-reply').fill('From the note window');
  await window.getByTestId('comment-reply-send').click();
  await focus(app, 'main');
  await expect(
    page.getByTestId('comment-body').filter({ hasText: 'From the note window' }),
  ).toBeVisible();
});
