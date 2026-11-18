// Add Notebook from Settings (A1562): the first run's own screens, in a sheet over Settings, with
// the repositories git can reach and Sign In with GitHub.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, type GitHost, type Locator, type Page, test } from './fixtures';
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

/** Settings → All Notebooks → Add Notebook…: the sheet, on Create or Open Notebook. */
async function openAdd(page: Page): Promise<Locator> {
  await page.goto('/settings/git-notebooks');
  await page.getByTestId('git-add-open').click();
  const sheet = page.getByTestId('add-notebook');
  await expect(sheet.getByRole('heading', { name: 'Create or Open Notebook' })).toBeFocused();
  return sheet;
}

/** Open an existing notebook: on to GitHub Access, or straight to the repositories. */
async function toRepositories(sheet: Locator): Promise<void> {
  await sheet.getByTestId('first-run-existing').click();
  await sheet.getByTestId('first-run-continue').click();
}

/** A repository's row in the repository tree. */
const repoRow = (sheet: Locator, fullName: string) =>
  sheet.locator(`[data-testid="first-run-tree-repo"][data-repo="${fullName}"]`);

const overflow = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

test.describe('Settings', () => {
  test('Add Notebook… is the first run’s screens in a sheet, with no welcome; Cancel and Escape return to All Notebooks', async ({
    page,
  }) => {
    const errors = collectErrors(page);
    const sheet = await openAdd(page);
    await expect(page.getByRole('dialog', { name: 'Add Notebook' })).toBeVisible();
    await expect(sheet.getByTestId('first-run-goal')).toContainText('Step 1 of 3');
    await expect(sheet.getByTestId('first-run-new')).toContainText('A new, empty notebook');
    await expect(sheet).not.toContainText('Welcome to Penmoss');
    await expect(sheet.getByTestId('first-run-back')).toHaveCount(0);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/add-notebook-sheet.png` });
    await sheet.getByTestId('first-run-cancel').click();
    await expect(sheet).toHaveCount(0);
    await expect(page).toHaveURL(/\/settings\/git-notebooks$/);
    await expect(page.getByTestId('git-notebook-row').first()).toBeVisible();

    // Past its first screen it has Back, as the first run does; Escape closes it from any screen.
    await page.getByTestId('git-add-open').click();
    await sheet.getByTestId('first-run-continue').click();
    await expect(sheet.getByRole('heading', { name: 'Pick Repository' })).toBeVisible();
    await expect(sheet.getByTestId('first-run-cancel')).toHaveCount(0);
    await sheet.getByTestId('first-run-back').click();
    await expect(sheet.getByTestId('first-run-cancel')).toBeVisible();
    await sheet.getByTestId('first-run-continue').click();
    await page.keyboard.press('Escape');
    await expect(sheet).toHaveCount(0);
    await expect(page).toHaveURL(/\/settings\/git-notebooks$/);
    expect(errors).toEqual([]);
  });

  test('a new folder in a code repository, by the folder rules; dot-folders are not listed; it ends on the notebook’s page', async ({
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
    });

    const sheet = await openAdd(page);
    await sheet.getByTestId('first-run-continue').click();
    await sheet.getByTestId('first-run-way-existing').click();
    await sheet.getByTestId('first-run-continue').click();
    await repoRow(sheet, 'ryan/code').getByTestId('first-run-repo-pick').click();
    await expect(sheet.getByRole('heading', { name: 'Pick Folder' })).toBeVisible();
    const folders = sheet.getByTestId('first-run-folder-option');
    expect(
      await folders.evaluateAll((all) => all.map((each) => each.getAttribute('data-path'))),
    ).toEqual(['', 'docs', 'docs/guide', 'src']);
    await folders
      .filter({ hasText: /^docs\// })
      .first()
      .click();
    // A bad name is refused in place; a good one is added under the chosen folder and picked.
    await sheet.getByTestId('first-run-new-folder').fill('a/b');
    await sheet.getByTestId('first-run-new-folder-add').click();
    await expect(sheet.getByTestId('first-run-new-folder-problem')).toContainText('no slashes');
    await sheet.getByTestId('first-run-new-folder').fill('notes');
    await sheet.getByTestId('first-run-new-folder-add').click();
    await expect(sheet.locator('[data-path="docs/notes"] input')).toBeChecked();
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/new-folder.png` });
    await sheet.getByTestId('first-run-continue').click();
    await expect(sheet.getByRole('heading', { name: 'Name Your Notebook' })).toBeVisible();
    await expect(sheet.getByTestId('first-run-place')).toContainText('docs/notes/');
    await sheet.getByTestId('first-run-name-input').fill('Code Notes');
    await sheet.getByTestId('first-run-make').click();

    // Set up (its first sync), it closes on the notebook's page; no welcome note in it.
    await expect(page).toHaveURL(/\/settings\/git-notebooks\/[0-9A-Z]{26}$/, { timeout: 30_000 });
    await expect(sheet).toHaveCount(0);
    const card = page.getByTestId('git-notebook');
    await expect(card.getByRole('heading', { name: 'Code Notes' })).toBeVisible();
    const listed = await host.notebooks.list();
    expect(listed.find((each) => each.name === 'Code Notes')).toMatchObject({
      remote: code.remote,
      dir: 'docs/notes',
    });
    expect(errors).toEqual([]);
  });

  test('a repository holding a notebook offers it, not its folders, and another notebook beside it', async ({
    page,
    host,
  }) => {
    test.setTimeout(90_000);
    host.signInGit();
    const team = host.githubRepo('team', { pushedAt: '2026-11-06T10:00:00Z' });
    pushFiles(host, team.remote, {
      'wiki/.penmoss/notebook.json': notebookJson('01JBNOTEBOOK00000000000042', 'Team wiki'),
      'wiki/Inbox/Call.md': 'call\n',
    });
    const sheet = await openAdd(page);
    await toRepositories(sheet);
    const row = repoRow(sheet, 'ryan/team');
    await expect(row.getByTestId('first-run-notebook')).toContainText('Team wiki');
    await row.getByTestId('first-run-repo-pick').click();
    await expect(sheet.getByRole('heading', { name: 'Team wiki Is Already Here' })).toBeVisible();
    await expect(sheet.getByTestId('first-run-open')).toHaveText('Open Team wiki');
    await expect(sheet.getByTestId('first-run-folder-option')).toHaveCount(0);
    await sheet.getByTestId('first-run-another').fill('.hidden');
    await sheet.getByTestId('first-run-another-make').click();
    await expect(sheet.getByRole('alert')).toContainText('dot');
    await sheet.getByTestId('first-run-another').fill('journal');
    await sheet.getByTestId('first-run-another-make').click();
    await expect(sheet.getByRole('heading', { name: 'Name Your Notebook' })).toBeVisible();
    await expect(sheet.getByTestId('first-run-place')).toContainText('journal/');
  });

  test('a notebook already in Penmoss shows Already Added and can’t be opened again', async ({
    page,
    host,
  }) => {
    test.setTimeout(90_000);
    host.signInGit();
    const home = host.githubRepo('home', { pushedAt: '2026-11-06T10:00:00Z' });
    await host.seed({ name: 'Home', remote: home.remote });
    const sheet = await openAdd(page);
    await toRepositories(sheet);
    const notebook = repoRow(sheet, 'ryan/home').getByTestId('first-run-notebook');
    await expect(notebook).toContainText('Home');
    await expect(notebook).toContainText('Already Added');
    await expect(notebook).toHaveAttribute('aria-disabled', 'true');
    await expect(notebook.getByTestId('first-run-notebook-open')).toHaveCount(0);
    await repoRow(sheet, 'ryan/home').getByTestId('first-run-repo-pick').click();
    await expect(sheet.getByTestId('first-run-already-added')).toContainText('Already Added');
    await expect(sheet.getByTestId('first-run-open')).toHaveCount(0);
  });

  test('with no GitHub sign-in it offers Paste a URL Instead and Try Again; Try Again goes on', async ({
    page,
    host,
  }) => {
    test.setTimeout(60_000);
    const errors = collectErrors(page);
    host.githubRepo('notes', { pushedAt: '2026-11-06T10:00:00Z' });
    const sheet = await openAdd(page);
    await toRepositories(sheet);
    const github = sheet.getByTestId('first-run-github');
    await expect(github).toHaveAttribute('data-state', 'signed-out');
    await expect(sheet.getByRole('heading', { name: 'Sign In to GitHub' })).toBeVisible();
    await expect(sheet.getByTestId('first-run-gh-hint')).toContainText('gh auth login');
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/signed-out.png` });
    expect(host.githubRepos.requests).toEqual([]);
    // Paste a URL Instead goes on without GitHub; Back returns to the step before the sign-in.
    await sheet.getByTestId('first-run-url-instead').click();
    await expect(sheet.getByTestId('first-run-url-input')).toBeVisible();
    await sheet.getByTestId('first-run-back').click();
    await expect(sheet.getByRole('heading', { name: 'Create or Open Notebook' })).toBeVisible();

    await sheet.getByTestId('first-run-continue').click();
    await expect(github).toHaveAttribute('data-state', 'signed-out');
    host.signInGit();
    await sheet.getByTestId('first-run-retry').click();
    await expect(repoRow(sheet, 'ryan/notes')).toHaveCount(1);
    expect(errors).toEqual([]);
  });

  test('the repositories fit a narrow window without scrolling sideways', async ({
    page,
    host,
  }) => {
    host.signInGit();
    host.githubRepo('a-repository-with-a-rather-long-name-for-a-narrow-window', {
      pushedAt: '2026-11-06T10:00:00Z',
    });
    await page.setViewportSize({ width: 375, height: 800 });
    const sheet = await openAdd(page);
    await toRepositories(sheet);
    await expect(sheet.getByTestId('first-run-tree-repo')).toHaveCount(1);
    expect(await overflow(page)).toBeLessThanOrEqual(0);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/narrow.png` });
  });
});

