import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import {
  body,
  collectErrors,
  gitNotebook,
  launch,
  mainBounds,
  removeDataDirs,
  repositoryFile,
  repositoryFiles,
  ULID,
  type Launched,
} from './support';

// PEN-28 in the Mac app: the slash menu's Diagram: Excalidraw opens Excalidraw over the window,
// from the app's own files (its fonts too: the app works offline, and its CSP allows nothing else). Done
// puts the drawing in the note and its two files in the notebook's repository; a click selects it
// and its Edit button opens it again with its shapes. The editor's bar is the window's title bar
// (R2-17, R2-18): its empty part drags the window, after the lights come Back, Forward and the
// pin. Save To… and Export Image… save through a download that asks where to put it (R2-19). The
// web suite (apps/web/test/e2e/drawings.spec.ts) covers editing a drawing again, Back keeping it,
// and the production build's CSP.

const mac = process.platform === 'darwin';
const NEW_NOTE = mac ? 'Meta+Alt+KeyN' : 'Alt+KeyN';
const DRAWING =
  /\[!\[Excalidraw Diagram\]\(attachments\/([0-9a-f]{64})\.svg\)\]\(attachments\/([0-9a-f]{64})\.excalidraw\)/;
const opened: Launched[] = [];

test.afterEach(async () => {
  for (const { app } of opened.splice(0)) await app.close().catch(() => undefined);
});
test.afterAll(() => removeDataDirs());

const editor = (page: Page) => page.getByTestId('drawing-editor');

/**
 * The region Electron gives the point (A723, A1123): of the elements with one there, the last in
 * the DOM wins, as later regions are applied over earlier ones (as mac-window.spec.ts reads it).
 */
const regionAt = (page: Page, x: number, y: number) =>
  page.evaluate(
    ([px, py]) => {
      let won = 'none';
      for (const element of document.querySelectorAll<HTMLElement>('body *')) {
        const style = getComputedStyle(element);
        const value = style.getPropertyValue('-webkit-app-region');
        if (value !== 'drag' && value !== 'no-drag') continue;
        if (style.visibility !== 'visible') continue;
        const box = element.getBoundingClientRect();
        if (px >= box.left && px < box.right && py >= box.top && py < box.bottom) won = value;
      }
      return won;
    },
    [x, y] as const,
  );

/** A download the page starts, as the main process sent it on (R2-19). */
interface Download {
  readonly name: string;
  readonly dialog: { title?: string; defaultPath?: string; filters?: unknown };
  readonly path: string;
}

/**
 * Saves each download the page starts into `dir`, where a person would have chosen in the save
 * dialog, and records the dialog's options as the app set them (its own listener runs first).
 */
async function catchDownloads(app: ElectronApplication, dir: string) {
  await app.evaluate(({ session }, folder) => {
    const caught: unknown[] = [];
    Object.assign(globalThis, { penmossDownloads: caught });
    session.defaultSession.on('will-download', (_event, item) => {
      const path = `${folder}/${item.getFilename()}`;
      caught.push({ name: item.getFilename(), dialog: item.getSaveDialogOptions(), path });
      item.setSavePath(path);
    });
  }, dir);
  return {
    list: () =>
      app.evaluate(
        () => (globalThis as unknown as { penmossDownloads: Download[] }).penmossDownloads,
      ),
  };
}

/**
 * Closes Excalidraw's open dialog (Save To…, Export Image…), if one is open, with Escape from a
 * button in it (its close button shows only at a phone's width).
 */
async function closeExcalidrawDialog(page: Page) {
  const modal = page.locator('.excalidraw-modal-container .Modal');
  if (await modal.count()) await modal.getByRole('button').first().press('Escape');
  await expect(modal).toHaveCount(0);
}

