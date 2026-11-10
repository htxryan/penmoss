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

// PEN-66 (A-NEW-1) in the Mac app: a picture keeps its own line (A506) and leaves no empty line
// under it. A paragraph of text ending in a pasted 200×100 picture, a picture alone in its
// paragraph, and a bulleted item ending in one: each block ends at its picture's bottom edge, and
// the next block starts the normal gap below it, as below a line of text, ±1 px. End then Enter
// after a picture starts the next paragraph that gap below it. The web suite
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
  await page.keyboard.press('End');
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

  // The proof: the three pictures on screen, held.
  await body(page).evaluate((dom) => (dom as HTMLElement).blur());
  await body(page).locator('.pm-image').first().scrollIntoViewIfNeeded();
  await page.waitForTimeout(2000);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/mac-picture-gap.png` });
  await expect(body(page).locator('.pm-image').first()).toBeInViewport();
});
