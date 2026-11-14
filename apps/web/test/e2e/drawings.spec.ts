import { expect, macContext, PREVIEW, seeded, test, type Page } from './fixtures';
import { remoteFiles, remoteMarkdown } from './support/remote';
import { remoteBytes } from './support/sync';

// PEN-28: drawings. The slash menu's Drawing opens Excalidraw over the window; Done stores the
// scene as `attachments/<sha256>.excalidraw` and its picture as `attachments/<sha256>.svg`, and
// the note shows the SVG, linked to the scene: `[![Drawing](….svg)](….excalidraw)`. A click
// opens it again, with its shapes; each edit is a new pair of files.

const ULID = /\/notes\/([0-9A-HJKMNP-TV-Z]{26})$/;
const TAG = `d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const DRAWING =
  /\[!\[Drawing\]\(attachments\/([0-9a-f]{64})\.svg\)\]\(attachments\/([0-9a-f]{64})\.excalidraw\)/;

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

/** Picks the slash menu's Drawing: the drawing editor opens at once, on an empty scene. */
async function newDrawing(page: Page) {
  await page.keyboard.type('/drawing');
  const slash = page.getByTestId('slash-menu');
  await expect(slash.getByRole('option', { selected: true })).toContainText('Drawing');
  await page.keyboard.press('Enter');
  await expect(editor(page)).toBeVisible({ timeout: 30_000 });
  await expect(editor(page)).toHaveAttribute('aria-label', 'New Drawing');
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

  // A click opens it again, with its rectangle; an ellipse added and Done point the note at a
  // new pair of files.
  await drawing.click();
  await expect(editor(page)).toBeVisible();
  await expect(editor(page)).toHaveAttribute('aria-label', 'Edit Drawing');
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

  // Opened again, it has both shapes.
  await drawing.click();
  await expect(editor(page)).toBeVisible();
  await expect(editor(page)).toHaveAttribute('data-shapes', '2');

  // The proof's last frame: the reopened drawing, both shapes on its canvas.
  await page.waitForTimeout(2_000);
  await editor(page).getByRole('button', { name: 'Cancel' }).click();
  await expect(editor(page)).toBeHidden();
  await drawing.scrollIntoViewIfNeeded();
  await page.waitForTimeout(2_000);
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
