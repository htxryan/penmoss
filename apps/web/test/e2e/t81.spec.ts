import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, test, type GitHost, type Page } from './fixtures';

// T81 (#229, D60–D62, A1163–A1168): Add a Git Notebook lists the GitHub repositories git's
// credential reaches, then the chosen one's folders. Each repository here is a bare repository
// on the stand-in Mac, so Add clones exactly what the folder step showed.

const SHOTS = process.env['PENMOSS_EVIDENCE'];

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(error.message));
  return errors;
}

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

const notebookJson = (id: string, name: string) => JSON.stringify({ format: 1, id, name });

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
    // The notebooks beneath their repository, read at once; site holds none.
    const notebook = repos.nth(0).getByTestId('first-run-notebook');
    await expect(notebook).toContainText('Kept');
    await expect(notebook).toContainText('Root');
    await expect(repos.nth(1)).toContainText('No notebook yet');
    await expect(firstRun.getByTestId('first-run-via')).toContainText('Signed in');
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/tree.png` });

    // The filter narrows repositories and notebooks; Escape clears it.
    const filter = firstRun.getByTestId('first-run-filter');
    await filter.fill('kept');
    await expect(repos).toHaveCount(1);
    await expect(firstRun.getByTestId('first-run-filter-count')).toHaveText('1 of 3 match.');
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

test.describe('Settings', () => {
  test('a new folder in a code repository; dot-folders and a notebook’s folders are not listed', async ({
    page,
    host,
  }) => {
    test.setTimeout(90_000);
    const errors = collectErrors(page);
    host.signInGit();
    const code = host.githubRepo('code', { pushedAt: '2026-11-06T10:00:00Z' });
    pushFiles(host, code.remote, {
      'src/app.ts': 'export {};\n',
      'docs/guide/intro.md': '# Intro\n',
      '.github/workflows/ci.yml': 'on: push\n',
      'wiki/.penmoss/notebook.json': notebookJson('01JBNOTEBOOK00000000000042', 'Team wiki'),
      'wiki/Inbox/Call.md': 'call\n',
    });

    await page.goto('/settings/git-notebooks');
    await page.getByTestId('git-add-open').click();
    const form = page.getByTestId('git-add');
    await form.getByTestId('repo-row').filter({ hasText: 'code' }).click();
    const folders = form.getByTestId('repo-folder');
    await expect(folders).toHaveCount(5);
    expect(
      await folders.evaluateAll((all) => all.map((each) => each.getAttribute('data-path'))),
    ).toEqual(['', 'docs', 'docs/guide', 'src', 'wiki']);
    await expect(folders.filter({ hasText: 'wiki' })).toContainText('Notebook · Team wiki');
    // A notebook's folder opens it; another branch drops that choice and asks for a name (review).
    await folders.filter({ hasText: 'wiki' }).click();
    await expect(form.getByTestId('git-add-opens')).toBeVisible();
    await form.getByTestId('git-add-branch').fill('dev');
    await expect(form.getByTestId('git-add-opens')).toHaveCount(0);
    await expect(form.getByTestId('git-add-name')).toBeVisible();
    await expect(form.getByTestId('git-add-dir')).toHaveValue('');
    await form.getByTestId('git-add-branch').fill('main');
    await expect(folders).toHaveCount(5);
    await folders.filter({ hasText: /^docs$/ }).click();
    // A bad name is refused in place; a good one is added under the selected folder and chosen.
    await form.getByTestId('repo-new-folder').fill('a/b');
    await form.getByTestId('repo-new-folder-add').click();
    await expect(form.getByTestId('repo-new-folder-message')).toContainText('no slashes');
    await form.getByTestId('repo-new-folder').fill('notes');
    await form.getByTestId('repo-new-folder-add').click();
    await expect(form.locator('[data-path="docs/notes"]')).toHaveAttribute('aria-selected', 'true');
    await expect(form.getByTestId('git-add-dir')).toHaveValue('docs/notes');
    const make = form.getByRole('button', { name: 'Make Notebook', exact: true });
    await expect(make).toBeDisabled();
    await form.getByTestId('git-add-name').fill('Code Notes');
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/new-folder.png` });
    await make.click();
    await expect(form.getByTestId('git-add-message')).toContainText(
      'Made the notebook “Code Notes”',
      {
        timeout: 30_000,
      },
    );
    const listed = await host.notebooks.list();
    expect(listed.find((each) => each.name === 'Code Notes')).toMatchObject({
      remote: code.remote,
      dir: 'docs/notes',
    });
    expect(errors).toEqual([]);
  });

  test('a notebook already in Penmoss shows Already Added and can’t be picked', async ({
    page,
    host,
  }) => {
    test.setTimeout(90_000);
    host.signInGit();
    const home = host.githubRepo('home', { pushedAt: '2026-11-06T10:00:00Z' });
    await host.seed({ name: 'Home', remote: home.remote });
    await page.goto('/settings/git-notebooks');
    await page.getByTestId('git-add-open').click();
    const form = page.getByTestId('git-add');
    await form.getByTestId('repo-row').filter({ hasText: 'home' }).click();
    const root = form.getByTestId('repo-folder').first();
    await expect(root).toContainText('Notebook · Home');
    await expect(root).toContainText('Already Added');
    await expect(root).toHaveAttribute('aria-disabled', 'true');
  });

  test('with no GitHub sign-in it opens on Type an Address; Try Again lists them; the switch keeps what was typed', async ({
    page,
    host,
  }) => {
    test.setTimeout(60_000);
    const errors = collectErrors(page);
    host.githubRepo('notes', { pushedAt: '2026-11-06T10:00:00Z' });
    await page.goto('/settings/git-notebooks');
    await page.getByTestId('git-add-open').click();
    const form = page.getByTestId('git-add');
    const signin = form.getByTestId('git-add-signin');
    await expect(signin).toContainText('isn’t signed in to GitHub');
    await expect(signin).toContainText('gh auth setup-git');
    await expect(form.getByTestId('git-add-way-type')).toHaveAttribute('aria-pressed', 'true');
    await form.getByTestId('git-add-remote').fill('git@example.com:me/typed.git');
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/signed-out.png` });
    expect(host.githubRepos.requests).toEqual([]);

    host.signInGit();
    await signin.getByTestId('git-add-signin-retry').click();
    await expect(form.getByTestId('repo-row')).toHaveCount(1);
    await form.getByTestId('git-add-way-type').click();
    await expect(form.getByTestId('git-add-remote')).toHaveValue('git@example.com:me/typed.git');
    await expect(form.getByTestId('git-add-signin')).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test('the picker fits a narrow window without scrolling sideways', async ({ page, host }) => {
    host.signInGit();
    host.githubRepo('a-repository-with-a-rather-long-name-for-a-narrow-window', {
      pushedAt: '2026-11-06T10:00:00Z',
    });
    await page.setViewportSize({ width: 375, height: 800 });
    await page.goto('/settings/git-notebooks');
    await page.getByTestId('git-add-open').click();
    await expect(page.getByTestId('repo-row')).toHaveCount(1);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/narrow.png` });
  });
});
