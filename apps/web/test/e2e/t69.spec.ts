import { expect, test, type Page } from './fixtures';

// T69 (D58, #228, A1146): the first run with no git notebook is a short guide. A welcome says
// what Penmoss keeps and where, with two ways on: start a new notebook (an empty private
// repository, named at once) or open one that exists (named only if it holds none). Back
// returns; branch and folder wait under More Options; how git is reached is a click away. A
// notebook made here starts with a welcome note, which opens.

test.use({ seed: null });

const SHOTS = process.env['PENMOSS_EVIDENCE'];

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(error.message));
  return errors;
}

test('the welcome, then a new notebook made in an empty repository, with its welcome note', async ({
  page,
  host,
}) => {
  test.setTimeout(90_000);
  const errors = collectErrors(page);
  await page.goto('/');
  const firstRun = page.getByTestId('first-run');
  await expect(firstRun.getByRole('heading', { name: 'Welcome to Penmoss' })).toBeFocused();
  await expect(firstRun).toContainText('a private repository you own');
  await expect(page.getByTestId('git-add')).toHaveCount(0);
  // How git is reached, a click away.
  const access = page.getByTestId('first-run-access');
  await access.getByText('How Penmoss signs in to git').click();
  await expect(access).toContainText('SSH key');
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/welcome.png` });

  // Start a new notebook: the steps, GitHub's new-repository page, Back and in again.
  await page.getByTestId('first-run-new').click();
  await expect(page.getByTestId('first-run-back')).toBeFocused();
  await expect(page.getByRole('heading', { name: 'Start a new notebook' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'create one on GitHub' })).toHaveAttribute(
    'href',
    'https://github.com/new',
  );
  await page.getByTestId('first-run-back').click();
  await expect(page.getByRole('heading', { name: 'Welcome to Penmoss' })).toBeVisible();
  await page.getByTestId('first-run-new').click();

  const form = page.getByTestId('git-add');
  const make = form.getByRole('button', { name: 'Make Notebook', exact: true });
  // The name is asked at once, before the address; Make waits for both.
  await expect(form.getByTestId('git-add-name')).toBeVisible();
  await expect(form.getByTestId('git-add-branch')).toBeHidden();
  await form.getByTestId('git-add-remote').fill(host.bare('fresh'));
  await expect(make).toBeDisabled();
  await form.getByTestId('git-add-name').fill('Field Notes');
  // Branch and folder under More Options, filled in already.
  await form.getByTestId('git-add-more').getByText('More Options').click();
  await expect(form.getByTestId('git-add-branch')).toHaveValue('main');
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/new-notebook.png` });
  await make.click();

  // The app opens on the new notebook's welcome note.
  await expect(page.getByTestId('first-run')).toHaveCount(0, { timeout: 20_000 });
  await expect(page.getByTestId('note-title')).toHaveValue('Welcome to Penmoss', {
    timeout: 20_000,
  });
  await expect(page.getByTestId('note-view').locator('.ProseMirror')).toContainText(
    'Your notes live in this notebook',
  );
  await expect(
    page
      .getByRole('tree', { name: 'Folders and notes' })
      .getByRole('treeitem', { name: 'Welcome to Penmoss', exact: true }),
  ).toBeVisible();
  // Its tag examples are code, not tags.
  await expect(page.getByTestId('note-view').locator('code', { hasText: '#ideas' })).toBeVisible();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/welcome-note.png` });
  expect((await host.notebooks.list()).map((notebook) => notebook.name)).toEqual(['Field Notes']);
  expect(errors).toEqual([]);
});

test('opening a notebook that exists asks for no name, and adds no welcome note', async ({
  page,
  host,
}) => {
  test.setTimeout(90_000);
  const errors = collectErrors(page);
  // A notebook another Mac made and pushed, not yet on this one.
  const remote = host.bare('kept');
  const other = await host.seed({
    name: 'Kept',
    remote,
    notes: [{ title: 'Already here', markdown: 'From another Mac.\n' }],
  });
  await host.notebooks.remove(other.info.localId);
  await page.goto('/');
  await page.getByTestId('first-run-existing').click();
  await expect(
    page.getByRole('heading', { name: 'Open a notebook you already have' }),
  ).toBeVisible();
  const form = page.getByTestId('git-add');
  await expect(form.getByTestId('git-add-name')).toHaveCount(0);
  await form.getByTestId('git-add-remote').fill(remote);
  await form.getByRole('button', { name: 'Open Notebook', exact: true }).click();
  const tree = page.getByRole('tree', { name: 'Folders and notes' });
  await expect(tree.getByRole('treeitem', { name: 'Already here', exact: true })).toBeVisible({
    timeout: 30_000,
  });
  await expect(tree.getByRole('treeitem', { name: 'Welcome to Penmoss', exact: true })).toHaveCount(
    0,
  );
  expect(errors).toEqual([]);
});
