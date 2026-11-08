import { createHash } from 'node:crypto';
import { anotherMac, expect, seeded, test, type Page } from './fixtures';
import { remoteBytes } from './support/sync';
import { remoteFiles, remoteMarkdown } from './support/remote';

// T10 on a git notebook (T59, A828): a screenshot pasted offline shows at once, is stored on
// the device, is committed into the repository (`attachments/<sha256>.png`) when the network
// returns, and another Mac takes it from there. The server's R2 uploads, their token check and
// their Retry went with the server: a git notebook's pictures travel in its pushes.

const ULID = /\/notes\/([0-9A-HJKMNP-TV-Z]{26})$/;
const TAG = `i${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (message) => {
    // Refused sockets and fetches are expected while offline.
    if (
      message.type() === 'error' &&
      !/ERR_INTERNET_DISCONNECTED|WebSocket|Failed to fetch|net::/.test(message.text())
    ) {
      errors.push(message.text());
    }
  });
  page.on('pageerror', (error) => errors.push(error.message));
  return errors;
}

const body = (page: Page) => page.getByTestId('note-body').locator('.ProseMirror');
const dot = (page: Page) => page.getByTestId('section-sync');

async function createNote(page: Page, title: string): Promise<string> {
  await page
    .getByTestId('sidebar-shortcuts')
    .getByRole('button', { name: 'New Note', exact: true })
    .click();
  await expect(page).toHaveURL(ULID);
  await expect(page.getByTestId('note-title')).toBeFocused();
  await page.keyboard.type(title);
  await page.keyboard.press('Enter');
  await page.keyboard.type('Before the screenshot: ');
  return ULID.exec(new URL(page.url()).pathname)![1]!;
}

/**
 * Draws a picture, puts it on a paste event as a PNG file (what a screenshot
 * paste delivers) and dispatches it at the editor. Returns the PNG's SHA-256
 * and bytes.
 */
async function pasteScreenshot(page: Page): Promise<{ sha256: string; bytes: number[] }> {
  return page.evaluate(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 480;
    canvas.height = 270;
    const ctx = canvas.getContext('2d')!;
    const gradient = ctx.createLinearGradient(0, 0, 480, 270);
    gradient.addColorStop(0, '#3f7d4e');
    gradient.addColorStop(1, '#e8d58a');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, 480, 270);
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 36px sans-serif';
    ctx.fillText('Pasted offline', 110, 145);
    const blob = await new Promise<Blob>((resolve) =>
      canvas.toBlob((b) => resolve(b!), 'image/png'),
    );
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const transfer = new DataTransfer();
    transfer.items.add(new File([bytes], 'Screenshot.png', { type: 'image/png' }));
    const editor = document.querySelector<HTMLElement>('[data-testid="note-body"] .ProseMirror')!;
    editor.focus();
    editor.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }),
    );
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    return {
      sha256: [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join(''),
      bytes: [...bytes],
    };
  });
}

test('pastes an image offline, commits it into the repository when back online, and another Mac shows it', async ({
  page,
  context,
  browser,
  host,
  notebook,
}) => {
  test.setTimeout(120_000);
  const errors = collectErrors(page);
  const { remote } = seeded(notebook);
  await page.goto('/');
  const title = `Screenshot note ${TAG}`;
  const id = await createNote(page, title);
  await expect(dot(page)).toHaveAttribute('data-state', 'synced', { timeout: 40_000 });

  host.network = 'down';
  await context.setOffline(true);
  const { sha256, bytes } = await pasteScreenshot(page);

  // Shown at once from the local copy; the note waits to be pushed.
  const image = body(page).locator('.pm-image img');
  await expect(image).toHaveAttribute('src', /^blob:/);
  await expect(body(page).locator('.pm-image')).toHaveAttribute('data-state', 'ready');
  await expect(dot(page)).toHaveAttribute('data-pending', '1');
  // A remote on this Mac needs no network, so the browser's offline event says nothing of it
  // (#174 review): the dot says Offline once the push after the delay cannot reach git.
  await expect(dot(page)).toHaveAttribute('data-state', 'offline', { timeout: 40_000 });

  // Online again: the push carries it, and the dot settles.
  host.network = 'up';
  await context.setOffline(false);
  await expect(dot(page)).toHaveAttribute('data-pending', '0', { timeout: 60_000 });
  await expect(dot(page)).toHaveAttribute('data-state', 'synced', { timeout: 40_000 });

  // The repository holds exactly the pasted bytes, named by their SHA-256.
  const path = `attachments/${sha256}.png`;
  await expect.poll(() => remoteFiles(host, remote), { timeout: 40_000 }).toContain(path);
  const served = remoteBytes(host, remote, path);
  expect(createHash('sha256').update(served).digest('hex')).toBe(sha256);
  expect(served.byteLength).toBe(bytes.length);

  // Resize through the width field; the note's markdown carries the width.
  await image.click();
  const width = body(page).locator('.pm-image-width');
  await expect(width).toBeVisible();
  await width.fill('240');
  await width.press('Enter');
  await expect(image).toHaveCSS('width', '240px');
  await expect
    .poll(() => remoteMarkdown(host, remote, id) ?? '', { timeout: 60_000, intervals: [1000] })
    .toContain(`![|240](attachments/${sha256}.png)`);

  // After a reload the image comes from IndexedDB, still at its width.
  await page.reload();
  await expect(body(page).locator('.pm-image')).toHaveAttribute('data-state', 'ready');
  await expect(body(page).locator('.pm-image img')).toHaveCSS('width', '240px');

  // Another Mac takes it from the repository.
  const other = await anotherMac(browser, { remote });
  const second = other.page;
  const secondErrors = collectErrors(second);
  await second.goto(`/notes/${id}`);
  await expect(second.getByTestId('note-title')).toHaveValue(title, { timeout: 40_000 });
  await expect(body(second).locator('.pm-image')).toHaveAttribute('data-state', 'ready', {
    timeout: 40_000,
  });
  await expect(body(second).locator('.pm-image img')).toHaveAttribute('src', /^blob:/);
  await other.context.close();

  expect(errors).toEqual([]);
  expect(secondErrors).toEqual([]);
});

test('refuses a file that is not an allowed image, with a message', async ({ page }) => {
  await page.goto('/');
  await createNote(page, `Refused paste ${TAG}`);
  await page.evaluate(() => {
    const transfer = new DataTransfer();
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"/>';
    transfer.items.add(new File([svg], 'icon.svg', { type: 'image/svg+xml' }));
    const editor = document.querySelector<HTMLElement>('[data-testid="note-body"] .ProseMirror')!;
    editor.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }),
    );
  });
  await expect(page.getByTestId('note-notice')).toContainText('PNG, JPEG, GIF, WebP and AVIF');
  await expect(body(page).locator('.pm-image')).toHaveCount(0);
});
