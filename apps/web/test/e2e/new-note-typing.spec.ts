import { expect, test, type Page } from './fixtures';
import { NEW_NOTE } from './keys';
import { storedDocumentText } from './stored';

// A1179: keys typed at once after New Note all land in the note, on a slow machine too. ⌘⌥N
// pressed as the window showed made the note, but the note view came a task later, and the keys
// typed meanwhile went to the page: the title and body stayed empty, or kept the last letters.

const ULID = /\/notes\/([0-9A-HJKMNP-TV-Z]{26})$/;

const body = (page: Page) => page.getByTestId('note-body').locator('.ProseMirror');

test('keys typed straight after the new-note shortcut all land in the new note', async ({
  page,
}) => {
  // A machine a few times slower, from the start.
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 6 });
  try {
    await page.goto('/');
    await expect(page.getByTestId('app-root')).toBeVisible();
    // No wait between the shortcut and the keys, as a person types.
    await page.keyboard.press(NEW_NOTE);
    await page.keyboard.type('Typed at once');
    await page.keyboard.press('Enter');
    await page.keyboard.type('And its first line');
    await expect(page).toHaveURL(ULID);
    await expect(page.getByTestId('note-title')).toHaveValue('Typed at once');
    await expect(body(page)).toHaveText('And its first line');
  } finally {
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  }
});

test('Enter in the title before the body has opened waits for it, with what was typed after it', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.getByTestId('app-root')).toBeVisible();
  await page.keyboard.press(NEW_NOTE);
  await expect(page).toHaveURL(ULID);
  const id = ULID.exec(new URL(page.url()).pathname)![1]!;
  await expect(page.getByTestId('note-title')).toBeFocused();
  await page.keyboard.type('Kept title');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Old line');
  await expect(body(page)).toHaveText('Old line');
  await expect.poll(() => storedDocumentText(page, id)).toContain('Old line');

  // From now on this device's store answers reads late (a slow disk): the note opens after its
  // title field shows.
  await page.addInitScript(() => {
    const prototype = IDBObjectStore.prototype;
    const get = Object.getOwnPropertyDescriptor(prototype, 'get')!.value as (
      this: IDBObjectStore,
      query: IDBValidKey | IDBKeyRange,
    ) => IDBRequest;
    prototype.get = function (this: IDBObjectStore, query: IDBValidKey | IDBKeyRange) {
      const request = get.call(this, query);
      if (this.transaction.mode !== 'readonly') return request;
      Object.defineProperty(request, 'onsuccess', {
        configurable: true,
        set(listener: ((this: IDBRequest, event: Event) => void) | null) {
          request.addEventListener('success', (event) =>
            setTimeout(() => listener?.call(request, event), 1_500),
          );
        },
      });
      return request;
    };
  });
  await page.reload();
  const title = page.getByTestId('note-title');
  await expect(title).toBeVisible();
  await expect(page.getByTestId('note-view')).toHaveAttribute('data-ready', 'false');
  await title.click();
  await page.keyboard.press('Enter');
  await page.keyboard.type('New first words ');
  await expect(page.getByTestId('note-view')).toHaveAttribute('data-ready', 'true', {
    timeout: 10_000,
  });
  await expect(title).toHaveValue('Kept title');
  await expect(body(page)).toHaveText('New first words Old line');
  await expect(body(page)).toBeFocused();
});
