import { expect, test, type Page } from '@playwright/test';
import {
  body,
  gitNotebook,
  launch,
  mainBounds,
  removeDataDirs,
  ULID,
  type Launched,
} from './support';

// PEN-66 (A1283) in the Mac app: a picture keeps its own line (A506) and leaves no empty line
// under it. A paragraph of text ending in a pasted 200×100 picture, a picture alone in its
// paragraph, and a bulleted item ending in one: each block ends at its picture's bottom edge, and
// the next block starts the normal gap below it, as below a line of text, ±1 px. End, or a click
// right of a picture, draws the caret on the picture's line; Enter then starts the next paragraph
// that gap below it. The web suite
// (apps/web/test/e2e/picture-gap.spec.ts) covers every case of the plan.

const mac = process.platform === 'darwin';
const NEW_NOTE = mac ? 'Meta+Alt+KeyN' : 'Alt+KeyN';
const SHOTS = process.env['PENMOSS_EVIDENCE'];
const opened: Launched[] = [];
/** ±1 px, with room for sub-pixel rounding. */
const PX = 1.05;

test.afterEach(async () => {
  for (const { app } of opened.splice(0)) await app.close().catch(() => undefined);
});
test.afterAll(() => removeDataDirs());

/** Pastes a 200×100 PNG where the caret is, as a screenshot arrives. */
async function pastePicture(page: Page): Promise<void> {
  const before = await body(page).locator('.pm-image').count();
  await page.evaluate(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 200;
    canvas.height = 100;
    const context = canvas.getContext('2d')!;
    context.fillStyle = '#3f7d4e';
    context.fillRect(0, 0, 200, 100);
    const blob = await new Promise<Blob>((resolve) =>
      canvas.toBlob((made) => resolve(made!), 'image/png'),
    );
    const transfer = new DataTransfer();
    transfer.items.add(new File([blob], 'Shot.png', { type: 'image/png' }));
    const editor = document.querySelector<HTMLElement>('[data-testid="note-body"] .ProseMirror')!;
    editor.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }),
    );
  });
  const pictures = body(page).locator('.pm-image');
  await expect(pictures).toHaveCount(before + 1);
  await expect(pictures.nth(before)).toHaveAttribute('data-state', 'ready');
  await expect
    .poll(() =>
      pictures
        .nth(before)
        .locator('img')
        .evaluate((img: HTMLImageElement) => img.naturalWidth),
    )
    .toBe(200);
}

/**
 * Where the caret is drawn, from the screen itself: the editor's caret turned pure red for a moment,
 * the pixels of that colour over a few screenshots (it blinks). A collapsed selection between two
 * elements, as after a picture that ends its block, has no rectangle of its own in Chromium
 * (getClientRects() is empty there), so only the drawn caret shows where it is.
 */
async function drawnCaret(page: Page): Promise<Box> {
  const editor = body(page);
  await editor.evaluate((dom) =>
    (dom as HTMLElement).style.setProperty('caret-color', '#ff0000', 'important'),
  );
  try {
    for (let attempt = 0; attempt < 8; attempt++) {
      const shot = (await page.screenshot({ caret: 'initial' })).toString('base64');
      const found = await page.evaluate(async (png) => {
        const image = new Image();
        image.src = `data:image/png;base64,${png}`;
        await image.decode();
        const canvas = document.createElement('canvas');
        canvas.width = image.width;
        canvas.height = image.height;
        const context = canvas.getContext('2d')!;
        context.drawImage(image, 0, 0);
        const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
        const scale = image.width / innerWidth;
        let top = Infinity;
        let bottom = -Infinity;
        let left = Infinity;
        for (let i = 0; i < data.length; i += 4) {
          if (data[i]! < 240 || data[i + 1]! > 20 || data[i + 2]! > 20) continue;
          const x = (i / 4) % canvas.width;
          const y = Math.floor(i / 4 / canvas.width);
          top = Math.min(top, y);
          bottom = Math.max(bottom, y + 1);
          left = Math.min(left, x);
        }
        if (top === Infinity) return null;
        return { top: top / scale, bottom: bottom / scale, left: left / scale };
      }, shot);
      if (found) return found;
      await page.waitForTimeout(150);
    }
    throw new Error('No caret drawn');
  } finally {
    await editor.evaluate((dom) => (dom as HTMLElement).style.removeProperty('caret-color'));
  }
}

interface Box {
  readonly top: number;
  readonly bottom: number;
  readonly left: number;
}

/**
 * AC5: the caret after the nth picture is drawn on the picture's line, at its right edge, down to
 * its bottom (Chromium draws it as tall as the picture beside it, A1283).
 */
async function expectCaretAfter(page: Page, nth: number): Promise<void> {
  const picture = await body(page)
    .locator('.pm-image img')
    .nth(nth)
    .evaluate((img) => {
      const { top, bottom, right } = img.getBoundingClientRect();
      return { top, bottom, right };
    });
  const caret = await drawnCaret(page);
  expect(Math.abs(caret.bottom - picture.bottom), 'at the picture’s bottom').toBeLessThanOrEqual(2);
  expect(caret.top, 'on the picture’s line').toBeGreaterThanOrEqual(picture.top - 2);
  expect(caret.left, 'right of the picture').toBeGreaterThanOrEqual(picture.right);
  expect(caret.left, 'beside the picture').toBeLessThanOrEqual(picture.right + 4);
}

interface Measured {
  /** From a paragraph of text to the next block, and from a list item's text to the next item. */
  readonly blockGap: number;
  readonly listGap: number;
  readonly pictures: readonly {
    readonly text: string;
    readonly inList: boolean;
    /** From the block's top to the picture's, from the picture's bottom to the block's. */
    readonly above: number;
    readonly under: number;
    /** From the picture's bottom to the next block or item. */
    readonly gap: number;
  }[];
}

