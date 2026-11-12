import { expect, test, type ElectronApplication } from '@playwright/test';
import { body, gitNotebook, launch, removeDataDirs, ULID, type Launched } from './support';

// PEN-122 (A1338): with the app's output piped into something that exits early
// (`Penmoss | head -3`), the main process's next log line failed with `write EPIPE`, and Electron
// showed "A JavaScript error occurred in the main process" until someone clicked OK. Now a closed
// stdout or stderr is dropped: the app keeps logging into nothing and keeps working.
//
// The spec closes both streams in the main process as a pipe whose reader has gone does (they
// fail with EPIPE), logs as the app does, and checks that nothing reached `uncaughtException`
// (the listener it adds also keeps Electron's dialog away if that ever regresses, so the test
// fails rather than hangs) and that the window still makes and edits a note.

const NEW_NOTE = process.platform === 'darwin' ? 'Meta+Alt+KeyN' : 'Alt+KeyN';
const RUN = `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
const opened: Launched[] = [];

test.afterEach(async () => {
  for (const { app } of opened.splice(0)) await app.close().catch(() => undefined);
});
test.afterAll(() => removeDataDirs());

interface Spy {
  penmossUncaught: string[];
}

/** Closes stdout and stderr as an early-exiting reader does, then logs as the app does. */
async function closeOutputAndLog(app: ElectronApplication): Promise<void> {
  await app.evaluate(() => {
    const spy = globalThis as unknown as Spy;
    spy.penmossUncaught = [];
    process.on('uncaughtException', (error) => spy.penmossUncaught.push(String(error)));
    const epipe = () =>
      Object.assign(new Error('write EPIPE'), { code: 'EPIPE', errno: -32, syscall: 'write' });
    process.stdout.destroy(epipe());
    process.stderr.destroy(epipe());
    // Later, outside this call, as the app's next log lines would be.
    setTimeout(() => {
      console.log('[penmoss] a log line after the reader left');
      console.error('[penmoss] an error line after the reader left');
      process.stdout.write('[penmoss] a direct write after the reader left\n');
    }, 50);
  });
  await new Promise((resolve) => setTimeout(resolve, 500));
}

const uncaught = (app: ElectronApplication) =>
  app.evaluate(() => (globalThis as unknown as Spy).penmossUncaught);

test('a closed stdout and stderr never show the main-process error, and the app keeps working', async () => {
  const launched = await launch();
  opened.push(launched);
  const { app, page, errors } = launched;
  await gitNotebook(launched); // A fresh launch shows Welcome; open a notebook first.
  await expect(page.locator('button[data-command="note.new"]')).toBeVisible();

  await closeOutputAndLog(app);
  expect(await uncaught(app)).toEqual([]);

  // The app is not stuck behind a dialog: it makes a note and takes typing.
  await page.keyboard.press(NEW_NOTE);
  await expect(page).toHaveURL(ULID);
  await expect(page.getByTestId('note-title')).toBeFocused();
  await page.keyboard.type(`Still working ${RUN}`);
  await page.keyboard.press('Enter');
  await page.keyboard.type(`Logged into a closed pipe, and nothing broke ${RUN}.`);
  await expect(body(page)).toContainText(`Logged into a closed pipe, and nothing broke ${RUN}.`);

  // The app keeps logging (saving and syncing the note) into the closed streams.
  await page.waitForTimeout(2000);
  expect(await uncaught(app)).toEqual([]);
  await expect(page.getByTestId('note-title')).toHaveValue(`Still working ${RUN}`);
  expect(errors).toEqual([]);
});