test('signs in with GitHub on the same screens, lists the repositories with it, and adds a notebook with its token', async ({
  page,
  host,
}) => {
  test.setTimeout(90_000);
  const errors = collectErrors(page);
  host.offerSignIn = true;
  host.githubRepo('notes', { pushedAt: '2026-11-06T10:00:00Z' });
  const sheet = await openAdd(page);
  await toRepositories(sheet);
  await expect(sheet.getByTestId('first-run-signin')).toHaveText('Sign In with GitHub');
  // The gh route and Paste a URL Instead stay as the other ways.
  await expect(sheet.getByTestId('first-run-gh-hint')).toContainText('gh auth login');
  await expect(sheet.getByTestId('first-run-url-instead')).toBeVisible();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/sign-in-offered.png` });

  await sheet.getByTestId('first-run-signin').click();
  await expect(sheet.getByRole('heading', { name: 'Enter This Code on GitHub' })).toBeVisible();
  await expect(sheet.getByTestId('github-signin-code')).toHaveText('WDJB-MJHT');
  await expect(sheet.getByTestId('github-signin-waiting')).toContainText('Waiting for you');
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await sheet.getByTestId('github-signin-copy').click();
  await expect(sheet.getByTestId('github-signin-copy')).toHaveText('Copied');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('WDJB-MJHT');
  // Only GitHub's own page is opened, once.
  expect(host.opened).toEqual([`${GITHUB_WEB}/login/device`]);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/sign-in-code.png` });

  host.githubRepos.approve();
  await expect(sheet.getByTestId('first-run-signed-in')).toContainText('Signed in as ryan');
  await sheet.getByTestId('first-run-continue').click();
  await expect(sheet.getByTestId('first-run-via')).toHaveText('ryan');
  await repoRow(sheet, 'ryan/notes').getByTestId('first-run-repo-pick').click();
  await expect(sheet.getByRole('heading', { name: 'Empty Repository' })).toBeVisible();
  await sheet.getByTestId('first-run-continue').click();
  await sheet.getByTestId('first-run-name-input').fill('Field Notes');
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/signed-in-picked.png` });
  await sheet.getByTestId('first-run-make').click();
  await expect(page).toHaveURL(/\/settings\/git-notebooks\/[0-9A-Z]{26}$/, { timeout: 30_000 });
  await expect(
    page.getByTestId('git-notebook').getByRole('heading', { name: 'Field Notes' }),
  ).toBeVisible();
  // The page asked main to give the notebook Penmoss's token; it never had the token itself.
  expect(host.addInputs.at(-1)).toMatchObject({ githubSignIn: true });
  expect(JSON.stringify(host.addInputs)).not.toContain(host.githubRepos.options.token);

  // Settings → GitHub (PEN-146): whose it is, and Sign Out; another account beside it (A1617).
  await page.goto('/settings/github');
  await expect(page.getByTestId('github-account')).toContainText('ryan');
  await expect(page.getByTestId('github-token-saved')).toHaveText(
    'Signed in with GitHub · kept in this Mac’s Keychain',
  );
  await expect(page.getByTestId('github-token-remove')).toHaveText('Sign Out');
  await expect(page.getByTestId('github-token').getByTestId('github-signin-start')).toHaveText(
    'Add Account',
  );
  await expect(page.getByTestId('github-token-open')).toHaveText('Use a Token Instead…');
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
  const sheet = await openAdd(page);
  await toRepositories(sheet);
  const github = sheet.getByTestId('first-run-github');
  await sheet.getByTestId('first-run-signin').click();
  await expect(github).toHaveAttribute('data-state', 'stopped');
  await expect(sheet.getByTestId('github-signin-ended')).toContainText('not approved');
  await expect(sheet.getByTestId('first-run-signin')).toHaveText('Sign In Again');

  await sheet.getByTestId('first-run-signin').click();
  await expect(sheet.getByTestId('github-signin-ended')).toContainText('ran out');
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/sign-in-expired.png` });

  await sheet.getByTestId('first-run-signin').click();
  await expect(github).toHaveAttribute('data-state', 'code');
  await sheet.getByTestId('github-signin-cancel').click();
  await expect(github).toHaveAttribute('data-state', 'stopped');
  await expect(sheet.getByTestId('github-signin-ended')).toContainText('cancelled');
  expect(host.githubRepos.device.codes).toBe(3);
});

