import { expect, test, type Page } from './fixtures';

// Ryan's feedback of 5 Nov 2026 ("Penmoss Feedback", Quanta), in the web app (the Mac app runs
// the same page): the sidebar's rows run its full width and each section's title row is boxed
// (A1097); Settings → Git Notebooks is a list whose rows open each notebook's own page, and the
// agents and the penmoss command are Settings → Agents (A1098).

const SHOTS = process.env['PENMOSS_EVIDENCE'];

test.use({
  seed: { name: 'Quanta', notes: [{ title: 'Current' }, { title: 'Penmoss Feedback' }] },
});

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(error.message));
  return errors;
}

test('1, 2: sidebar rows run edge to edge, and each section’s title row is boxed', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/');
  const sidebar = page.locator('#app-sidebar');
  const row = sidebar
    .locator('.sb-notebooks-body .tree-row')
    .filter({ hasText: 'Penmoss Feedback' });
  await expect(row).toBeVisible({ timeout: 30_000 });
  await row.click();
  const edges = await page.evaluate(() => {
    const side = document.querySelector('#app-sidebar')!;
    const inner = side.getBoundingClientRect();
    const border = parseFloat(getComputedStyle(side).borderRightWidth);
    const box = (selector: string) => {
      const b = document.querySelector(selector)!.getBoundingClientRect();
      return [b.left - inner.left, inner.right - border - b.right];
    };
    return {
      tree: box('.sb-notebooks-body .tree-row[aria-selected="true"], .sb-notebooks-body .tree-row'),
      recent: box('.sb-recent .sb-item'),
      head: box('.sb-part:not([hidden]) .sb-part-head'),
    };
  });
  // No margin either side: the rows and the title rows touch the sidebar's edges.
  for (const [where, [left, right]] of Object.entries(edges)) {
    expect(Math.abs(left!), `${where} left`).toBeLessThan(1);
    expect(Math.abs(right!), `${where} right`).toBeLessThan(1);
  }
  // Each section's title row has a line above and below it.
  const borders = await sidebar
    .locator('.sb-part:not([hidden]) .sb-part-head')
    .evaluateAll((heads) =>
      heads.map((head) => {
        const style = getComputedStyle(head);
        return [style.borderTopWidth, style.borderBottomWidth, style.borderTopStyle];
      }),
    );
  expect(borders.length).toBeGreaterThanOrEqual(3);
  for (const each of borders) expect(each).toEqual(['1px', '1px', 'solid']);
  // A notebook's own title row is not one of them.
  await expect(sidebar.locator('.sb-section .sb-notebook-name').first()).toBeVisible();
  expect(
    await sidebar
      .locator('.sb-notebooks-body .sb-section-head')
      .first()
      .evaluate((head) => getComputedStyle(head).borderBottomWidth),
  ).toBe('0px');
  if (SHOTS) await sidebar.screenshot({ path: `${SHOTS}/sidebar.png` });
  expect(errors).toEqual([]);
});

test('3: Git Notebooks lists the notebooks, each opening its own page; Agents has its own page', async ({
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
  await expect(settings.getByTestId('git-notebook').getByRole('heading', { level: 2 })).toHaveText(
    'Quanta',
  );
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
  await expect(agentRows.filter({ hasText: 'Work' })).toContainText('penmoss mcp --notebook Work');
  await expect(agents.getByTestId('git-local-agents')).toHaveCount(0);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/agents.png` });
  // …opening a page of its own with its agents.
  await agentRows.filter({ hasText: 'Work' }).click();
  await expect(page).toHaveURL(/\/settings\/agents\/[0-9A-Z]{26}$/);
  await expect(agents.getByTestId('notebook-agents')).toHaveCount(1);
  await expect(agents.getByTestId('notebook-agents')).toContainText('penmoss mcp --notebook Work');
  await expect(agents.getByTestId('git-local-agents')).toHaveCount(1);
  await agents.getByTestId('agents-back').click();
  await expect(page).toHaveURL(/\/settings\/agents$/);
  await expect(agentRows).toHaveCount(2);
  // A page that is not a notebook here says so.
  await page.goto('/settings/git-notebooks/01M6AAAAAAAAAAAAAAAAAAAAAA');
  await expect(page.getByTestId('git-notebook-missing')).toBeVisible();
  expect(errors).toEqual([]);
});
