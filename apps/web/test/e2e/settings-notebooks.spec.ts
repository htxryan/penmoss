// Settings → Notebooks and Agents: the list, a notebook’s page, the primary notebook.
import { expect, type Page, test } from './fixtures';
import { collectErrors, ULID } from './support/app';
import { SLOW_SHELL_MS } from './support/git-host';

const SHOTS = process.env['PENMOSS_EVIDENCE'];
test.describe('in Quanta, with two notes', () => {
  test.use({
    seed: { name: 'Quanta', notes: [{ title: 'Current' }, { title: 'Penmoss Feedback' }] },
  });

  // Ryan’s feedback of 5 Nov 2026 (Quanta), item 3.
  test('Notebooks lists the notebooks, each opening its own page; Agents has its own page', async ({
    page,
    host,
  }) => {
    test.setTimeout(120_000);
    const errors = collectErrors(page);
    await host.seed({ name: 'Work', notes: [{ title: 'Parser' }] });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto('/settings/git-notebooks');
    const settings = page.getByTestId('git-notebooks-settings');
    const rows = settings.getByTestId('git-notebook-row');
    await expect(rows).toHaveCount(2);
    await expect(rows.filter({ hasText: 'Quanta' })).toHaveAttribute('data-phase', 'synced', {
      timeout: 40_000,
    });
    // The list alone: no notebook's details, no agents, no command, and Add behind a button.
    await expect(settings.getByTestId('git-notebook')).toHaveCount(0);
    await expect(settings.getByTestId('git-sync-now')).toHaveCount(0);
    await expect(page.getByTestId('git-local-agents')).toHaveCount(0);
    await expect(page.getByTestId('git-add')).toHaveCount(0);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/git-notebooks.png` });
    await settings.getByTestId('git-add-open').click();
    await expect(page.getByTestId('git-add')).toBeVisible();

    // A row opens that notebook's page, at its own address; the back link returns to the list.
    await rows.filter({ hasText: 'Quanta' }).click();
    await expect(page).toHaveURL(/\/settings\/git-notebooks\/[0-9A-Z]{26}$/);
    const card = settings.getByTestId('git-notebook');
    await expect(card).toHaveCount(1);
    await expect(card.getByRole('heading', { name: 'Quanta' })).toBeVisible();
    await expect(card.getByTestId('git-status')).toHaveAttribute('data-phase', 'synced');
    await expect(card.getByTestId('git-notebook-agents')).toContainText(
      'penmoss mcp --notebook Quanta',
    );
    await expect(page.getByTestId('git-local-agents')).toHaveCount(0);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/git-notebook-page.png` });
    // It is a page of its own: a reload keeps it.
    await page.reload();
    await expect(
      settings.getByTestId('git-notebook').getByRole('heading', { level: 2 }),
    ).toHaveText('Quanta');
    await settings.getByTestId('git-notebook-back').click();
    await expect(page).toHaveURL(/\/settings\/git-notebooks$/);
    await expect(rows).toHaveCount(2);

    // Settings → Agents: each notebook, with the name agents reach it by.
    await card.waitFor({ state: 'detached' });
    await page
      .getByRole('navigation', { name: 'Settings sections' })
      .getByRole('link', { name: 'Agents', exact: true })
      .click();
    await expect(page).toHaveURL(/\/settings\/agents$/);
    const agents = page.getByTestId('agents-settings');
    // A list of the notebooks (Quanta feedback 2, A1125), each with the name agents reach it by…
    const agentRows = agents.getByTestId('agents-notebook-row');
    await expect(agentRows).toHaveCount(2);
    await expect(agentRows.filter({ hasText: 'Work' })).toContainText(
      'penmoss mcp --notebook Work',
    );
    await expect(agents.getByTestId('git-local-agents')).toHaveCount(0);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/agents.png` });
    // …opening a page of its own with its agents.
    await agentRows.filter({ hasText: 'Work' }).click();
    await expect(page).toHaveURL(/\/settings\/agents\/[0-9A-Z]{26}$/);
    await expect(agents.getByTestId('notebook-agents')).toHaveCount(1);
    await expect(agents.getByTestId('notebook-agents')).toContainText(
      'penmoss mcp --notebook Work',
    );
    await expect(agents.getByTestId('git-local-agents')).toHaveCount(1);
    await agents.getByTestId('agents-back').click();
    await expect(page).toHaveURL(/\/settings\/agents$/);
    await expect(agentRows).toHaveCount(2);
    // A page that is not a notebook here says so.
    await page.goto('/settings/git-notebooks/01M6AAAAAAAAAAAAAAAAAAAAAA');
    await expect(page.getByTestId('git-notebook-missing')).toBeVisible();
    expect(errors).toEqual([]);
  });
});

const section = (page: Page, name: string) =>
  page.getByTestId('source-section').and(page.getByRole('region', { name, exact: true }));

const tree = (page: Page, name: string) =>
  section(page, name).getByRole('tree', { name: 'Folders and notes' });
test.describe('in Quanta, with two folders and two notes', () => {
  test.use({
    seed: {
      name: 'Quanta',
      folders: ['Substation', 'Geotech'],
      notes: [{ title: 'Alpha' }, { title: 'Penmoss Feedback' }],
    },
  });

  // Ryan’s feedback of 5 Nov 2026 (Personal), items 1, 9.
  test('a notebook’s page reads on the page’s own background; the Primary Notebook is chosen there', async ({
    page,
    host,
  }) => {
    test.setTimeout(120_000);
    const errors = collectErrors(page);
    await host.seed({ name: 'Personal', notes: [{ title: 'Test' }] });
    await page.setViewportSize({ width: 1280, height: 1000 });
    await page.goto('/settings/git-notebooks');
    const settings = page.getByTestId('git-notebooks-settings');
    const rows = settings.getByTestId('git-notebook-row');
    await expect(rows).toHaveCount(2);
    // The first notebook added is the primary one until another is chosen.
    await expect(rows.filter({ hasText: 'Quanta' }).getByTestId('git-row-primary')).toBeVisible();
    await expect(rows.filter({ hasText: 'Personal' }).getByTestId('git-row-primary')).toHaveCount(
      0,
    );

    await rows.filter({ hasText: 'Personal' }).click();
    const page1 = settings.getByTestId('git-notebook');
    await expect(page1.getByRole('heading', { level: 2 })).toHaveText('Personal');
    // No card: the page's background shows through, and its groups have headings of their own.
    expect(await page1.evaluate((element) => getComputedStyle(element).backgroundColor)).toBe(
      'rgba(0, 0, 0, 0)',
    );
    expect(await page1.evaluate((element) => getComputedStyle(element).borderTopWidth)).toBe('0px');
    // Name is the first group since a notebook can be renamed there (A1383).
    await expect(page1.getByRole('heading', { level: 3 })).toHaveText([
      'Name',
      'About',
      'Primary Notebook',
      'Sync',
      'Commits',
      'Access',
      'Agent Activity',
    ]);
    // Commits' fields are one width, one under the other.
    const name = await page1.getByTestId('git-author-name').boundingBox();
    const email = await page1.getByTestId('git-author-email').boundingBox();
    expect(Math.round(name!.width)).toBe(Math.round(email!.width));
    expect(email!.y).toBeGreaterThan(name!.y);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/git-notebook-page.png`, fullPage: true });

    await page1.getByTestId('git-make-primary').click();
    await expect(page1.getByTestId('git-primary-chip')).toHaveText('Primary Notebook');
    await expect(page1.getByTestId('git-primary-state')).toContainText('your primary notebook');
    await expect(page1.getByTestId('git-make-primary')).toHaveCount(0);
    // Daily Notes no longer chooses it, and says where it is chosen.
    await page.goto('/settings/journal');
    await expect(page.getByTestId('journal-notebook')).toHaveCount(0);
    await expect(page.getByTestId('journal-settings')).toContainText('Primary Notebook');
    // Today's note goes to it.
    await page.goto('/');
    await page.locator('button[data-command="journal.today"]').first().click();
    await expect(page).toHaveURL(ULID);
    const today = ULID.exec(new URL(page.url()).pathname)![1]!;
    await expect(tree(page, 'Personal').locator(`a[href="/notes/${today}"]`)).toBeVisible();
    await expect(tree(page, 'Quanta').locator(`a[href="/notes/${today}"]`)).toHaveCount(0);
    expect(errors).toEqual([]);
  });
});

