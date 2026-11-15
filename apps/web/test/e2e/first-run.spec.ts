import { expect, test } from './fixtures';
import { NEW_NOTE } from './keys';

// T59 (D48, D49): Penmoss has no account and no server. On a Mac with no git notebook the app
// opens on the first run, which asks for one (First Run C, Ryan's review of #192: one step per
// screen). A pasted address that holds no notebook makes one once it is named (a repository on
// this Mac syncs without a check, D51), and the app opens it; its first note reaches the remote.

test.use({ seed: null });

test('with no notebook, the app asks for one; making one opens it', async ({ page, host }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.goto('/');

  const firstRun = page.getByTestId('first-run');
  await expect(firstRun.getByRole('heading', { name: 'Welcome to Penmoss' })).toBeVisible();
  // No notebook to show yet: no notes tree, no sign-in.
  await expect(page.getByRole('tree', { name: 'Folders and notes' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /sign in/i })).toHaveCount(0);
  await firstRun.getByTestId('first-run-start').click();
  // Start a New Notebook, then Paste a URL: a repository on this Mac.
  await firstRun.getByTestId('first-run-continue').click();
  await firstRun.getByTestId('first-run-way-url').click();
  await firstRun.getByTestId('first-run-continue').click();
  const remote = host.bare('first');
  await firstRun.getByTestId('first-run-url-input').fill(remote);
  await firstRun.getByTestId('first-run-continue').click();

  // It holds no notebook yet: Name Your Notebook, Step 3 of 3.
  await expect(firstRun.getByRole('heading', { name: 'Name Your Notebook' })).toBeVisible();
  await expect(firstRun).toContainText('Step 3 of 3');
  await firstRun.getByTestId('first-run-name-input').fill('Field Notes');
  await firstRun.getByTestId('first-run-make').click();

  // The app shows the new notebook once its first sync is done.
  const sidebar = page.locator('#app-sidebar');
  await expect(sidebar.getByText('Field Notes', { exact: true }).first()).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByTestId('first-run')).toHaveCount(0);
  expect((await host.notebooks.list()).map((notebook) => notebook.name)).toEqual(['Field Notes']);

  // A note made in it is pushed to the remote.
  await page.keyboard.press(NEW_NOTE);
  await expect(page).toHaveURL(/\/notes\/[0-9A-HJKMNP-TV-Z]{26}$/);
  await page.keyboard.type('First of many');
  const bare = remote.replace('file://', '');
  await expect
    .poll(
      () => {
        try {
          return host.git(bare, ['ls-tree', '-r', '--name-only', 'main']);
        } catch {
          return '';
        }
      },
      { timeout: 40_000 },
    )
    .toContain('First of many.md');
  expect(errors).toEqual([]);
});
