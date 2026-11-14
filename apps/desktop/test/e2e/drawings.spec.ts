import { expect, test, type Page } from '@playwright/test';
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

// PEN-28 in the Mac app: the slash menu's Excalidraw Diagram opens Excalidraw over the window,
// from the app's own files (its fonts too: the app works offline, and its CSP allows nothing else). Done
// puts the drawing in the note and its two files in the notebook's repository; a click selects it
// and its Edit button opens it again with its shapes. The web suite (apps/web/test/e2e/drawings.spec.ts) covers editing a
// drawing again and the production build's CSP.

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
  const launched = await launch();
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

  // The slash menu's Excalidraw Diagram opens the drawing editor at once.
  await page.keyboard.type('/drawing');
  const slash = page.getByTestId('slash-menu');
  await expect(slash.getByRole('option', { selected: true })).toContainText('Excalidraw Diagram');
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
  await page.waitForTimeout(2_000);
  await editor(page).getByRole('button', { name: 'Cancel' }).click();
  await expect(editor(page)).toBeHidden();

  // The proof's last frame: the drawing in the note.
  await drawing.scrollIntoViewIfNeeded();
  await expect(drawing).toHaveAttribute('data-state', 'ready');
  await page.waitForTimeout(2_000);
  expect(errors).toEqual([]);
});
