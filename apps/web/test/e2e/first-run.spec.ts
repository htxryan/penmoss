// The first run: no notebook yet, the welcome, and a notebook made or opened from it.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, type GitHost, test } from './fixtures';
import { collectErrors } from './support/app';
import { NEW_NOTE } from './keys';
import { pushedUntil } from './support/sync';
import { GITHUB_WEB } from './support/git-host';

const SHOTS = process.env['PENMOSS_EVIDENCE'];
// T69 (D58, #228, A1146) as First Run C (Ryan's review of #192, findings 2–4): the first run with
// no git notebook is one step per screen. A short welcome, Create or Open Notebook, Pick
// Repository, then Name Your Notebook when a new one is made, each with the "Step n of 3" bar and
// Back. Branch and folder wait under More Options. A notebook made here starts with a welcome
// note, which opens; one that exists opens with no name asked.

test.use({ seed: null });

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
  // No notebook to show yet: no notes tree, no sign-in.
  await expect(page.getByRole('tree', { name: 'Folders and notes' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /sign in/i })).toHaveCount(0);
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
  const remote = host.bare('fresh');
  await firstRun.getByTestId('first-run-url-input').fill(remote);
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

  // A note made in it reaches the repository.
  await page.keyboard.press(NEW_NOTE);
  await expect(page).toHaveURL(/\/notes\/[0-9A-HJKMNP-TV-Z]{26}$/);
  await page.keyboard.type('First of many');
  const bare = remote.replace('file://', '');
  await pushedUntil(page, () =>
    expect(host.git(bare, ['ls-tree', '-r', '--name-only', 'main'])).toContain('First of many.md'),
  );
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

/** Commits `files` to a bare repository's main, as another person's git would. */
function pushFiles(host: GitHost, remote: string, files: Record<string, string>): void {
  const work = mkdtempSync(join(tmpdir(), 'penmoss-t81-'));
  host.git(work, ['clone', '--quiet', remote, 'w']);
  const tree = join(work, 'w');
  host.git(tree, ['checkout', '-q', '-B', 'main']);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(tree, path)), { recursive: true });
    writeFileSync(join(tree, path), text);
  }
  host.git(tree, ['add', '-A']);
  host.git(tree, ['commit', '-qm', 'files']);
  host.git(tree, ['push', '-q', 'origin', 'main']);
}

