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

  test('opens a notebook by picking its repository and folder, with nothing typed', async ({
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
    await page.getByTestId('first-run-existing').click();
    const form = page.getByTestId('git-add');
    const rows = form.getByTestId('repo-row');
    // Newest push first, each labelled; any visibility can be picked (D61), read-only can't.
    await expect(rows).toHaveCount(3);
    await expect(rows.nth(0)).toHaveAttribute('data-repo', 'ryan/notes');
    await expect(rows.nth(0)).toContainText('Private');
    await expect(rows.nth(1)).toContainText('Public');
    await expect(rows.nth(2)).toContainText('Internal');
    await expect(rows.nth(2)).toContainText('Read only');
    await expect(rows.nth(2)).toHaveAttribute('aria-disabled', 'true');
    await expect(form.getByTestId('repo-picker-via')).toContainText('through git on this Mac');
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/repos.png` });

    // Search filters; Escape clears it; the arrow keys and Enter pick.
    const search = form.getByTestId('repo-picker-search');
    await search.fill('wiki');
    await expect(rows).toHaveCount(1);
    await search.press('Escape');
    await expect(search).toHaveValue('');
    await expect(rows).toHaveCount(3);
    await search.press('ArrowDown');
    await expect(rows.nth(0)).toBeFocused();
    await page.keyboard.press('Enter');

    // The folder step: the root holds Kept, which opens under its own name.
    await expect(form.getByTestId('git-add-picked')).toContainText('ryan/notes');
    const root = form.getByTestId('repo-folder').first();
    await expect(root).toHaveAttribute('data-path', '');
    await expect(root).toContainText('Notebook · Kept');
    await root.click();
    await expect(form.getByTestId('git-add-opens')).toContainText('opens the existing notebook');
    await expect(form.getByTestId('git-add-name')).toHaveCount(0);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/folder-notebook.png` });
    await form.getByRole('button', { name: 'Open Notebook', exact: true }).click();
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

  test('Start New creates a private repository named after the notebook and makes it there', async ({
    page,
    host,
  }) => {
    test.setTimeout(90_000);
    const errors = collectErrors(page);
    host.signInGit();
    host.githubRepos.orgs = ['acme'];
    const used = host.githubRepo('used', { pushedAt: '2026-11-06T10:00:00Z' });
    pushFiles(host, used.remote, { 'README.md': '# used' });
    host.githubRepo('blank', { pushedAt: '2026-01-01T10:00:00Z' });

    await page.goto('/');
    await page.getByTestId('first-run-new').click();
    const form = page.getByTestId('git-add');
    // Empty repositories first in Start New.
    const rows = form.getByTestId('repo-row');
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toHaveAttribute('data-repo', 'ryan/blank');
    const create = form.getByTestId('repo-create');
    await expect(create.getByTestId('repo-create-owner')).toContainText('ryan (you)');
    await expect(create.getByTestId('repo-create-owner')).toContainText('acme');
    // The name follows the notebook's until it is edited (D62).
    await create.getByTestId('repo-create-notebook').fill('Work Log');
    await expect(create.getByTestId('repo-create-name')).toHaveValue('work-log-notes');
    await create.getByTestId('repo-create-name').fill('used');
    await create.getByTestId('repo-create-notebook').fill('Work Logs');
    await expect(create.getByTestId('repo-create-name')).toHaveValue('used');
    // GitHub's refusal shows in place.
    await create.getByTestId('repo-create-submit').click();
    await expect(create.getByTestId('repo-create-message')).toContainText('is there already');
    await create.getByTestId('repo-create-name').fill('work-log-notes');
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/create.png` });
    await create.getByTestId('repo-create-submit').click();

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
