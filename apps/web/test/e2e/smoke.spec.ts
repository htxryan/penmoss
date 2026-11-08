import { expect, test } from './fixtures';

test('loads the notes shell inside a new git notebook', async ({ page }) => {
  const consoleErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => consoleErrors.push(error.message));

  await page.goto('/');

  await expect(page).toHaveTitle('Penmoss');
  await expect(page.getByTestId('app-root')).toBeVisible();
  await expect(page.getByRole('heading', { level: 1, name: 'Penmoss' })).toBeVisible();
  await expect(
    page.getByTestId('sidebar-shortcuts').getByRole('button', { name: 'New Note', exact: true }),
  ).toBeVisible();
  await expect(page.getByTestId('empty-state')).toBeVisible();
  expect(consoleErrors).toEqual([]);
});
