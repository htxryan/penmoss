import { expect, test, type Page } from './fixtures';
import { GITHUB_WEB } from './support/git-host';

// T82 (#229, D63, A1170–A1172): with no GitHub sign-in in git, Add a Git Notebook offers
// Penmoss's own. Main runs GitHub's device flow (the code here, github.com/login/device in the
// browser), keeps the token in the GitHub Token store, lists repositories with it and gives it
// to the notebook added with it. github.com is the fake's scripted device flow.

const SHOTS = process.env['PENMOSS_EVIDENCE'];

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(error.message));
  return errors;
}

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
    await expect(firstRun.getByTestId('first-run-via')).toContainText(
      'Signed in to GitHub as ryan',
    );
    expect(errors).toEqual([]);
  });
});
