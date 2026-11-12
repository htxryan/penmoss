import { expect, test, type ElectronApplication } from '@playwright/test';
import {
  body,
  capturePage,
  gitNotebook,
  launch,
  removeDataDirs,
  ULID,
  type Launched,
} from './support';

// PEN-120: Install and Restart quits the app. Electron's `autoUpdater.quitAndInstall()` emits
// `before-quit-for-update`, closes every window, and only then emits `before-quit`. An unsigned
// build is never offered an update, so the spec does what quitAndInstall does, with the capture
// window made (as at every launch): the app must quit by itself, the last keystrokes stored.

const mac = process.platform === 'darwin';
const NEW_NOTE = mac ? 'Meta+Alt+KeyN' : 'Alt+KeyN';
const opened: Launched[] = [];

test.afterEach(async () => {
  for (const { app } of opened.splice(0)) await app.close().catch(() => undefined);
});
test.afterAll(() => removeDataDirs());

async function start(options: Parameters<typeof launch>[0] = {}): Promise<Launched> {
  const launched = await launch(options);
  opened.push(launched);
  return launched;
}

interface MainHooks {
  penmossDesktop: { captureWindow(): object | null };
}

/**
 * What Electron's quitAndInstall does (electron_api_auto_updater.cc): it emits
 * `before-quit-for-update`, closes every window, and once none is left hands over to ShipIt and
 * quits, which `app.quit()` stands in for here.
 */
function quitAndInstallAsElectronDoes(app: ElectronApplication): Promise<void> {
  return app.evaluate(({ app: electronApp, autoUpdater, BrowserWindow }) => {
    autoUpdater.emit('before-quit-for-update');
    electronApp.once('window-all-closed', () => electronApp.quit());
    for (const window of BrowserWindow.getAllWindows()) window.close();
  });
}

test('Install and Restart quits the app with the capture window open, the last keystrokes kept', async () => {
  const tag = `u${Date.now().toString(36)}`;
  const first = await start();
  const { page, app } = first;
  await gitNotebook(first);
  await capturePage(app);
  expect(
    await app.evaluate(
      () => (globalThis as unknown as MainHooks).penmossDesktop.captureWindow() !== null,
    ),
  ).toBe(true);

  await expect(page.locator('button[data-command="note.new"]')).toBeVisible();
  await page.keyboard.press(NEW_NOTE);
  await expect(page).toHaveURL(ULID);
  await expect(page.getByTestId('note-title')).toBeFocused();
  await page.keyboard.type(`Update ${tag}`);
  await page.keyboard.press('Enter');
  await page.keyboard.type(`before the update ${tag}`);
  await expect(body(page)).toContainText(`before the update ${tag}`);
  const id = ULID.exec(new URL(page.url()).pathname)![1]!;
  await page.waitForTimeout(2_000);
  await page.keyboard.type(` and the very last ${tag}`);

  // Without the fix the capture window only hides, so a window is left, the app never quits, and
  // this times out.
  const closed = app.waitForEvent('close', { timeout: 30_000 });
  await quitAndInstallAsElectronDoes(app);
  await closed;
  opened.splice(opened.indexOf(first), 1);

  // As ShipIt opens the new version: the note has every keystroke.
  const again = await start({
    userData: first.userData,
    offline: true,
    args: [`penmoss://note/${id}`],
  });
  await expect(again.page).toHaveURL(`app://penmoss/notes/${id}`);
  await expect(again.page.getByTestId('note-view')).toHaveAttribute('data-ready', 'true', {
    timeout: 20_000,
  });
  await expect(body(again.page)).toContainText(`before the update ${tag} and the very last ${tag}`);
  await again.page.waitForTimeout(2_000);
  await expect(body(again.page)).toContainText(`and the very last ${tag}`);
});
