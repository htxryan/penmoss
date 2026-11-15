import { expect, test, type Page } from './fixtures';

// A right-click in a note with nothing selected opens the slash menu's blocks at the click, with
// no `/` typed (Ryan's review of PR #192, finding 17): typing filters the menu, Enter inserts the
// block there. With text selected the page keeps its own menu.

const ULID = /\/notes\/([0-9A-HJKMNP-TV-Z]{26})$/;
const TAG = `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

const body = (page: Page) => page.getByTestId('note-body').locator('.ProseMirror');

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

test('a right-click with nothing selected opens the block menu there, no / typed', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await page.goto('/');
  await page
    .getByTestId('sidebar-shortcuts')
    .getByRole('button', { name: 'New Note', exact: true })
    .click();
  await expect(page).toHaveURL(ULID);
  await expect(page.getByTestId('note-title')).toBeFocused();
  await page.keyboard.type(`Right-click ${TAG}`);
  await page.keyboard.press('Enter');
  await expect(body(page)).toBeFocused();
  await page.keyboard.type('Beds');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Paths');

  // On the empty line between them: the menu opens there, the caret with it.
  const empty = body(page).locator(':scope > p').nth(1);
  await empty.click({ button: 'right' });
  const menu = page.getByTestId('slash-menu');
  await expect(menu).toBeVisible();
  await expect(page.getByTestId('slash-filter')).toHaveText('/');
  await page.keyboard.type('check');
  await expect(page.getByTestId('slash-filter')).toHaveText('/check');
  await expect(menu.getByRole('option', { selected: true })).toContainText('Checklist');
  await expect(body(page)).not.toContainText('/');
  await page.keyboard.press('Enter');
  await expect(menu).toBeHidden();
  await page.keyboard.type('Water');
  const items = body(page).locator('li[data-checked]');
  await expect(items).toHaveCount(1);
  await expect(items).toContainText('Water');
  await expect(body(page).locator(':scope > p')).toHaveText(['Beds', 'Paths']);

  // Escape closes it and leaves the note as it was.
  await body(page).locator(':scope > p').first().click({ button: 'right' });
  await expect(menu).toBeVisible();
  await page.keyboard.type('he');
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await expect(body(page).locator(':scope > p')).toHaveText(['Beds', 'Paths']);

  // With text selected, the page keeps its own menu.
  await body(page).locator(':scope > p').first().dblclick();
  await body(page).locator(':scope > p').first().click({ button: 'right' });
  await expect(menu).toBeHidden();
  expect(errors).toEqual([]);
});