/** Measured with the editor focused, two frames on (content-visibility, T31). */
async function measure(page: Page): Promise<Measured> {
  return body(page).evaluate(async (dom) => {
    if (!dom.contains(document.activeElement)) (dom as HTMLElement).focus();
    for (let i = 0; i < 2; i++) await new Promise(requestAnimationFrame);
    const rect = (element: Element) => element.getBoundingClientRect();
    const after = (element: Element): Element => {
      for (let at: Element | null = element; at && at !== dom; at = at.parentElement) {
        if (at.nextElementSibling) return at.nextElementSibling;
      }
      throw new Error('Nothing after the block');
    };
    const textOnly = [...dom.querySelectorAll(':scope > p')].find(
      (p) => p.textContent === 'After the lone picture',
    )!;
    const items = dom.querySelectorAll('li');
    return {
      blockGap: rect(after(textOnly)).top - rect(textOnly).bottom,
      listGap: rect(items[1]!).top - rect(items[0]!.querySelector('p')!).bottom,
      pictures: [...dom.querySelectorAll('.pm-image')].map((picture) => {
        const img = rect(picture.querySelector('img')!);
        const block = picture.closest('p')!;
        const outer = picture.closest('li') ?? block;
        return {
          text: [...block.childNodes]
            .filter((node) => node.nodeType === Node.TEXT_NODE)
            .map((node) => node.textContent)
            .join(''),
          inList: outer !== block,
          above: img.top - rect(block).top,
          under: rect(block).bottom - img.bottom,
          gap: rect(after(outer)).top - img.bottom,
        };
      }),
    };
  });
}

test('a picture that ends a paragraph, stands alone or ends a list item leaves no empty line under it', async () => {
  const launched = await launch();
  opened.push(launched);
  const { app, page } = launched;
  await mainBounds(app, { x: 0, y: 0, width: 1280, height: 720 });
  await gitNotebook(launched);
  await expect(page.locator('button[data-command="note.new"]')).toBeVisible();
  await page.keyboard.press(NEW_NOTE);
  await expect(page).toHaveURL(ULID);
  await page.keyboard.type('Picture gaps');
  await page.keyboard.press('Enter');

  // Text, then a picture in the same paragraph; End, Enter, and the next paragraph.
  await page.keyboard.type('Text above the picture');
  await pastePicture(page);
  // AC5: End puts the caret after the picture, drawn on the picture's line.
  await page.keyboard.press('End');
  await expectCaretAfter(page, 0);
  await page.keyboard.press('Enter');
  await page.keyboard.type('Next');
  await page.keyboard.press('Enter');
  // A picture alone in its paragraph.
  await pastePicture(page);
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('After the lone picture');
  await page.keyboard.press('Enter');
  // A bulleted item ending in a picture.
  await page.keyboard.type('- Item with a picture');
  await pastePicture(page);
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Item two');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await page.keyboard.type('After the list');

  // Each block's text, a picture as [picture], and a list's items after bullets.
  const lines = await body(page)
    .locator(':scope > *')
    .evaluateAll((blocks) => {
      const line = (block: Element) =>
        [...block.childNodes]
          .map((node) =>
            (node as Element).matches?.('.pm-image') ? '[picture]' : (node.textContent ?? ''),
          )
          .join('');
      return blocks.map((block) =>
        block.tagName === 'UL'
          ? [...block.querySelectorAll('li > p')].map((p) => `• ${line(p)}`).join(' | ')
          : line(block),
      );
    });
  // (An empty paragraph left at the end, if any, is not a block of the test's.)
  expect(lines.filter((text) => text !== '')).toEqual([
    'Text above the picture[picture]',
    'Next',
    '[picture]',
    'After the lone picture',
    '• Item with a picture[picture] | • Item two',
    'After the list',
  ]);

  const measured = await measure(page);
  expect(measured.pictures).toHaveLength(3);
  for (const picture of measured.pictures) {
    expect(Math.abs(picture.under), `no empty line under <${picture.text}>`).toBeLessThanOrEqual(
      PX,
    );
    const gap = picture.inList ? measured.listGap : measured.blockGap;
    expect(Math.abs(picture.gap - gap), `the gap below <${picture.text}>`).toBeLessThanOrEqual(PX);
  }
  // The text on its own line above; the lone picture's paragraph as tall as the picture.
  expect(measured.pictures[0]!.above).toBeGreaterThan(20);
  expect(Math.abs(measured.pictures[1]!.above)).toBeLessThanOrEqual(PX);
  // The list item's picture as far below its line of text as the paragraph's: a line, 0.4 em.
  expect(
    Math.abs(measured.pictures[2]!.above - measured.pictures[0]!.above),
    'the gap above the list item’s picture',
  ).toBeLessThanOrEqual(PX);

  // The proof: the pictures on screen, held, and a click right of the lone picture, which puts the
  // caret on its line (AC5).
  const lone = body(page).locator('.pm-image img').nth(1);
  await lone.scrollIntoViewIfNeeded();
  const box = (await lone.boundingBox())!;
  const column = (await body(page).boundingBox())!;
  await page.mouse.click(
    (box.x + box.width + column.x + column.width) / 2,
    box.y + box.height - 10,
  );
  await expect(body(page).locator('.pm-image.ProseMirror-selectednode')).toHaveCount(0);
  await expectCaretAfter(page, 1);
  await page.waitForTimeout(2000);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/mac-picture-gap.png` });
  await expect(lone).toBeInViewport();
  await expectCaretAfter(page, 1);
});
