import { expect, test, type Page } from './fixtures';
import { LINE_END } from './keys';

// T51 item 20 (A948): every picture in a note opens in a lightbox, from Open in Lightbox in its
// tools or a double click: fitted to the window, zoomed by the buttons, the keys and the wheel,
// panned by a drag, stepped through with the arrow keys, closed by Escape, Close or the backdrop.

const ULID = /\/notes\/([0-9A-HJKMNP-TV-Z]{26})$/;
const TAG = `lb${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(error.message));
  return errors;
}

const body = (page: Page) => page.getByTestId('note-body').locator('.ProseMirror');
const lightbox = (page: Page) => page.getByTestId('lightbox');

async function createNote(page: Page, title: string): Promise<string> {
  // The sidebar's on a wide window, the phone's own on a phone.
  await page
    .getByRole('button', { name: /^New Note/ })
    .locator('visible=true')
    .first()
    .click();
  await expect(page).toHaveURL(ULID);
  await expect(page.getByTestId('note-title')).toBeFocused();
  await page.keyboard.type(title);
  await page.keyboard.press('Enter');
  return ULID.exec(new URL(page.url()).pathname)![1]!;
}

/** Pastes a drawn PNG at the caret, as a screenshot paste delivers it. */
async function pastePicture(page: Page, label: string, colour: string): Promise<void> {
  await page.evaluate(
    async ([text, fill]) => {
      const canvas = document.createElement('canvas');
      canvas.width = 640;
      canvas.height = 360;
      const ctx = canvas.getContext('2d')!;
      ctx.fillStyle = fill!;
      ctx.fillRect(0, 0, 640, 360);
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 40px sans-serif';
      ctx.fillText(text!, 40, 190);
      const blob = await new Promise<Blob>((resolve) =>
        canvas.toBlob((b) => resolve(b!), 'image/png'),
      );
      const transfer = new DataTransfer();
      transfer.items.add(new File([blob], `${text}.png`, { type: 'image/png' }));
      const editor = document.querySelector<HTMLElement>('[data-testid="note-body"] .ProseMirror')!;
      editor.focus();
      editor.dispatchEvent(
        new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }),
      );
    },
    [label, colour],
  );
}

/** A note with two pictures, the first with alt text. */
async function noteWithPictures(page: Page): Promise<void> {
  await page.goto('/');
  await createNote(page, `Lightbox ${TAG}`);
  await page.keyboard.type('First: ');
  await pastePicture(page, 'One', '#3f7d4e');
  const images = body(page).getByTestId('image');
  await expect(images).toHaveCount(1);
  await page.keyboard.press(LINE_END);
  await page.keyboard.press('Enter');
  await page.keyboard.type('Second: ');
  await pastePicture(page, 'Two', '#2f6fb0');
  await expect(images).toHaveCount(2);
  for (const image of await images.all()) {
    await expect(image).toHaveAttribute('data-state', 'ready');
  }
  // Alt text for the first, from its tools.
  await images.first().locator('img').click();
  const alt = images.first().locator('.pm-image-alt');
  await alt.fill('A green card');
  await alt.press('Enter');
}

test('opens from Open in Lightbox, zooms, pans, steps and closes back to the note', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await page.setViewportSize({ width: 1280, height: 860 });
  await noteWithPictures(page);
  const first = body(page).getByTestId('image').first();
  await first.locator('img').click();
  await first.getByTestId('image-lightbox').click();

  const box = lightbox(page);
  await expect(box).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'A green card' })).toBeVisible();
  await expect(box.locator('.pm-lightbox-count')).toHaveText('1 of 2');
  // Fitted to the window: never wider or taller than it.
  const picture = box.locator('img');
  const fitted = (await picture.boundingBox())!;
  expect(fitted.width).toBeLessThanOrEqual(1280);
  expect(fitted.height).toBeLessThanOrEqual(860);
  await expect(box.getByTestId('lightbox-zoom')).toHaveText('100%');

  // The buttons and keys zoom; Reset fits it again.
  await box.getByRole('button', { name: 'Zoom In' }).click();
  await expect(box.getByTestId('lightbox-zoom')).toHaveText('150%');
  await page.keyboard.press('+');
  await expect(box.getByTestId('lightbox-zoom')).toHaveText('225%');
  // A drag pans the zoomed picture.
  const before = (await picture.boundingBox())!;
  await page.mouse.move(640, 430);
  await page.mouse.down();
  await page.mouse.move(540, 380, { steps: 5 });
  await page.mouse.up();
  const after = (await picture.boundingBox())!;
  expect(Math.round(after.x - before.x)).toBe(-100);
  await expect(box).toBeVisible();
  await box.getByRole('button', { name: 'Reset' }).click();
  await expect(box.getByTestId('lightbox-zoom')).toHaveText('100%');
  // The wheel zooms at the pointer.
  await page.mouse.move(640, 430);
  await page.mouse.wheel(0, -200);
  await expect(box.getByTestId('lightbox-zoom')).not.toHaveText('100%');
  await page.keyboard.press('0');

  // The arrow keys step through the note's pictures.
  await page.keyboard.press('ArrowRight');
  await expect(box.locator('.pm-lightbox-count')).toHaveText('2 of 2');
  await expect(page.getByRole('dialog', { name: 'Image' })).toBeVisible();
  await page.keyboard.press('ArrowRight');
  await expect(box.locator('.pm-lightbox-count')).toHaveText('1 of 2');

  // Tab stays inside it.
  for (let i = 0; i < 12; i++) await page.keyboard.press('Tab');
  expect(await box.evaluate((element) => element.contains(document.activeElement))).toBe(true);

  // Escape closes it; focus goes back to where it was.
  await page.keyboard.press('Escape');
  await expect(box).toHaveCount(0);
  await expect(first.getByTestId('image-lightbox')).toBeFocused();
  expect(errors).toEqual([]);
});

test('a double click opens it; Close and the backdrop close it; Full Screen where there is one', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await page.setViewportSize({ width: 1280, height: 860 });
  await noteWithPictures(page);
  const second = body(page).getByTestId('image').nth(1);
  await second.locator('img').dblclick();
  const box = lightbox(page);
  await expect(box).toBeVisible();
  await expect(box.locator('.pm-lightbox-count')).toHaveText('2 of 2');

  // A double click on the picture: twice the size, then fitted again.
  await box.locator('img').dblclick();
  await expect(box.getByTestId('lightbox-zoom')).toHaveText('200%');
  await box.locator('img').dblclick();
  await expect(box.getByTestId('lightbox-zoom')).toHaveText('100%');

  // Full Screen: Chromium has one.
  const full = box.getByRole('button', { name: 'Full Screen' });
  await expect(full).toBeVisible();
  await full.click();
  await expect.poll(() => page.evaluate(() => document.fullscreenElement !== null)).toBe(true);
  await expect(box.getByRole('button', { name: 'Exit Full Screen' })).toBeVisible();
  await box.getByRole('button', { name: 'Exit Full Screen' }).click();
  await expect.poll(() => page.evaluate(() => document.fullscreenElement === null)).toBe(true);

  await box.getByRole('button', { name: 'Close' }).click();
  await expect(box).toHaveCount(0);

  // The backdrop, beside the picture, closes it; the picture itself does not.
  await second.locator('img').dblclick();
  await expect(box).toBeVisible();
  await box.locator('img').click();
  await expect(box).toBeVisible();
  await page.mouse.click(20, 200);
  await expect(box).toHaveCount(0);
  expect(errors).toEqual([]);
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test('a double tap opens it', async ({ page }) => {
    const errors = collectErrors(page);
    await noteWithPictures(page);
    const first = body(page).getByTestId('image').first().locator('img');
    // Two taps at one point, as a finger makes them: a locator's tap waits for the picture to
    // settle each time, which on a busy machine can outlast a double tap's 320 ms.
    await first.scrollIntoViewIfNeeded();
    const box = (await first.boundingBox())!;
    const [x, y] = [box.x + box.width / 2, box.y + box.height / 2];
    await page.touchscreen.tap(x, y);
    await page.touchscreen.tap(x, y);
    await expect(lightbox(page)).toBeVisible();
    await expect(lightbox(page).locator('.pm-lightbox-count')).toHaveText('1 of 2');
    await lightbox(page).getByRole('button', { name: 'Close' }).tap();
    await expect(lightbox(page)).toHaveCount(0);
    expect(errors).toEqual([]);
  });
});
