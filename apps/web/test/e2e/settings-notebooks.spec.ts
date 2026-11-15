// Settings → Notebooks and Agents: the list, a notebook’s page, the primary notebook.
import { expect, type Locator, type Page, test } from './fixtures';
import { collectErrors, ULID } from './support/app';
import { SLOW_SHELL_MS } from './support/git-host';

const SHOTS = process.env['PENMOSS_EVIDENCE'];
test.describe('in Quanta, with two notes', () => {
  test.use({
    seed: { name: 'Quanta', notes: [{ title: 'Current' }, { title: 'Penmoss Feedback' }] },
  });

  // Ryan’s feedback of 5 Nov 2026 (Quanta), item 3.
  test('All Notebooks lists the notebooks, each opening its own page; Agents has its own page', async ({
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
    await expect(page.getByTestId('add-notebook')).toHaveCount(0);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/git-notebooks.png` });
    // Add Notebook… is the first run's own screens, in a sheet (A1562); Cancel closes it.
    await settings.getByTestId('git-add-open').click();
    await expect(page.getByTestId('add-notebook')).toBeVisible();
    await page.getByTestId('first-run-cancel').click();
    await expect(page.getByTestId('add-notebook')).toHaveCount(0);

    // A row opens that notebook's page, at its own address, in three tabs (PEN-146); All
    // Notebooks in the nav returns to the list.
    await rows.filter({ hasText: 'Quanta' }).click();
    await expect(page).toHaveURL(/\/settings\/git-notebooks\/[0-9A-Z]{26}$/);
    const card = settings.getByTestId('git-notebook');
    await expect(card).toHaveCount(1);
    await expect(card.getByRole('heading', { name: 'Quanta' })).toBeVisible();
    await expect(card.getByTestId('git-status')).toHaveAttribute('data-phase', 'synced');
    await expect(card.getByRole('tab')).toHaveText(['Overview', 'Sync', 'Git']);
    // Agents are not a notebook's (PEN-146): they are Settings → Agents.
    await expect(page.getByTestId('git-local-agents')).toHaveCount(0);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/git-notebook-page.png` });
    // It is a page of its own: a reload keeps it.
    await page.reload();
    await expect(
      settings.getByTestId('git-notebook').getByRole('heading', { level: 1 }),
    ).toHaveText('Quanta');
    await page
      .getByRole('navigation', { name: 'Settings sections' })
      .getByRole('link', { name: 'All Notebooks', exact: true })
      .click();
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
    // A list of the notebooks, folded (PEN-146: one page, amending A1125)…
    const agentRows = agents.getByTestId('agents-notebook-row');
    await expect(agentRows).toHaveCount(2);
    await expect(agents.getByTestId('git-local-agents')).toHaveCount(0);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/agents.png` });
    // …each unfolding in place to its agents and the name agents reach it by.
    const work = agentRows.filter({ hasText: 'Work' });
    await work.getByTestId('agents-notebook-fold').click();
    await expect(page).toHaveURL(/\/settings\/agents$/);
    await expect(agents.getByTestId('notebook-agents')).toHaveCount(1);
    await expect(agents.getByTestId('notebook-agents')).toContainText(
      'penmoss mcp --notebook Work',
    );
    await expect(agents.getByTestId('git-local-agents')).toHaveCount(1);
    await work.getByTestId('agents-notebook-fold').click();
    await expect(agents.getByTestId('notebook-agents')).toHaveCount(0);
    // Its own address opens the page with it unfolded.
    await page.goto((await work.getAttribute('data-path'))!);
    await expect(agents.getByTestId('notebook-agents')).toContainText(
      'penmoss mcp --notebook Work',
    );
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
  test('a notebook’s page reads on the page’s own background; the Primary Notebook is chosen in All Notebooks', async ({
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
    await expect(page1.getByRole('heading', { level: 1 })).toHaveText('Personal');
    // No card: the page's background shows through.
    expect(await page1.evaluate((element) => getComputedStyle(element).backgroundColor)).toBe(
      'rgba(0, 0, 0, 0)',
    );
    expect(await page1.evaluate((element) => getComputedStyle(element).borderTopWidth)).toBe('0px');
    // Its badge (PEN-140, A1504): in its heading, and on Overview right after its name.
    await expect(
      page1.getByRole('heading', { level: 1 }).getByTestId('notebook-badge'),
    ).toBeVisible();
    const overview = page1.getByTestId('git-panel-overview').locator('.lf-group').first();
    await expect(overview.locator('> .lf-row').nth(0)).toHaveAttribute(
      'data-setting',
      'notebook-name',
    );
    await expect(overview.locator('> .lf-row').nth(1)).toHaveAttribute('data-setting', 'badge');
    await expect(overview.getByTestId('badge-row').locator('.lf-row-label')).toHaveText('Badge');
    // Three tabs (PEN-146); the commit name and email are on Git, one width, one under the other.
    await expect(page1.getByRole('tab')).toHaveText(['Overview', 'Sync', 'Git']);
    await page1.getByRole('tab', { name: 'Git' }).click();
    const name = await page1.getByTestId('git-author-name').boundingBox();
    const email = await page1.getByTestId('git-author-email').boundingBox();
    expect(Math.round(name!.width)).toBe(Math.round(email!.width));
    expect(email!.y).toBeGreaterThan(name!.y);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/git-notebook-page.png`, fullPage: true });

    // The one Primary Notebook picker is All Notebooks' (PEN-146).
    await page.goto('/settings/git-notebooks');
    const picker = settings.getByTestId('git-primary-picker');
    await picker.selectOption({ label: 'Personal' });
    await expect(rows.filter({ hasText: 'Personal' }).getByTestId('git-row-primary')).toBeVisible();
    await rows.filter({ hasText: 'Personal' }).click();
    await expect(page1.getByTestId('git-primary-chip')).toHaveText('Primary');
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

    // A notebook's agents, unfolded in place (PEN-146: one page, folded, amending A1125).
    const row = agents.getByTestId('agents-notebook-row');
    await row.getByTestId('agents-notebook-fold').click();
    await expect(row.getByTestId('agents-notebook-fold')).toHaveAttribute('aria-expanded', 'true');
    const notebook = agents.getByTestId('notebook-agents');
    await expect(row).toContainText('Quanta');
    await expect(notebook).toContainText('penmoss mcp --notebook Quanta');
    await expect(notebook.getByTestId('git-local-agents')).toBeVisible();
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/agents-notebook.png` });
    // Its address opens the page with it unfolded; Agent Activity is the page beside it.
    await page.goto((await row.getAttribute('data-path'))!);
    await expect(notebook.getByTestId('git-local-agents')).toBeVisible();
    await agents.getByTestId('agents-activity-link').click();
    await expect(page).toHaveURL(/\/settings\/agent-activity$/);
    await expect(page.getByTestId('agent-activity-settings')).toBeVisible();
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
    await page.goto('/settings/note');
    // Behind the header's (i) since A1560.
    const home = page.getByTestId('settings-home');
    await page.getByTestId('settings-info').click();
    await expect(home).toHaveText(
      'Settings are synced through your primary notebook, Quanta. Those marked stay on this Mac only.',
    );
    if (SHOTS)
      await page.locator('.settings-head-bar').screenshot({ path: `${SHOTS}/settings-home.png` });

    // A setting in the primary notebook, copied into Work from Work's page.
    await page.getByTestId('display-note-bar-delete').check();
    await page.getByTestId('settings-info').click();
    await page.getByTestId('settings-home-link').click();
    await expect(page.getByTestId('git-primary-chip')).toBeVisible();
    // Item 12: no Private line.
    await expect(page.getByText('Private', { exact: true })).toHaveCount(0);
    await page.goto('/settings/git-notebooks');
    await page.getByTestId('git-notebook-row').filter({ hasText: 'Work' }).click();
    // Copy Settings… opens From (the primary) and To (this notebook) (PEN-146).
    await page.getByTestId('git-copy-settings-open').click();
    const copy = page.getByTestId('git-settings-copy');
    await expect(copy.getByTestId('git-copy-from').locator('option:checked')).toHaveText('Quanta');
    await expect(copy.getByTestId('git-copy-to').locator('option:checked')).toHaveText('Work');
    // Its note is help text, as a row's is (A1561): it took the page's body size, larger than
    // the rows' help above it (Ryan's finding 4).
    const type = (locator: Locator) =>
      locator.evaluate((element) => {
        const style = getComputedStyle(element);
        return [style.fontSize, style.fontWeight, style.lineHeight, style.color].join(' ');
      });
    const note = copy.getByText(/^Replaces Work’s settings with Quanta’s/);
    const help = page.locator('.settings-content .lf-row-help').first();
    await expect(help).toBeVisible();
    expect(await type(note)).toBe(await type(help));
    const label = page.locator('.settings-content .lf-row-label').first();
    const px = async (locator: Locator) =>
      parseFloat(await locator.evaluate((element) => getComputedStyle(element).fontSize));
    expect(await px(note)).toBeLessThan(await px(label));
    await copy.getByTestId('git-copy-settings').click();
    await expect(copy.getByTestId('git-copy-settings-done')).toHaveText(
      'Copied Quanta’s settings to Work.',
    );
    await copy.getByTestId('git-copy-settings').click();
    await expect(copy.getByTestId('git-copy-settings-done')).toHaveText(
      'Work already had these settings.',
    );
    if (SHOTS) await copy.screenshot({ path: `${SHOTS}/copy-settings.png` });
    // Work made primary, in All Notebooks' picker: it reads the same, so the bar keeps Move to
    // Trash.
    await page.goto('/settings/git-notebooks');
    await page.getByTestId('git-primary-picker').selectOption({ label: 'Work' });
    await expect(
      page
        .getByTestId('git-notebook-row')
        .filter({ hasText: 'Work' })
        .getByTestId('git-row-primary'),
    ).toBeVisible();
    await expect(page.getByTestId('settings-home')).toContainText(
      'Settings are synced through your primary notebook, Work.',
    );
    await page.goto('/settings/note');
    await expect(page.getByTestId('display-note-bar-delete')).toBeChecked();
    expect(errors).toEqual([]);
  });
});