test('a sign-in still waiting when Add Notebook is opened again lists the repositories once approved (review)', async ({
  page,
  host,
}) => {
  test.setTimeout(60_000);
  host.offerSignIn = true;
  host.githubRepo('notes', { pushedAt: '2026-11-06T10:00:00Z' });
  let sheet = await openAdd(page);
  await toRepositories(sheet);
  await sheet.getByTestId('first-run-signin').click();
  await expect(sheet.getByTestId('github-signin-code')).toBeVisible();
  // Away and back: the sheet is new, the sign-in is still waiting in main.
  await page.goto('/settings/agents');
  sheet = await openAdd(page);
  await toRepositories(sheet);
  await expect(sheet.getByTestId('github-signin-code')).toHaveText('WDJB-MJHT');
  host.githubRepos.approve();
  await expect(sheet.getByTestId('first-run-signed-in')).toContainText('Signed in as ryan');
  await sheet.getByTestId('first-run-continue').click();
  await expect(sheet.getByTestId('first-run-via')).toHaveText('ryan');
  expect(host.githubRepos.device.codes).toBe(1);
});

test('a sign-in GitHub refuses later asks to sign in again, and Settings says so', async ({
  page,
  host,
}) => {
  test.setTimeout(60_000);
  host.offerSignIn = true;
  host.githubRepo('notes', { pushedAt: '2026-11-06T10:00:00Z' });
  // Signed in earlier; GitHub has since revoked the token, so it refuses every call with it (the
  // dev build's StrictMode asks twice, which a one-off refusal would not survive).
  await host.githubToken.saveSignedIn('gho_revoked0e2e', 'ryan');
  const sheet = await openAdd(page);
  await toRepositories(sheet);
  await expect(sheet.getByTestId('first-run-github')).toHaveAttribute('data-state', 'refused');
  await expect(sheet.getByRole('heading', { name: 'GitHub Refused the Sign-In' })).toBeVisible();
  await expect(sheet.getByTestId('first-run-signin')).toHaveText('Sign In with GitHub');
  // Settings → GitHub says so, and offers the sign-in again, and the token (PEN-146).
  await page.goto('/settings/github');
  await expect(page.getByTestId('github-token-problem')).toContainText('Sign in again');
  const github = page.getByTestId('github-token');
  await expect(github.getByTestId('github-signin-start')).toHaveText('Sign In to GitHub Again');
  await expect(github.getByTestId('github-token-open')).toHaveText('Use a Token Instead…');
  await github.getByTestId('github-token-open').click();
  await expect(github.getByTestId('github-token-input')).toBeFocused();
});