/** Draws a rectangle (Excalidraw's R) from `from` to `to`, in the canvas's own coordinates. */
async function drawRectangle(
  page: Page,
  from: { x: number; y: number },
  to: { x: number; y: number },
) {
  const canvas = editor(page).locator('canvas.interactive');
  await expect(canvas).toBeVisible();
  const box = (await canvas.boundingBox())!;
  const before = Number(await editor(page).getAttribute('data-shapes'));
  await page.keyboard.press('r');
  await expect(editor(page).getByRole('radio', { name: /^Rectangle/ })).toBeChecked();
  await page.mouse.move(box.x + from.x, box.y + from.y);
  await page.mouse.down();
  await page.mouse.move(box.x + to.x, box.y + to.y, { steps: 8 });
  await page.mouse.up();
  await expect(editor(page)).toHaveAttribute('data-shapes', String(before + 1));
}

test('a drawing made from the slash menu shows in the note and is kept as files in git', async () => {
  const launched = await launch({ macWindow: true });
  opened.push(launched);
  const { app, page } = launched;
  const errors = collectErrors(page, false);
  await mainBounds(app, { x: 0, y: 0, width: 1280, height: 720 });
  const { remote } = await gitNotebook(launched);
  await expect(page.locator('button[data-command="note.new"]')).toBeVisible();
  await page.keyboard.press(NEW_NOTE);
  await expect(page).toHaveURL(ULID);
  await page.keyboard.type('Garden sketch');
  await page.keyboard.press('Enter');
  await page.keyboard.type('The beds, drawn:');
  await page.keyboard.press('Enter');

  // The slash menu's Diagram: Excalidraw opens the drawing editor at once.
  await page.keyboard.type('/drawing');
  const slash = page.getByTestId('slash-menu');
  await expect(slash.getByRole('option', { selected: true })).toContainText('Diagram: Excalidraw');
  await page.keyboard.press('Enter');
  await expect(editor(page)).toBeVisible({ timeout: 30_000 });
  await expect(editor(page)).toHaveAttribute('aria-label', 'New Excalidraw Diagram');
  await drawRectangle(page, { x: 420, y: 200 }, { x: 680, y: 380 });
  await editor(page).getByRole('button', { name: 'Done' }).click();
  await expect(editor(page)).toBeHidden();

  // In the note, as wide as a picture.
  const drawing = body(page).getByTestId('drawing');
  await expect(drawing).toHaveAttribute('data-state', 'ready');
  expect(
    await drawing.locator('img').evaluate((img: HTMLImageElement) => img.naturalWidth),
  ).toBeGreaterThan(100);

  // In git: the markdown shows the SVG, linked to the scene, and both files are there.
  const note = () => repositoryFiles(remote).find((path) => path.endsWith('Garden sketch.md'));
  await expect
    .poll(() => (note() ? DRAWING.test(repositoryFile(remote, note()!)) : false), {
      timeout: 90_000,
      intervals: [2_000],
    })
    .toBe(true);
  const [, svg, scene] = DRAWING.exec(repositoryFile(remote, note()!))!;
  await expect
    .poll(() => repositoryFiles(remote), { timeout: 90_000, intervals: [2_000] })
    .toEqual(expect.arrayContaining([`attachments/${svg}.svg`, `attachments/${scene}.excalidraw`]));
  const saved = JSON.parse(repositoryFile(remote, `attachments/${scene}.excalidraw`)) as {
    type: string;
    elements: { type: string }[];
  };
  expect(saved.type).toBe('excalidraw');
  expect(saved.elements.map((element) => element.type)).toEqual(['rectangle']);
  expect(repositoryFile(remote, `attachments/${svg}.svg`)).toMatch(/^<svg[^>]* xmlns=/);

  // A click selects it; its Edit button opens it again, with its rectangle.
  await drawing.locator('img').click();
  await expect(drawing).toHaveClass(/ProseMirror-selectednode/);
  await expect(editor(page)).toBeHidden();
  await drawing.getByRole('button', { name: 'Edit Excalidraw Diagram' }).click();
  await expect(editor(page)).toBeVisible();
  await expect(editor(page)).toHaveAttribute('aria-label', 'Edit Excalidraw Diagram');
  await expect(editor(page)).toHaveAttribute('data-shapes', '1');

  // Its bar is the window's title bar (R2-17, R2-18): the lights' room, then Back, Forward and the
  // pin, the title, and Cancel and Done. Its empty part drags the window; its buttons click.
  const bar = editor(page).getByTestId('drawing-editor-bar');
  await expect(bar.getByRole('button', { name: 'Back' })).toBeEnabled();
  await expect(bar.getByRole('button', { name: 'Forward' })).toBeDisabled();
  await expect(bar.getByTestId('drawing-editor-pin')).toBeVisible();
  const titled = await page.evaluate(() => document.documentElement.dataset['titlebar'] ?? null);
  if (titled === 'compact') {
    const barBox = (await bar.boundingBox())!;
    const title = (await bar.locator('.drawing-editor-title').boundingBox())!;
    const done = (await bar.getByRole('button', { name: 'Done' }).boundingBox())!;
    const back = (await bar.getByRole('button', { name: 'Back' }).boundingBox())!;
    const middle = barBox.y + barBox.height / 2;
    // Beside the title, and the empty stretch before Cancel.
    expect(await regionAt(page, title.x + 4, middle)).toBe('drag');
    expect(await regionAt(page, title.x + title.width - 4, middle)).toBe('drag');
    expect(await regionAt(page, done.x + done.width / 2, middle)).toBe('no-drag');
    expect(await regionAt(page, back.x + back.width / 2, middle)).toBe('no-drag');
    // The lights' room is clear of the buttons.
    expect(back.x).toBeGreaterThanOrEqual(80);
  }

  // The pin pins the window, and again unpins it.
  const pin = bar.getByTestId('drawing-editor-pin');
  await pin.click();
  await expect(pin).toHaveAttribute('aria-pressed', 'true');
  await pin.click();
  await expect(pin).toHaveAttribute('aria-pressed', 'false');

  // Save To… and Export Image… (R2-19): each saves through a download that asks where to save
  // it, in Downloads by default, filtered to its kind.
  const folder = join(tmpdir(), `penmoss-drawing-downloads-${Date.now()}`);
  const downloads = await catchDownloads(app, folder);
  await editor(page).getByTestId('main-menu-trigger').click();
  await expect(editor(page).getByTestId('load-button')).toHaveCount(0);
  await editor(page).getByTestId('json-export-button').click();
  await page.getByRole('button', { name: 'Save to file' }).click();
  await expect.poll(async () => (await downloads.list()).length, { timeout: 20_000 }).toBe(1);
  const [sceneFile] = await downloads.list();
  expect(sceneFile!.name).toMatch(/\.excalidraw$/);
  expect(sceneFile!.dialog).toMatchObject({
    title: 'Save',
    defaultPath: expect.stringMatching(/Downloads\/.+\.excalidraw$/),
    filters: [{ name: 'Excalidraw Scene', extensions: ['excalidraw'] }],
  });
  await expect
    .poll(() => {
      try {
        return (JSON.parse(readFileSync(sceneFile!.path, 'utf8')) as { type: string }).type;
      } catch {
        return null;
      }
    })
    .toBe('excalidraw');
  await closeExcalidrawDialog(page);
  await editor(page).getByTestId('main-menu-trigger').click();
  await editor(page).getByTestId('image-export-button').click();
  await page.getByRole('button', { name: 'Export to PNG' }).click();
  await expect.poll(async () => (await downloads.list()).length, { timeout: 20_000 }).toBe(2);
  const image = (await downloads.list())[1]!;
  expect(image.name).toMatch(/\.png$/);
  expect(image.dialog).toMatchObject({ filters: [{ name: 'PNG Image', extensions: ['png'] }] });
  await expect
    .poll(() => {
      try {
        return [...readFileSync(image.path).subarray(0, 4)];
      } catch {
        return null;
      }
    })
    .toEqual([0x89, 0x50, 0x4e, 0x47]);
  await closeExcalidrawDialog(page);

  await page.waitForTimeout(2_000);
  await editor(page).getByRole('button', { name: 'Cancel' }).click();
  await expect(editor(page)).toBeHidden();

  // The proof's last frame: the drawing in the note.
  await drawing.scrollIntoViewIfNeeded();
  await expect(drawing).toHaveAttribute('data-state', 'ready');
  await page.waitForTimeout(2_000);
  expect(errors).toEqual([]);
});