const LONG = Array.from({ length: 80 }, (_, n) => `Line ${n + 1} of a long note.`).join('\n\n');
test.describe('in Quanta, with a folder and a long note', () => {
  test.use({
    seed: {
      name: 'Quanta',
      folders: ['Miscellaneous'],
      notes: [{ title: 'Josh Onboarding' }, { title: 'Long', markdown: `${LONG}\n` }],
    },
  });

  // T65, item 5.
  test('Settings → Agents shows the command’s card at once, and its notebooks as a list', async ({
    page,
    host,
  }) => {
    const errors = collectErrors(page);
    await page.goto('/settings/agents');
    const agents = page.getByTestId('agents-settings');
    const card = agents.getByTestId('git-cli');
    // At once, though the login shell takes 3 s to say its PATH the first time.
    await expect(card).toBeVisible({ timeout: 1000 });
    await expect(card.getByRole('heading', { name: 'The penmoss Command' })).toBeVisible();
    await expect(agents.getByTestId('agents-notebook-row')).toHaveCount(1);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/agents-list.png` });
    await expect(card.getByTestId('git-cli-state')).toHaveText(/^Not installed\./, {
      timeout: SLOW_SHELL_MS + 5000,
    });
    // The PATH is kept: next time, the card is whole at once.
    await page.reload();
    await expect(page.getByTestId('git-cli-state')).toHaveText(/^Not installed\./, {
      timeout: 1000,
    });

    // A notebook's agents, on a page of its own.
    await agents.getByTestId('agents-notebook-row').click();
    await expect(page).toHaveURL(/\/settings\/agents\/[0-9A-Z]{26}$/);
    const notebook = agents.getByTestId('notebook-agents');
    await expect(notebook.getByRole('heading', { level: 2 })).toHaveText('Quanta');
    await expect(notebook).toContainText('penmoss mcp --notebook Quanta');
    await expect(notebook.getByTestId('git-local-agents')).toBeVisible();
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/agents-notebook.png` });
    // Its git notebook page links here, and here back to it.
    await notebook.getByTestId('agents-notebook-git').click();
    await expect(page).toHaveURL(/\/settings\/git-notebooks\/[0-9A-Z]{26}$/);
    await page.getByTestId('git-notebook-agents-link').click();
    await expect(page).toHaveURL(/\/settings\/agents\/[0-9A-Z]{26}$/);
    await page.getByTestId('agents-back').click();
    await expect(page).toHaveURL(/\/settings\/agents$/);
    void host;
    expect(errors).toEqual([]);
  });
});