test('a build without Penmoss’s GitHub app offers no sign-in', async ({ page, host }) => {
  host.githubRepo('notes', { pushedAt: '2026-11-06T10:00:00Z' });
  const sheet = await openAdd(page);
  await toRepositories(sheet);
  await expect(sheet.getByTestId('first-run-gh-hint')).toContainText('gh auth login');
  await expect(sheet.getByTestId('first-run-signin')).toHaveCount(0);
  await expect(sheet.getByTestId('first-run-retry')).toHaveText('Try Again');
});

test('the sign-in code fits a narrow window', async ({ page, host }) => {
  host.offerSignIn = true;
  await page.setViewportSize({ width: 375, height: 800 });
  const sheet = await openAdd(page);
  await toRepositories(sheet);
  await sheet.getByTestId('first-run-signin').click();
  await expect(sheet.getByTestId('github-signin-code')).toBeVisible();
  expect(await overflow(page)).toBeLessThanOrEqual(0);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/sign-in-narrow.png` });
  await sheet.getByTestId('github-signin-cancel').click();
});

test('Settings → GitHub signs in with the same device sign-in, and Sign Out forgets it (PEN-146)', async ({
  page,
  host,
}) => {
  test.setTimeout(60_000);
  const errors = collectErrors(page);
  host.offerSignIn = true;
  await page.goto('/settings/github');
  const github = page.getByTestId('github-token');
  await expect(github.getByTestId('github-account')).toContainText('Not Signed In');
  // Sign In with GitHub first; the token is the other way, behind Use a Token Instead….
  await expect(github.getByTestId('github-signin-start')).toHaveText('Sign In with GitHub');
  await expect(github.getByTestId('github-token-input')).toHaveCount(0);
  await expect(github.getByTestId('github-token-open')).toHaveText('Use a Token Instead…');
  // What the sign-in is for.
  await expect(github.locator('[data-setting="adding-notebooks"]')).toContainText(
    'Adding Notebooks',
  );
  await expect(github.locator('[data-setting="send-feedback"]')).toContainText(
    'Opens issues in htxryan/penmoss',
  );

  await github.getByTestId('github-signin-start').click();
  await expect(github.getByTestId('github-signin-code')).toHaveText('WDJB-MJHT');
  host.githubRepos.approve();
  await expect(github.getByTestId('github-account')).toContainText('ryan');
  await expect(github.getByTestId('github-token-saved')).toContainText('Signed in with GitHub');
  // Another account, such as a work one, can be added beside it (A1617).
  await expect(github.getByTestId('github-signin-start')).toHaveText('Add Account');

  await github.getByTestId('github-token-remove').click();
  await expect(github.getByTestId('github-account')).toContainText('Not Signed In');
  expect(await host.githubToken.status()).toMatchObject({ saved: false });
  expect(errors).toEqual([]);
});
