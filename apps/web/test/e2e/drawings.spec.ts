import { readFileSync } from 'node:fs';
import { expect, macContext, PREVIEW, seeded, test, type Locator, type Page } from './fixtures';
import { remoteFiles, remoteMarkdown } from './support/remote';
import { remoteBytes } from './support/sync';

// PEN-28: drawings. The slash menu's Diagram: Excalidraw opens Excalidraw over the window; Done
// stores the scene as `attachments/<sha256>.excalidraw` and its picture as
// `attachments/<sha256>.svg`, and the note shows the SVG, linked to the scene:
// `[![Excalidraw Diagram](….svg)](….excalidraw)`. A click selects it; its Edit button (or Enter)
// opens it again, with its shapes, and its Delete button removes it. Each edit is a new pair of
// files.

const ULID = /\/notes\/([0-9A-HJKMNP-TV-Z]{26})$/;
const TAG = `d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const DRAWING =
  /\[!\[Excalidraw Diagram\]\(attachments\/([0-9a-f]{64})\.svg\)\]\(attachments\/([0-9a-f]{64})\.excalidraw\)/;

const body = (page: Page) => page.getByTestId('note-body').locator('.ProseMirror');
const editor = (page: Page) => page.getByTestId('drawing-editor');

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error' && !/WebSocket|net::/.test(message.text())) {
      errors.push(message.text());
    }
  });
  page.on('pageerror', (error) => errors.push(error.message));
  return errors;
}

/** Whether `button`'s background, in whatever colour syntax it computes to, is fully opaque. */
async function opaque(button: Locator): Promise<boolean> {
  return button.evaluate((element) => {
    const context = document.createElement('canvas').getContext('2d')!;
    context.fillStyle = getComputedStyle(element).backgroundColor;
    context.fillRect(0, 0, 1, 1);
    return context.getImageData(0, 0, 1, 1).data[3] === 255;
  });
}

async function createNote(page: Page, title: string): Promise<string> {
  await page
    .getByTestId('sidebar-shortcuts')
    .getByRole('button', { name: 'New Note', exact: true })
    .click();
  await expect(page).toHaveURL(ULID);
  await expect(page.getByTestId('note-title')).toBeFocused();
  await page.keyboard.type(title);
  await page.keyboard.press('Enter');
  return ULID.exec(new URL(page.url()).pathname)![1]!;
}

/** Picks the slash menu's Diagram: Excalidraw: the drawing editor opens at once, on an empty scene. */
async function newDrawing(page: Page) {
  await page.keyboard.type('/drawing');
  const slash = page.getByTestId('slash-menu');
  await expect(slash.getByRole('option', { selected: true })).toContainText('Diagram: Excalidraw');
  await page.keyboard.press('Enter');
  await expect(editor(page)).toBeVisible({ timeout: 30_000 });
  await expect(editor(page)).toHaveAttribute('aria-label', 'New Excalidraw Diagram');
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

/** Excalidraw's keys for its tools (its toolbar's radios are visually hidden inputs). */
const TOOL_KEYS: Readonly<Record<string, string>> = { rectangle: 'r', ellipse: 'o', text: 't' };

/** Draws a shape with Excalidraw's `tool` (rectangle, ellipse) from `from` to `to`. */
async function drawShape(
  page: Page,
  tool: string,
  from: { x: number; y: number },
  to: { x: number; y: number },
) {
  const canvas = editor(page).locator('canvas.interactive');
  await expect(canvas).toBeVisible();
  const box = (await canvas.boundingBox())!;
  const before = Number(await editor(page).getAttribute('data-shapes'));
  await page.keyboard.press(TOOL_KEYS[tool]!);
  await expect(
    editor(page).getByRole('radio', { name: new RegExp(`^${tool}`, 'i') }),
  ).toBeChecked();
  await page.mouse.move(box.x + from.x, box.y + from.y);
  await page.mouse.down();
  await page.mouse.move(box.x + to.x, box.y + to.y, { steps: 8 });
  await page.mouse.up();
  await expect(editor(page)).toHaveAttribute('data-shapes', String(before + 1));
}

/** A scene file's elements, by type. */
function shapes(scene: Buffer): string[] {
  const data = JSON.parse(scene.toString('utf8')) as {
    type: string;
    elements: { type: string; isDeleted?: boolean }[];
  };
  expect(data.type).toBe('excalidraw');
  return data.elements.filter((element) => !element.isDeleted).map((element) => element.type);
}

test('PEN-28: draw in a note, save it as files in git, open it again and edit it', async ({
  page,
  host,
  notebook,
}) => {
  test.setTimeout(150_000);
  const errors = collectErrors(page);
  await page.goto('/');
  const id = await createNote(page, `Sketches ${TAG}`);
  await page.keyboard.type('The garden beds, drawn:');
  await page.keyboard.press('Enter');

  // Cancel leaves the note as it was.
  await newDrawing(page);
  await drawShape(page, 'rectangle', { x: 420, y: 200 }, { x: 640, y: 360 });
  await editor(page).getByRole('button', { name: 'Cancel' }).click();
  await expect(editor(page)).toBeHidden();
  await expect(body(page).getByTestId('drawing')).toHaveCount(0);

  // A new drawing: a rectangle, then Done. The note shows it, as wide as a picture.
  await newDrawing(page);
  await drawShape(page, 'rectangle', { x: 420, y: 200 }, { x: 640, y: 360 });
  await editor(page).getByRole('button', { name: 'Done' }).click();
  await expect(editor(page)).toBeHidden();
  const drawing = body(page).getByTestId('drawing');
  await expect(drawing).toHaveCount(1);
  await expect(drawing).toHaveAttribute('data-state', 'ready');
  await expect(drawing.locator('img')).toHaveAttribute('src', /^data:image\/svg\+xml;base64,/);
  expect(
    await drawing.locator('img').evaluate((img: HTMLImageElement) => img.naturalWidth),
  ).toBeGreaterThan(100);

  // The repository holds both files, and the markdown names both: the SVG as a picture,
  // linked to its scene.
  const { remote } = seeded(notebook);
  await expect
    .poll(() => DRAWING.test(remoteMarkdown(host, remote, id) ?? ''), {
      timeout: 60_000,
      intervals: [2_000],
    })
    .toBe(true);
  const [, svgSha, sceneSha] = DRAWING.exec(remoteMarkdown(host, remote, id)!)!;
  const firstSvg = `attachments/${svgSha}.svg`;
  const firstScene = `attachments/${sceneSha}.excalidraw`;
  await expect
    .poll(() => remoteFiles(host, remote), { timeout: 60_000, intervals: [2_000] })
    .toEqual(expect.arrayContaining([firstSvg, firstScene]));
  expect(shapes(remoteBytes(host, remote, firstScene))).toEqual(['rectangle']);
  const svg = remoteBytes(host, remote, firstSvg).toString('utf8');
  expect(svg).toMatch(/^<svg[^>]* xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);

  // A click selects it, and opens nothing; its Edit and Delete buttons show in its corner.
  const editButton = drawing.getByRole('button', { name: 'Edit Excalidraw Diagram' });
  const deleteButton = drawing.getByRole('button', { name: 'Delete Excalidraw Diagram' });
  await body(page).getByText('The garden beds, drawn:').click();
  await page.mouse.move(0, 0);
  await expect(editButton).toBeHidden();
  await drawing.locator('img').click();
  await expect(drawing).toHaveClass(/ProseMirror-selectednode/);
  await expect(editor(page)).toBeHidden();
  await page.mouse.move(0, 0);
  await expect(editButton).toBeVisible();
  await expect(deleteButton).toBeVisible();
  // Both are opaque over the drawing's lines, Delete's red tint too while pointed at (R2-16).
  expect(await opaque(editButton)).toBe(true);
  await deleteButton.hover();
  expect(await opaque(deleteButton)).toBe(true);
  await page.mouse.move(0, 0);

  // Edit opens it again, with its rectangle; an ellipse added and Done point the note at a new
  // pair of files.
  await editButton.click();
  await expect(editor(page)).toBeVisible();
  await expect(editor(page)).toHaveAttribute('aria-label', 'Edit Excalidraw Diagram');
  await expect(editor(page)).toHaveAttribute('data-shapes', '1');
  await drawShape(page, 'ellipse', { x: 700, y: 200 }, { x: 880, y: 360 });
  await editor(page).getByRole('button', { name: 'Done' }).click();
  await expect(editor(page)).toBeHidden();
  await expect(drawing).toHaveAttribute('data-state', 'ready');
  await expect
    .poll(
      () => {
        const found = DRAWING.exec(remoteMarkdown(host, remote, id) ?? '');
        return found ? `attachments/${found[2]}.excalidraw` : null;
      },
      { timeout: 60_000, intervals: [2_000] },
    )
    .not.toBe(firstScene);
  const [, , secondSha] = DRAWING.exec(remoteMarkdown(host, remote, id)!)!;
  await expect
    .poll(() => remoteFiles(host, remote), { timeout: 60_000, intervals: [2_000] })
    .toEqual(expect.arrayContaining([`attachments/${secondSha}.excalidraw`]));
  expect(shapes(remoteBytes(host, remote, `attachments/${secondSha}.excalidraw`)).sort()).toEqual([
    'ellipse',
    'rectangle',
  ]);

  // Selected, Enter opens it again: it has both shapes.
  await drawing.locator('img').click();
  await expect(drawing).toHaveClass(/ProseMirror-selectednode/);
  await page.keyboard.press('Enter');
  await expect(editor(page)).toBeVisible();
  await expect(editor(page)).toHaveAttribute('data-shapes', '2');
  await page.waitForTimeout(2_000);
  await editor(page).getByRole('button', { name: 'Cancel' }).click();
  await expect(editor(page)).toBeHidden();

  // Delete takes it out of the note, and Undo brings it back.
  await drawing.hover();
  await deleteButton.click();
  await expect(body(page).getByTestId('drawing')).toHaveCount(0);
  await page.keyboard.press('ControlOrMeta+KeyZ');
  await expect(body(page).getByTestId('drawing')).toHaveCount(1);
  await expect(drawing).toHaveAttribute('data-state', 'ready');

  // The editor's bar is the window's title bar (R2-18): Back and Forward as the window has them
  // (no pin outside the Mac app), the title, then Cancel and Done. Back keeps the drawing, as
  // Done does, then goes back; Forward comes back to the note with it.
  await drawing.hover();
  await editButton.click();
  await expect(editor(page)).toHaveAttribute('data-shapes', '2');
  const bar = editor(page).getByTestId('drawing-editor-bar');
  await expect(bar.getByRole('button', { name: 'Back' })).toBeEnabled();
  await expect(bar.getByRole('button', { name: 'Forward' })).toBeDisabled();
  await expect(bar.getByTestId('drawing-editor-pin')).toHaveCount(0);
  // Nothing after the bar in the page lies over its title: in the Mac app a later region wins, so
  // Excalidraw's window-wide layers would take the drag from it (R2-17).
  expect(
    await bar.evaluate((element) => {
      const title = element.querySelector('.drawing-editor-title')!.getBoundingClientRect();
      const [x, y] = [title.left + 4, title.top + title.height / 2];
      return [...document.querySelectorAll('body *')]
        .filter(
          (other) =>
            element.compareDocumentPosition(other) & Node.DOCUMENT_POSITION_FOLLOWING &&
            !element.contains(other),
        )
        .filter((other) => {
          const box = other.getBoundingClientRect();
          return x >= box.left && x < box.right && y >= box.top && y < box.bottom;
        })
        .map((other) => other.className.toString());
    }),
  ).toEqual([]);
  await drawShape(page, 'rectangle', { x: 300, y: 440 }, { x: 420, y: 540 });
  await bar.getByRole('button', { name: 'Back' }).click();
  await expect(editor(page)).toBeHidden();
  await expect(page).not.toHaveURL(new RegExp(id));
  await page.goForward();
  await expect(page).toHaveURL(new RegExp(id));
  await expect(drawing).toHaveAttribute('data-state', 'ready');
  await expect
    .poll(
      () => {
        const found = DRAWING.exec(remoteMarkdown(host, remote, id) ?? '');
        if (!found) return null;
        try {
          return shapes(remoteBytes(host, remote, `attachments/${found[2]}.excalidraw`)).length;
        } catch {
          return null;
        }
      },
      { timeout: 60_000, intervals: [2_000] },
    )
    .toBe(3);

  // The proof's last frame: the drawing back in the note, its buttons on hover.
  await drawing.scrollIntoViewIfNeeded();
  await drawing.hover();
  await expect(editButton).toBeVisible();
  await page.waitForTimeout(2_000);
  expect(errors).toEqual([]);
});

test('R2-19: Save To… saves the scene, and Export Image… its picture, as downloads', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const errors = collectErrors(page);
  await page.goto('/');
  await createNote(page, `Exports ${TAG}`);
  await newDrawing(page);
  await drawShape(page, 'rectangle', { x: 420, y: 200 }, { x: 640, y: 360 });

  // The ☰ menu: Save To… and Export Image…, nothing that opens a file over the drawing.
  await editor(page).getByTestId('main-menu-trigger').click();
  await expect(editor(page).getByTestId('json-export-button')).toBeVisible();
  await expect(editor(page).getByTestId('image-export-button')).toBeVisible();
  await expect(editor(page).getByTestId('load-button')).toHaveCount(0);

  // In the Mac app (this suite's page has its bridge) a file is a download, which the main
  // process asks where to save; Chromium's own file picker is not used.
  const saved = async (click: () => Promise<void>) => {
    const download = page.waitForEvent('download');
    await click();
    const file = await download;
    return { name: file.suggestedFilename(), bytes: readFileSync(await file.path()) };
  };

  // Save To… saves the scene, a `.excalidraw` file with its rectangle.
  await editor(page).getByTestId('json-export-button').click();
  const scene = await saved(() => page.getByRole('button', { name: 'Save to file' }).click());
  expect(scene.name).toMatch(/\.excalidraw$/);
  expect(shapes(scene.bytes)).toEqual(['rectangle']);
  await closeExcalidrawDialog(page);

  // Export Image…: a PNG, and an SVG, of the drawing.
  await editor(page).getByTestId('main-menu-trigger').click();
  await editor(page).getByTestId('image-export-button').click();
  const png = await saved(() => page.getByRole('button', { name: 'Export to PNG' }).click());
  expect(png.name).toMatch(/\.png$/);
  expect([...png.bytes.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  const svg = await saved(() => page.getByRole('button', { name: 'Export to SVG' }).click());
  expect(svg.name).toMatch(/\.svg$/);
  expect(svg.bytes.toString('utf8')).toMatch(/<svg[^>]* xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  await closeExcalidrawDialog(page);

  // The drawing is still being edited: Cancel leaves the note as it was.
  await editor(page).getByRole('button', { name: 'Cancel' }).click();
  await expect(editor(page)).toBeHidden();
  await expect(body(page).getByTestId('drawing')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('PEN-28: the production build draws offline under the app CSP, its fonts bundled', async ({
  browser,
  host,
}) => {
  test.setTimeout(120_000);
  const context = await macContext(browser, host, { baseURL: PREVIEW });
  try {
    const page = await context.newPage();
    const errors = collectErrors(page);
    // Nothing the drawing editor needs comes from anywhere but the app (no CDN fonts).
    const elsewhere: string[] = [];
    page.on('request', (request) => {
      const url = new URL(request.url());
      if (!['localhost', '127.0.0.1'].includes(url.hostname) && /^https?:$/.test(url.protocol)) {
        elsewhere.push(request.url());
      }
    });
    await page.addInitScript(() => {
      const seen: string[] = [];
      Object.assign(window, { cspViolations: seen });
      document.addEventListener('securitypolicyviolation', (event) =>
        seen.push(`${event.violatedDirective} ${event.blockedURI}`),
      );
    });
    await page.goto('/');
    await createNote(page, `CSP drawing ${TAG}`);
    await newDrawing(page);
    await drawShape(page, 'rectangle', { x: 420, y: 200 }, { x: 620, y: 320 });
    // Text, in Excalidraw's hand-drawn font, which the SVG carries inlined.
    const canvas = editor(page).locator('canvas.interactive');
    const box = (await canvas.boundingBox())!;
    await page.keyboard.press(TOOL_KEYS['text']!);
    await page.mouse.click(box.x + 700, box.y + 260);
    await page.keyboard.type('Beds');
    await page.keyboard.press('Escape');
    await expect(editor(page)).toHaveAttribute('data-shapes', '2');
    await editor(page).getByRole('button', { name: 'Done' }).click();
    await expect(editor(page)).toBeHidden();
    const drawing = body(page).getByTestId('drawing');
    await expect(drawing).toHaveAttribute('data-state', 'ready');
    const svg = await drawing
      .locator('img')
      .evaluate((img: HTMLImageElement) => atob(img.src.slice(img.src.indexOf(',') + 1)));
    expect(svg).toContain('Beds');
    // Excalidraw's hand-drawn font, inlined from the app's own copy (no CDN, no CSP violation).
    expect(svg).toMatch(
      /@font-face \{ font-family: "Excalifont"; src: url\(data:font\/woff2;base64,/,
    );
    expect(
      await page.evaluate(() => (window as unknown as { cspViolations: string[] }).cspViolations),
    ).toEqual([]);
    expect(elsewhere).toEqual([]);
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});