test.describe('the first run', () => {
  test.use({ seed: null });

  test('Use Existing Repo shows each repository with its notebooks beneath; Open opens one', async ({
    page,
    host,
  }) => {
    test.setTimeout(90_000);
    const errors = collectErrors(page);
    host.signInGit();
    const notes = host.githubRepo('notes', { pushedAt: '2026-11-06T10:00:00Z' });
    const kept = await host.seed({
      name: 'Kept',
      remote: notes.remote,
      notes: [{ title: 'Already here', markdown: 'From another Mac.\n' }],
    });
    await host.notebooks.remove(kept.info.localId);
    const site = host.githubRepo('site', {
      visibility: 'public',
      pushedAt: '2026-11-01T10:00:00Z',
    });
    pushFiles(host, site.remote, { 'index.html': '<p>hi</p>' });
    host.githubRepo('wiki', {
      owner: 'acme',
      visibility: 'internal',
      canPush: false,
      pushedAt: '2026-10-01T10:00:00Z',
    });

    await page.goto('/');
    const firstRun = page.getByTestId('first-run');
    await firstRun.getByTestId('first-run-start').click();
    await firstRun.getByTestId('first-run-existing').click();
    await firstRun.getByTestId('first-run-continue').click();
    // Git's own sign-in answers, so the tree comes at once (no stop to say so).
    await expect(firstRun.getByRole('heading', { name: 'Pick Repository' })).toBeVisible();
    const repos = firstRun.getByTestId('first-run-tree-repo');
    // Newest push first; any visibility can be picked (D61), read-only can't.
    await expect(repos).toHaveCount(3);
    await expect(repos.nth(0)).toHaveAttribute('data-repo', 'ryan/notes');
    await expect(repos.nth(1)).toContainText('Public');
    await expect(repos.nth(2)).toContainText('Internal');
    await expect(repos.nth(2)).toContainText('Read Only');
    await expect(repos.nth(2).getByTestId('first-run-repo-pick')).toBeDisabled();
    // The notebooks beneath their repository, which opens by itself once read; site holds none,
    // so it stays closed until opened.
    const notebook = repos.nth(0).getByTestId('first-run-notebook');
    await expect(notebook).toContainText('Kept');
    await expect(notebook).toContainText('Root');
    const siteToggle = repos.nth(1).getByTestId('first-run-repo-toggle');
    await expect(siteToggle).toHaveAttribute('aria-expanded', 'false');
    await siteToggle.click();
    await expect(repos.nth(1)).toContainText('No notebook yet');
    await expect(repos.nth(1).getByTestId('first-run-start-here')).toBeVisible();
    await siteToggle.click();
    await expect(siteToggle).toHaveAttribute('aria-expanded', 'false');
    // The count line is there before any filter, so typing one never moves the list.
    await expect(firstRun.getByTestId('first-run-filter-count')).toHaveText('3 repositories.');
    await expect(firstRun.getByTestId('first-run-via')).toContainText('Signed in');
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/tree.png` });

    // The filter narrows repositories and notebooks; Escape clears it.
    const filter = firstRun.getByTestId('first-run-filter');
    const treeBox = firstRun.getByTestId('first-run-tree');
    const before = { filter: await filter.boundingBox(), tree: await treeBox.boundingBox() };
    await filter.fill('kept');
    await expect(repos).toHaveCount(1);
    await expect(firstRun.getByTestId('first-run-filter-count')).toHaveText('1 of 3 match.');
    // Nothing moves as the filter narrows the list: not the field, not the list's edges.
    expect(await filter.boundingBox()).toEqual(before.filter);
    expect(await treeBox.boundingBox()).toEqual(before.tree);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/tree-filtered.png` });
    await filter.press('Escape');
    await expect(filter).toHaveValue('');
    await expect(repos).toHaveCount(3);

    await notebook.getByTestId('first-run-notebook-open').click();
    const tree = page.getByRole('tree', { name: 'Folders and notes' });
    await expect(tree.getByRole('treeitem', { name: 'Already here', exact: true })).toBeVisible({
      timeout: 30_000,
    });
    const [added] = await host.notebooks.list();
    expect(added).toMatchObject({ name: 'Kept', remote: notes.remote, dir: '' });
    // Listed with git's own sign-in: the notebook gets no token from Penmoss (T82, A1171).
    expect(host.addInputs.at(-1)).not.toHaveProperty('githubSignIn');
    expect(added?.hasToken).toBe(false);
    expect(errors).toEqual([]);
  });

  test('a repository with other files asks for a folder, then a name', async ({ page, host }) => {
    test.setTimeout(90_000);
    const errors = collectErrors(page);
    host.signInGit();
    const code = host.githubRepo('code', { pushedAt: '2026-11-06T10:00:00Z' });
    pushFiles(host, code.remote, {
      'src/app.ts': 'export {};\n',
      'docs/guide/intro.md': '# Intro\n',
      '.github/workflows/ci.yml': 'on: push\n',
    });
    await page.goto('/');
    const firstRun = page.getByTestId('first-run');
    await firstRun.getByTestId('first-run-start').click();
    await firstRun.getByTestId('first-run-continue').click();
    await firstRun.getByTestId('first-run-way-existing').click();
    await firstRun.getByTestId('first-run-continue').click();
    await firstRun.getByTestId('first-run-tree-repo').getByTestId('first-run-repo-pick').click();

    await expect(firstRun.getByRole('heading', { name: 'Pick Folder' })).toBeVisible();
    const folders = firstRun.getByTestId('first-run-folder-option');
    expect(
      await folders.evaluateAll((all) => all.map((each) => each.getAttribute('data-path'))),
    ).toEqual(['', 'docs', 'docs/guide', 'src']);
    // Root carries the repository's name.
    await expect(folders.first()).toContainText('ryan/code');
    await folders
      .filter({ hasText: /^docs\// })
      .first()
      .click();
    await firstRun.getByTestId('first-run-new-folder').fill('notes');
    await firstRun.getByTestId('first-run-new-folder-add').click();
    await expect(firstRun.locator('[data-path="docs/notes"] input')).toBeChecked();
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/pick-folder.png` });
    await firstRun.getByTestId('first-run-continue').click();
    await expect(firstRun.getByRole('heading', { name: 'Name Your Notebook' })).toBeVisible();
    await expect(firstRun.getByTestId('first-run-place')).toContainText('docs/notes/');
    await firstRun.getByTestId('first-run-name-input').fill('Code Notes');
    await firstRun.getByTestId('first-run-make').click();
    await expect(page.getByTestId('first-run')).toHaveCount(0, { timeout: 30_000 });
    const listed = await host.notebooks.list();
    expect(listed.find((each) => each.name === 'Code Notes')).toMatchObject({
      remote: code.remote,
      dir: 'docs/notes',
    });
    expect(errors).toEqual([]);
  });

  test('Create New Repo makes a private repository named after the notebook, and the notebook in it', async ({
    page,
    host,
  }) => {
    test.setTimeout(90_000);
    const errors = collectErrors(page);
    host.signInGit();
    host.githubRepos.orgs = ['acme'];
    const used = host.githubRepo('used', { pushedAt: '2026-11-06T10:00:00Z' });
    pushFiles(host, used.remote, { 'README.md': '# used' });

    await page.goto('/');
    const firstRun = page.getByTestId('first-run');
    await firstRun.getByTestId('first-run-start').click();
    await firstRun.getByTestId('first-run-continue').click();
    await firstRun.getByTestId('first-run-continue').click();
    await expect(firstRun.getByRole('heading', { name: 'Create New Repo' })).toBeVisible();
    // The owner is words; Change offers the organisations.
    await expect(firstRun.getByTestId('first-run-create-owner-label')).toHaveText('ryan /');
    await firstRun.getByTestId('first-run-create-change').click();
    await expect(firstRun.getByTestId('first-run-create-owner')).toContainText('ryan (you)');
    await expect(firstRun.getByTestId('first-run-create-owner')).toContainText('acme');
    // The repository's name follows the notebook's until it is edited (D62).
    await firstRun.getByTestId('first-run-create-notebook').fill('Work Log');
    await expect(firstRun.getByTestId('first-run-create-repo')).toHaveValue('work-log-notes');
    await firstRun.getByTestId('first-run-create-repo').fill('used');
    await firstRun.getByTestId('first-run-create-notebook').fill('Work Logs');
    await expect(firstRun.getByTestId('first-run-create-repo')).toHaveValue('used');
    // A name GitHub has: said in place, with another offered and Use Existing Repo.
    await firstRun.getByTestId('first-run-create-submit').click();
    await expect(firstRun.getByTestId('first-run-create-taken')).toContainText(
      'ryan/used already exists.',
    );
    await expect(firstRun.getByTestId('first-run-use-existing')).toBeVisible();
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/create-taken.png` });
    await firstRun.getByTestId('first-run-create-repo').fill('work-log-notes');
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/create.png` });
    await firstRun.getByTestId('first-run-create-submit').click();

    await expect(page.getByTestId('note-title')).toHaveValue('Welcome to Penmoss', {
      timeout: 30_000,
    });
    const made = host.githubRepos.requests.filter((each) => each.method === 'POST').at(-1);
    expect(made).toMatchObject({
      path: '/user/repos',
      body: { name: 'work-log-notes', private: true },
    });
    expect((await host.notebooks.list()).map((each) => each.name)).toEqual(['Work Logs']);
    expect(errors).toEqual([]);
  });
});

test.describe('the first run', () => {
  test.use({ seed: null });

  test('signs in with GitHub on its own screens: the code, then Signed In, then the repositories', async ({
    page,
    host,
  }) => {
    test.setTimeout(60_000);
    const errors = collectErrors(page);
    host.offerSignIn = true;
    host.githubRepo('notes', { pushedAt: '2026-11-06T10:00:00Z' });
    await page.goto('/');
    const firstRun = page.getByTestId('first-run');
    await firstRun.getByTestId('first-run-start').click();
    await firstRun.getByTestId('first-run-existing').click();
    await firstRun.getByTestId('first-run-continue').click();
    // 2.3: git has no GitHub sign-in.
    await expect(firstRun.getByRole('heading', { name: 'Sign In to GitHub' })).toBeVisible();
    await expect(firstRun.getByTestId('first-run-url-instead')).toBeVisible();
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/first-run-sign-in.png` });
    await firstRun.getByTestId('first-run-signin').click();
    // 2.4: the code, large, with Copy Code.
    await expect(
      firstRun.getByRole('heading', { name: 'Enter This Code on GitHub' }),
    ).toBeVisible();
    await expect(firstRun.getByTestId('github-signin-code')).toHaveText('WDJB-MJHT');
    expect(host.opened).toEqual([`${GITHUB_WEB}/login/device`]);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/first-run-code.png` });
    host.githubRepos.approve();
    // 2.5: Signed In, then Continue lists the repositories with it.
    await expect(firstRun.getByTestId('first-run-signed-in')).toContainText('Signed in as ryan');
    await firstRun.getByTestId('first-run-continue').click();
    await expect(firstRun.getByTestId('first-run-tree-repo')).toHaveCount(1);
    await expect(firstRun.getByTestId('first-run-via')).toContainText('Signed in as ryan');
    expect(errors).toEqual([]);
  });
});
