import { expect, test, type Page } from './fixtures';

// T69 (D58, #228, A1146) as First Run C (Ryan's review of #192, findings 2–4): the first run with
// no git notebook is one step per screen. A short welcome, Create or Open Notebook, Pick
// Repository, then Name Your Notebook when a new one is made, each with the "Step n of 3" bar and
// Back. Branch and folder wait under More Options. A notebook made here starts with a welcome
// note, which opens; one that exists opens with no name asked.

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
  // The welcome is a line, not a page (finding 2), with Learn More to the user docs.
  await expect(firstRun.getByRole('heading', { name: 'Welcome to Penmoss' })).toBeFocused();
  await expect(firstRun.getByTestId('first-run-welcome')).toContainText(
    'Notes in a git repository you own. Three short steps and you’re writing.',
  );
  await expect(firstRun.getByRole('link', { name: 'Learn More' })).toHaveAttribute(
    'href',
    'https://penmoss.app/docs/first-notebook/',
  );
  await expect(firstRun.getByTestId('first-run-back')).toHaveCount(0);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/welcome.png` });

  // Create or Open Notebook: Step 1 of 3, Start a New Notebook picked; Back and on again.
  await firstRun.getByTestId('first-run-start').click();
  await expect(firstRun.getByRole('heading', { name: 'Create or Open Notebook' })).toBeFocused();
  await expect(firstRun).toContainText('Step 1 of 3');
  await expect(firstRun.getByRole('radio', { name: /Start a New Notebook/ })).toBeChecked();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/create-or-open.png` });
  await firstRun.getByTestId('first-run-back').click();
  await expect(firstRun.getByRole('heading', { name: 'Welcome to Penmoss' })).toBeVisible();
  await firstRun.getByTestId('first-run-start').click();
  await firstRun.getByTestId('first-run-continue').click();

  // Pick Repository: Create New Repo (Recommended), Use Existing Repo, Paste a URL.
  await expect(firstRun.getByRole('heading', { name: 'Pick Repository' })).toBeVisible();
  await expect(firstRun).toContainText('Step 2 of 3');
  await expect(firstRun.getByTestId('first-run-way-create')).toContainText('Recommended');
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/pick-repository.png` });
  await firstRun.getByTestId('first-run-way-url').click();
  await firstRun.getByTestId('first-run-continue').click();

  // Paste a URL, branch and folder under More Options, filled in already.
  await expect(firstRun.getByRole('heading', { name: 'Paste a URL' })).toBeVisible();
  await expect(firstRun.getByTestId('first-run-branch')).toBeHidden();
  await firstRun.getByTestId('first-run-more').getByText('More Options').click();
  await expect(firstRun.getByTestId('first-run-branch')).toHaveValue('main');
  await firstRun.getByTestId('first-run-url-input').fill(host.bare('fresh'));
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/paste-url.png` });
  await firstRun.getByTestId('first-run-continue').click();

  // Name Your Notebook: offered from the repository's name, Make Notebook waits for one.
  await expect(firstRun.getByRole('heading', { name: 'Name Your Notebook' })).toBeVisible();
  const name = firstRun.getByTestId('first-run-name-input');
  await expect(name).toHaveValue('Fresh');
  await name.fill('');
  await expect(firstRun.getByTestId('first-run-make')).toBeDisabled();
  await name.fill('Field Notes');
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/name.png` });
  await firstRun.getByTestId('first-run-make').click();

  // The app opens on the new notebook's welcome note, once the first sync is done.
  await expect(page.getByTestId('first-run')).toHaveCount(0, { timeout: 30_000 });
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
  const firstRun = page.getByTestId('first-run');
  await firstRun.getByTestId('first-run-start').click();
  await firstRun.getByTestId('first-run-existing').click();
  await firstRun.getByTestId('first-run-continue').click();
  // No GitHub sign-in in git: Sign In to GitHub, or Paste a URL Instead.
  await expect(firstRun.getByRole('heading', { name: 'Sign In to GitHub' })).toBeVisible();
  await expect(firstRun.getByTestId('first-run-gh-hint')).toContainText('gh auth login');
  await firstRun.getByTestId('first-run-url-instead').click();
  await firstRun.getByTestId('first-run-url-input').fill(remote);
  await firstRun.getByTestId('first-run-continue').click();
  await expect(firstRun.getByTestId('first-run-name-input')).toHaveCount(0);
  const tree = page.getByRole('tree', { name: 'Folders and notes' });
  await expect(tree.getByRole('treeitem', { name: 'Already here', exact: true })).toBeVisible({
    timeout: 30_000,
  });
  await expect(tree.getByRole('treeitem', { name: 'Welcome to Penmoss', exact: true })).toHaveCount(
    0,
  );
  expect(errors).toEqual([]);
});