async function openNote(page: Page, title: string, notebook = 'Quanta'): Promise<void> {
  await section(page, notebook)
    .getByRole('tree', { name: 'Folders and notes' })
    .getByRole('link', { name: title, exact: true })
    .click();
  await expect(page).toHaveURL(ULID);
  await expect(page.getByTestId('note-title')).toHaveValue(title);
}
test.describe('in Quanta, with a folder, a long note and a source', () => {
  test.use({
    seed: {
      name: 'Quanta',
      folders: ['Miscellaneous'],
      notes: [
        { title: 'Penmoss Roadmap', markdown: 'Plans for Penmoss.\n' },
        { title: 'Long', markdown: `${LONG}\n` },
        { title: 'Source', markdown: '## Plan\n\nFirst line.\n' },
      ],
    },
  });

  // T66, items 9, 10, 12.
  test('Settings name the primary notebook; settings copy to another notebook', async ({
    page,
    host,
  }) => {
    const errors = collectErrors(page);
    await page.goto('/');
    await openNote(page, 'Source');
    await host.seed({ name: 'Work', notes: [{ title: 'Parser' }] });
    await expect(section(page, 'Work')).toBeVisible({ timeout: 40_000 });
    await page.goto('/settings/display');
    const home = page.getByTestId('settings-home');
    await expect(home).toHaveText('Settings are synced through your primary notebook, Quanta.');
    if (SHOTS)
      await page.locator('.settings-title').screenshot({ path: `${SHOTS}/settings-home.png` });

    // A setting in the primary notebook, copied into Work from Work's page.
    await page.getByTestId('display-note-bar-delete').check();
    await page.getByTestId('settings-home-link').click();
    await expect(page.getByTestId('git-primary-state')).toBeVisible();
    // Item 12: no Private line.
    await expect(page.getByText('Private', { exact: true })).toHaveCount(0);
    await page.goto('/settings/git-notebooks');
    await page.getByTestId('git-notebook-row').filter({ hasText: 'Work' }).click();
    const copy = page.getByTestId('git-settings-copy');
    await copy.getByTestId('git-copy-settings').click();
    await expect(copy.getByTestId('git-copy-settings-done')).toHaveText(
      'Copied Quanta’s settings to Work.',
    );
    await copy.getByTestId('git-copy-settings').click();
    await expect(copy.getByTestId('git-copy-settings-done')).toHaveText(
      'Work already had these settings.',
    );
    if (SHOTS)
      await page.getByTestId('git-primary').screenshot({ path: `${SHOTS}/copy-settings.png` });
    // Work made primary: it reads the same, so the bar keeps Move to Trash.
    await page.getByTestId('git-make-primary').click();
    await expect(page.getByTestId('git-primary-state')).toBeVisible();
    await expect(page.getByTestId('settings-home')).toHaveText(
      'Settings are synced through your primary notebook, Work.',
    );
    await page.goto('/settings/display');
    await expect(page.getByTestId('display-note-bar-delete')).toBeChecked();
    expect(errors).toEqual([]);
  });
});
