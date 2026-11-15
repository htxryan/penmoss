// Add a Git Notebook from Settings: the repositories git can reach, and Sign In with GitHub.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, type GitHost, test } from './fixtures';
import { collectErrors } from './support/app';
import { GITHUB_WEB } from './support/git-host';

const SHOTS = process.env['PENMOSS_EVIDENCE'];

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

test('signs in with GitHub, lists the repositories with it, and adds a notebook with its token', async ({
  page,
  host,
}) => {
  test.setTimeout(90_000);
  const errors = collectErrors(page);
  host.offerSignIn = true;
  host.githubRepo('notes', { pushedAt: '2026-11-06T10:00:00Z' });
  await page.goto('/settings/git-notebooks');
  await page.getByTestId('git-add-open').click();
  const form = page.getByTestId('git-add');
  const signin = form.getByTestId('github-signin');
  await expect(signin.getByTestId('github-signin-start')).toHaveText('Sign In with GitHub');
  // The gh route and Type an Address stay as the other ways.
  await expect(form.getByTestId('git-add-signin')).toContainText('gh auth setup-git');
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/sign-in-offered.png` });

  await signin.getByTestId('github-signin-start').click();
  await expect(signin).toHaveAttribute('data-state', 'waiting');
  await expect(signin.getByTestId('github-signin-code')).toHaveText('WDJB-MJHT');
  await expect(signin.getByTestId('github-signin-waiting')).toContainText('Waiting for you');
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await signin.getByTestId('github-signin-copy').click();
  await expect(signin.getByTestId('github-signin-copy')).toHaveText('Copied');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('WDJB-MJHT');
  // Only GitHub's own page is opened, once.
  expect(host.opened).toEqual([`${GITHUB_WEB}/login/device`]);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/sign-in-code.png` });

  host.githubRepos.approve();
  await expect(form.getByTestId('repo-picker-via')).toContainText(
    'Signed in to GitHub as ryan in Penmoss.',
  );
  await form.getByTestId('repo-row').filter({ hasText: 'notes' }).click();
  await expect(form.getByTestId('repo-folders')).toBeVisible();
  await form.getByTestId('git-add-name').fill('Field Notes');
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/signed-in-picked.png` });
  await form.getByRole('button', { name: 'Make Notebook' }).click();
  await expect(form.getByTestId('git-add-message')).toContainText('Made the notebook');
  // The page asked main to give the notebook Penmoss's token; it never had the token itself.
  expect(host.addInputs.at(-1)).toMatchObject({ githubSignIn: true });
  expect(JSON.stringify(host.addInputs)).not.toContain(host.githubRepos.options.token);

  // Settings → Status → GitHub Token: whose it is, and Sign Out.
  await page.goto('/settings/status');
  await expect(page.getByTestId('github-token-saved')).toContainText(
    'Signed in to GitHub as ryan.',
  );
  await expect(page.getByTestId('github-token-remove')).toHaveText('Sign Out');
  expect(errors).toEqual([]);
});

test('a sign-in not approved, run out, or cancelled, can be tried again', async ({
  page,
  host,
}) => {
  test.setTimeout(60_000);
  host.offerSignIn = true;
  host.githubRepo('notes', { pushedAt: '2026-11-06T10:00:00Z' });
  host.githubRepos.device.polls = ['pending', 'denied', 'expired'];
  await page.goto('/settings/git-notebooks');
  await page.getByTestId('git-add-open').click();
  const signin = page.getByTestId('github-signin');
  await signin.getByTestId('github-signin-start').click();
  await expect(signin).toHaveAttribute('data-state', 'denied');
  await expect(signin.getByTestId('github-signin-ended')).toContainText('not approved');
  await expect(signin.getByTestId('github-signin-start')).toHaveText('Try Again');

  await signin.getByTestId('github-signin-start').click();
  await expect(signin).toHaveAttribute('data-state', 'expired');
  await expect(signin.getByTestId('github-signin-ended')).toContainText('ran out');
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/sign-in-expired.png` });

  await signin.getByTestId('github-signin-start').click();
  await expect(signin).toHaveAttribute('data-state', 'waiting');
  await signin.getByTestId('github-signin-cancel').click();
  await expect(signin).toHaveAttribute('data-state', 'cancelled');
  await expect(page.getByTestId('github-token-saved')).toHaveCount(0);
  expect(host.githubRepos.device.codes).toBe(3);
});

test('a sign-in still waiting when the form is opened again lists the repositories once approved (review)', async ({
  page,
  host,
}) => {
  test.setTimeout(60_000);
  host.offerSignIn = true;
  host.githubRepo('notes', { pushedAt: '2026-11-06T10:00:00Z' });
  await page.goto('/settings/git-notebooks');
  await page.getByTestId('git-add-open').click();
  await page.getByTestId('github-signin-start').click();
  await expect(page.getByTestId('github-signin-code')).toBeVisible();
  // Away and back: the form is new, the sign-in is still waiting in main.
  await page.goto('/settings/status');
  await page.goto('/settings/git-notebooks');
  await page.getByTestId('git-add-open').click();
  await expect(page.getByTestId('github-signin-code')).toHaveText('WDJB-MJHT');
  host.githubRepos.approve();
  await expect(page.getByTestId('repo-picker-via')).toContainText('as ryan in Penmoss');
  expect(host.githubRepos.device.codes).toBe(1);
});

test('a sign-in GitHub refuses later asks to sign in again, and Settings says so', async ({
  page,
  host,
}) => {
  test.setTimeout(60_000);
  host.offerSignIn = true;
  host.githubRepo('notes', { pushedAt: '2026-11-06T10:00:00Z' });
  // Signed in earlier; GitHub has since revoked the token.
  await host.githubToken.saveSignedIn(host.githubRepos.options.token, 'ryan');
  host.githubRepos.failNext = { status: 401, headers: {}, body: { message: 'Bad credentials' } };
  await page.goto('/settings/git-notebooks');
  await page.getByTestId('git-add-open').click();
  const form = page.getByTestId('git-add');
  await expect(form.getByTestId('git-add-signin')).toContainText(
    'GitHub refused Penmoss’s sign-in',
  );
  await expect(form.getByTestId('github-signin-start')).toHaveText('Sign In to GitHub Again');
  await page.goto('/settings/status');
  await expect(page.getByTestId('github-token-problem')).toContainText('Sign in again');
});

test('a build without Penmoss’s GitHub app offers no sign-in', async ({ page, host }) => {
  host.githubRepo('notes', { pushedAt: '2026-11-06T10:00:00Z' });
  await page.goto('/settings/git-notebooks');
  await page.getByTestId('git-add-open').click();
  const form = page.getByTestId('git-add');
  await expect(form.getByTestId('git-add-signin')).toContainText('gh auth setup-git');
  await expect(form.getByTestId('github-signin')).toHaveCount(0);
});

test('the sign-in code fits a narrow window', async ({ page, host }) => {
  host.offerSignIn = true;
  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto('/settings/git-notebooks');
  await page.getByTestId('git-add-open').click();
  await page.getByTestId('github-signin-start').click();
  await expect(page.getByTestId('github-signin-code')).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/sign-in-narrow.png` });
  await page.getByTestId('github-signin-cancel').click();
});
