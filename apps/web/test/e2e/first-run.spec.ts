import { expect, test } from './fixtures';
import { NEW_NOTE } from './keys';

// T59 (D48, D49): Penmoss has no account and no server. On a Mac with no git notebook the app
// opens on a first-run screen that asks for one: Notebooks' Add form, there and then, not
// behind Settings. Adding a remote that holds no notebook makes one once it is named (a
// repository on this Mac syncs without a check, D51) and the app opens it; its first note
// reaches the remote.

test.use({ seed: null });

test('with no notebook, the app asks for one; making one opens it', async ({ page, host }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  await page.goto('/');

  // The first-run screen: a welcome, and "Open a notebook you already have" leads to the add
  // form (T69, A1146).
  await expect(page.getByRole('heading', { name: 'Welcome to Penmoss' })).toBeVisible();
  await page.getByTestId('first-run-existing').click();
  const form = page.getByTestId('git-add');
  await expect(form).toBeVisible();
  await expect(page.getByRole('heading').first()).toBeVisible();
  await expect(form.getByTestId('git-add-remote')).toBeVisible();
  // No notebook to show yet: no notes tree, no sign-in.
  await expect(page.getByRole('tree', { name: 'Folders and notes' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /sign in/i })).toHaveCount(0);

  // An empty private repository on this Mac.
  const remote = host.bare('first');
  await form.getByTestId('git-add-remote').fill(remote);
  await form.getByRole('button', { name: 'Open Notebook', exact: true }).click();
  // Nobody is asked whether a repository on this Mac is private (D51): it holds no notebook yet,
  // so the form asks for a name, and Add again makes it.
  await expect(form.getByTestId('git-add-message')).toContainText('name the new one');
  await form.getByTestId('git-add-name').fill('Field Notes');
  await form.getByRole('button', { name: 'Make Notebook', exact: true }).click();

  // The app shows the new notebook.
  const sidebar = page.locator('#app-sidebar');
  await expect(sidebar.getByText('Field Notes', { exact: true }).first()).toBeVisible({
    timeout: 20_000,
  });
  await expect(page.getByTestId('git-add')).toHaveCount(0);
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
