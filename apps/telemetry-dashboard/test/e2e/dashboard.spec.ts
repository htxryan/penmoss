/**
 * The usage dashboard (PEN-137, AC30–AC33, AC14's dashboard part): behind Access, over the fixture
 * D1, every view draws its charts; each chart answers hover with a tooltip, opens its table and
 * downloads its CSV; the filters narrow it; Paths hides the rare path; it fits a phone. The proof
 * walk ends on the Overview; the last test holds on Platforms' Common Window Sizes (PEN-174).
 */
import { expect, test as base, type Page } from '@playwright/test';
import { startDashboard, type Dashboard } from './server';

const test = base.extend<{ signedIn: Page }, { dashboard: Dashboard }>({
  dashboard: [
    // eslint-disable-next-line no-empty-pattern -- Playwright fixtures destructure their deps.
    async ({}, use) => {
      const dashboard = await startDashboard();
      await use(dashboard);
      await dashboard.stop();
    },
    { scope: 'worker', timeout: 120_000 },
  ],
  signedIn: async ({ page, dashboard }, use) => {
    // What Cloudflare Access adds to every request it lets through.
    await page.setExtraHTTPHeaders({ 'cf-access-jwt-assertion': dashboard.token });
    // keepBlobs: each Blob the page makes a URL for, so a test can read a download's text.
    await page.addInitScript(() => {
      const blobs: Blob[] = [];
      (window as unknown as { blobs: Blob[] }).blobs = blobs;
      const create = URL.createObjectURL.bind(URL);
      URL.createObjectURL = (object: Blob | MediaSource) => {
        if (object instanceof Blob) blobs.push(object);
        return create(object);
      };
    });
    await use(page);
  },
});

// One dashboard on one port: these tests share it in one worker, also under apps/web's config.
test.describe.configure({ mode: 'serial' });

const VIEWS = [
  ['overview', 'Overview'],
  ['commands', 'Commands & Shortcuts'],
  ['firstrun', 'First Run'],
  ['paths', 'Paths'],
  ['platforms', 'Platforms'],
  ['agents', 'Agents'],
  ['health', 'Health'],
] as const;

async function openView(page: Page, name: string): Promise<void> {
  await page
    .getByRole('navigation', { name: 'Views' })
    .getByRole('link', { name, exact: true })
    .click();
  await expect(page.getByRole('heading', { level: 1, name, exact: true })).toBeVisible();
  await expect(page.locator('main')).not.toHaveAttribute('aria-busy', 'true');
}

/** Lets the recording dwell on what was just checked. */
const hold = (page: Page) => page.waitForTimeout(2000);

/**
 * The tooltip, shown for `hovered`, covers neither it nor the axis labels: the chart's area
 * below its plot (the x axis's labels) and left of it (the y axis's, or a bar chart's labels).
 */
async function expectTipClear(
  page: Page,
  chart: ReturnType<Page['locator']>,
  hovered: { x: number; y: number; width: number; height: number } | null,
  plot: { left: number; bottom: number },
): Promise<void> {
  const tip = (await page.getByRole('tooltip').boundingBox())!;
  const box = (await chart.boundingBox())!;
  const overlaps = (a: typeof tip, b: typeof tip) =>
    a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
  const xAxis = {
    x: box.x,
    y: box.y + box.height - plot.bottom,
    width: box.width,
    height: plot.bottom,
  };
  const yAxis = { x: box.x, y: box.y, width: plot.left, height: box.height };
  expect(overlaps(tip, xAxis), 'the tooltip covers the x axis').toBe(false);
  expect(overlaps(tip, yAxis), 'the tooltip covers the labels at the left').toBe(false);
  if (hovered) expect(overlaps(tip, hovered), 'the tooltip covers what it describes').toBe(false);
}

/** Hover, Table and CSV on the chart card `title`. */
async function checkCard(page: Page, title: string): Promise<void> {
  const card = page.getByRole('region', { name: title, exact: true });
  await card.scrollIntoViewIfNeeded();
  const chart = card.locator('svg.chart');
  await expect(chart).toBeVisible();
  // Hover: the first mark's hit area shows the tooltip.
  const hit = chart.locator('.hit').first();
  await hit.hover({ force: true });
  const tip = page.getByRole('tooltip');
  await expect(tip).toBeVisible();
  await expect(tip).not.toBeEmpty();
  await page.mouse.move(0, 0);
  await expect(tip).toBeHidden();
  // Table: opens and closes under the chart.
  const toggle = card.getByRole('button', { name: `Table: ${title}` });
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  const table = card.getByRole('table');
  await expect(table).toBeVisible();
  expect(await table.locator('tbody tr').count()).toBeGreaterThan(0);
  // CSV: the same rows, as a download. The file's text is read from the Blob the page hands the
  // browser (recorded by keepBlobs), since a sandboxed Chromium may not finish writing the file.
  const download = page.waitForEvent('download');
  await card.getByRole('button', { name: `Download CSV: ${title}` }).click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(/^penmoss-[a-z-]+-\d+d\.csv$/);
  const text = await page.evaluate(() => {
    const blobs = (window as unknown as { blobs: Blob[] }).blobs;
    return blobs.at(-1)!.text();
  });
  const csv = text.trim().split('\n');
  const header = await table.locator('thead th').allTextContents();
  // A column of display names with their ids muted under them has its ids in a column of their
  // own in the CSV, beside it ("Command", "Command ID").
  const withIds = await table
    .locator('tbody tr')
    .first()
    .locator('td')
    .evaluateAll((cells) => cells.map((cell) => cell.querySelector('.cell-id') !== null));
  const csvHeader = header.flatMap((cell, i) => (withIds[i] ? [cell, `${cell} ID`] : [cell]));
  expect(csv[0]).toBe(csvHeader.map((cell) => (/[",]/.test(cell) ? `"${cell}"` : cell)).join(','));
  expect(csv.length - 1).toBe(await table.locator('tbody tr').count());
  await toggle.click();
  await expect(table).toBeHidden();
}

test('without Access, nothing: the page and the API are 403', async ({ dashboard, request }) => {
  for (const path of ['/', '/app.js', '/api/overview']) {
    expect((await request.get(`${dashboard.url}${path}`)).status(), path).toBe(403);
  }
  const forged = await request.get(`${dashboard.url}/api/overview`, {
    headers: { 'cf-access-jwt-assertion': `${dashboard.token.slice(0, -8)}AAAAAAAA` },
  });
  expect(forged.status()).toBe(403);
});

test('the views fit a phone, with no sideways scrolling', async ({ signedIn: page, dashboard }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  for (const [id, name] of VIEWS) {
    await page.goto(`${dashboard.url}/#${id}`);
    await expect(page.getByRole('heading', { level: 1, name, exact: true })).toBeVisible();
    await expect(page.locator('svg.chart').first()).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    expect(overflow, name).toBeLessThanOrEqual(0);
  }
});

test('the filters narrow every view, and the API refuses what is not on their lists', async ({
  signedIn: page,
  dashboard,
}) => {
  await page.goto(`${dashboard.url}/#overview`);
  const today = page.locator('.tile', { hasText: 'Active Installs Today' }).locator('dd');
  await expect(today).toHaveText('10');
  await page.getByLabel('Client', { exact: true }).selectOption('android');
  await expect(today).toHaveText('2');
  await page.getByLabel('Channel', { exact: true }).selectOption('alpha');
  await expect(today).toHaveText('1');
  await page.getByLabel('Client', { exact: true }).selectOption('');
  await page.getByLabel('Channel', { exact: true }).selectOption('');
  await expect(page.getByLabel('Version', { exact: true }).locator('option')).toHaveCount(5);
  await page.getByLabel('Version', { exact: true }).selectOption('1.3.2');
  const versions = page.getByRole('region', { name: 'Top Versions' }).locator('tbody tr');
  await expect(versions.first().locator('td').first()).toHaveText('1.3.2');
  for (const cell of await versions.locator('td:first-child').allTextContents()) {
    expect(cell).toBe('1.3.2');
  }
  const bad = await page.request.get(`${dashboard.url}/api/overview?client=ios`, {
    headers: { 'cf-access-jwt-assertion': dashboard.token },
  });
  expect(bad.status()).toBe(400);
});

test('every view, every chart: hover, Table and CSV; ends on the Overview', async ({
  signedIn: page,
  dashboard,
}) => {
  test.setTimeout(120_000);
  await page.goto(`${dashboard.url}/`);
  await expect(page).toHaveTitle('Overview · Penmoss Usage');
  await expect(page.getByRole('heading', { level: 1, name: 'Overview' })).toBeVisible();

  // Overview (AC30): the tiles, weekly actives by client, the actor split, top versions.
  await expect(page.getByText('Signed in through Cloudflare Access')).toBeVisible();
  await expect(page.getByTestId('freshness')).toContainText(/^Data as of .+ UTC · newest event/);
  await expect(page.getByTestId('freshness')).toContainText('rollups through');
  const tiles = page.locator('.tile');
  await expect(tiles.locator('dt')).toHaveText([
    'Active Installs Today',
    'Active Installs, Last 7 Days',
    'Active Installs, Last 30 Days',
  ]);
  await expect(
    page.locator('.tile', { hasText: 'Active Installs, Last 7 Days' }).locator('dd'),
  ).toHaveText('10');
  // Every tile's number is the same size.
  const sizes = await tiles
    .locator('dd')
    .evaluateAll((nodes) => nodes.map((node) => getComputedStyle(node).fontSize));
  expect(new Set(sizes).size).toBe(1);
  await hold(page);
  for (const title of ['Weekly Active Installs by Client', 'Events by Actor']) {
    await checkCard(page, title);
  }
  // Top Versions is a table: Version, Client, Installs.
  const topVersions = page.getByRole('region', { name: 'Top Versions' });
  await topVersions.scrollIntoViewIfNeeded();
  await expect(topVersions.getByRole('table').locator('thead th')).toHaveText([
    'Version',
    'Client',
    'Installs',
  ]);
  await expect(topVersions.getByRole('table')).toContainText('Mac');
  await expect(
    topVersions.getByRole('button', { name: 'Download CSV: Top Versions' }),
  ).toBeVisible();
  await hold(page);
  // A day's tooltip sits beside its line, over neither axis's labels.
  const weekly = page.getByRole('region', { name: 'Weekly Active Installs by Client' });
  await weekly.scrollIntoViewIfNeeded();
  const weeklyChart = weekly.locator('svg.chart');
  const weeklyBox = (await weeklyChart.boundingBox())!;
  for (const at of [0.15, 0.85]) {
    await page.mouse.move(weeklyBox.x + weeklyBox.width * at, weeklyBox.y + weeklyBox.height - 40);
    await expect(page.getByRole('tooltip')).toBeVisible();
    await expectTipClear(page, weeklyChart, null, { left: 44, bottom: 26 });
  }
  // The actor split's column: the tooltip covers neither the column nor the axes.
  const actors = page.getByRole('region', { name: 'Events by Actor' }).locator('svg.chart');
  await actors.scrollIntoViewIfNeeded();
  const column = actors.locator('path.mark').last();
  const columnBox = (await column.boundingBox())!;
  await page.mouse.move(columnBox.x + columnBox.width / 2, columnBox.y + columnBox.height / 2);
  await expect(page.getByRole('tooltip')).toBeVisible();
  await expectTipClear(page, actors, columnBox, { left: 44, bottom: 26 });
  await hold(page);
  await page.mouse.move(0, 0);
  await expect(
    page.getByRole('list', { name: 'Weekly Active Installs by Client Legend' }),
  ).toContainText('Android');

  // Commands & Shortcuts (AC31).
  await openView(page, 'Commands & Shortcuts');
  for (const title of ['Top 25 Commands', 'Shortcuts']) await checkCard(page, title);
  await expect(page.getByRole('list', { name: 'Top 25 Commands Legend' })).toContainText('Palette');
  // Top 25 Commands has its Installs column beside the runs.
  const topCommands = page.getByRole('region', { name: 'Top 25 Commands', exact: true });
  await topCommands.scrollIntoViewIfNeeded();
  await expect(topCommands.locator('svg.chart .col-head')).toHaveText(['Installs', 'Runs']);
  // Each command by its name in the shortcut contract, never its id; the id is in the tooltip
  // and muted under the name in the table.
  const commandLabels = topCommands.locator('svg.chart text.label');
  await expect(commandLabels).toContainText(['New Note']);
  // The label's own text, without the <title> that holds its id for a pointer's hover.
  const visible = (labels: typeof commandLabels) =>
    labels.evaluateAll((nodes) => nodes.map((node) => node.firstChild?.textContent ?? ''));
  for (const label of await visible(commandLabels)) expect(label).not.toMatch(/\w\.\w/);
  await topCommands.locator('svg.chart .hit').first().hover({ force: true });
  await expect(page.getByRole('tooltip').locator('.tip-id')).toHaveText(/^[a-z]+\.[A-Za-z.]+$/);
  await page.mouse.move(0, 0);
  await topCommands.getByRole('button', { name: 'Table: Top 25 Commands' }).click();
  const newNote = topCommands
    .locator('tbody tr')
    .filter({ has: page.locator('.cell-id', { hasText: /^note\.new$/ }) });
  await expect(newNote.locator('td').first()).toHaveText('New Notenote.new');
  await expect(newNote.locator('.cell-id')).toHaveText('note.new');
  await hold(page);
  await topCommands.getByRole('button', { name: 'Table: Top 25 Commands' }).click();
  // Shortcuts: each combination's default and how many installs rebound it.
  const shortcuts = page.getByRole('region', { name: 'Shortcuts', exact: true });
  await shortcuts.scrollIntoViewIfNeeded();
  await expect(shortcuts.locator('svg.chart .col-head')).toHaveText([
    'Default',
    'Rebound',
    'Key Share',
  ]);
  await expect(shortcuts.locator('svg.chart')).toContainText('Alt+N');
  for (const label of await visible(shortcuts.locator('svg.chart text.label'))) {
    expect(label).not.toMatch(/\w\.\w/);
  }
  await hold(page);
  // Never Used: chips, counted in the heading.
  const neverUsed = page.getByRole('region', { name: /^Never Used [\d,]+$/ });
  await neverUsed.scrollIntoViewIfNeeded();
  await expect(neverUsed.getByRole('heading', { level: 2 })).toHaveText(/^Never Used [\d,]+$/);
  const chips = neverUsed.getByRole('list', { name: 'Never Used Names' });
  // By name ("Graph"), the id in the chip's tooltip.
  await expect(chips.locator('li[title="app.graph"]')).toHaveText('Graph');
  await expect(chips).not.toContainText('app.graph');
  const count = Number((await neverUsed.locator('h2 .count').textContent())!.replaceAll(',', ''));
  await expect(chips.locator('li')).toHaveCount(count);
  await hold(page);

  // First Run and Paths (AC32): the funnel narrows; a path under 5 sessions never shows.
  await openView(page, 'First Run');
  for (const title of ['First Run Funnel', 'Where Installs Gave Up']) await checkCard(page, title);
  const funnel = page.getByRole('region', { name: 'First Run Funnel' });
  await funnel.scrollIntoViewIfNeeded();
  for (const step of ['Welcome', 'Choose a Goal', 'Sign In with GitHub', 'Consent Answered']) {
    await expect(funnel.locator('svg')).toContainText(step);
  }
  await expect(funnel.locator('svg')).not.toContainText('welcome');
  await hold(page);
  await openView(page, 'Paths');
  await expect(page.getByLabel('Start From')).toHaveValue('Command Palette · Command');
  // The field's options say how often each event occurred, the most frequent first.
  await expect(page.locator('.picker .occurrences')).toHaveText(/^[\d,]+ times in the period$/);
  const labels = await page
    .locator('#start-options option')
    .evaluateAll((nodes) => nodes.slice(0, 3).map((node) => (node as HTMLOptionElement).label));
  for (const label of labels) expect(label).toMatch(/ · [\d,]+ times?$/);
  await checkCard(page, 'What Comes After Command Palette');
  const paths = page.getByRole('region', { name: 'What Comes After Command Palette' });
  // Nodes by name: the command note.new is New Note, the screen note is Note.
  const nodeLabels = paths.locator('svg text.node-label');
  await expect(nodeLabels).toContainText(['Command Palette']);
  const shown = await nodeLabels.allTextContents();
  expect(shown).toContain('New Note');
  for (const label of shown) expect(label).not.toMatch(/\w\.\w|\(screen\)/);
  await paths.locator('g.node').nth(1).hover({ force: true });
  await expect(page.getByRole('tooltip').locator('.tip-id')).not.toBeEmpty();
  await page.mouse.move(0, 0);
  await expect(paths).not.toContainText('app.trash');
  // Each node has room round its label: 10px inside its box.
  const node = paths.locator('g.node').nth(1);
  const [boxRect, labelRect] = await Promise.all([
    node.locator('rect').boundingBox(),
    node.locator('text.node-label').boundingBox(),
  ]);
  expect(labelRect!.x - boxRect!.x).toBeGreaterThanOrEqual(9);
  expect(labelRect!.y - boxRect!.y).toBeGreaterThanOrEqual(5);
  await paths.scrollIntoViewIfNeeded();
  await hold(page);
  await page.getByLabel('Start From').fill('New Note');
  await page.getByLabel('Start From').press('Enter');
  await page.getByLabel('Start From').blur();
  await expect(page.getByRole('region', { name: 'What Comes After New Note' })).toBeVisible();

  // Platforms and Agents (AC33).
  await openView(page, 'Platforms');
  for (const title of [
    'Clients and OS Versions',
    'Version Adoption',
    'Window Size Classes',
    'Common Window Sizes',
  ]) {
    await checkCard(page, title);
  }
  // A bar's tooltip sits above its row, clear of the bar and of the labels.
  const os = page.getByRole('region', { name: 'Clients and OS Versions' }).locator('svg.chart');
  await os.scrollIntoViewIfNeeded();
  const row = os.locator('rect.hit-area').nth(1);
  const rowBox = (await row.boundingBox())!;
  await page.mouse.move(rowBox.x + rowBox.width * 0.7, rowBox.y + rowBox.height / 2);
  await expect(page.getByRole('tooltip')).toBeVisible();
  const label = (await os.locator('text.label').first().boundingBox())!;
  await expectTipClear(page, os, rowBox, {
    left: label.x + label.width - (await os.boundingBox())!.x,
    bottom: 0,
  });
  // Version adoption's crosshair: beside the line, inside the plot.
  const adoption = page.getByRole('region', { name: 'Version Adoption' }).locator('svg.chart');
  await adoption.scrollIntoViewIfNeeded();
  const adoptionBox = (await adoption.boundingBox())!;
  await page.mouse.move(
    adoptionBox.x + adoptionBox.width * 0.5,
    adoptionBox.y + adoptionBox.height - 30,
  );
  await expect(page.getByRole('tooltip')).toBeVisible();
  await expectTipClear(page, adoption, null, { left: 44, bottom: 26 });
  await hold(page);
  await page.mouse.move(0, 0);
  await openView(page, 'Agents');
  for (const title of ['Events by Actor', 'CLI Commands and MCP Tools by Agent', 'Result Rates']) {
    await checkCard(page, title);
  }
  // Legends name agent clients as people do, never by their ids.
  const agentLegend = page.getByRole('list', {
    name: 'CLI Commands and MCP Tools by Agent Legend',
  });
  await agentLegend.scrollIntoViewIfNeeded();
  await expect(agentLegend).toContainText('Claude Code');
  await expect(agentLegend).toContainText('Codex');
  await expect(agentLegend).not.toContainText('claude-code');
  await hold(page);
  // Result rates: each CLI command and MCP tool by agent client, with its calls' results.
  const rates = page.getByRole('region', { name: 'Result Rates' });
  await rates.scrollIntoViewIfNeeded();
  await expect(rates.getByRole('list', { name: 'Result Rates Legend' }).locator('li')).toHaveText([
    'OK',
    'Invalid',
    'Not Found',
    'Conflict',
    'Failed',
  ]);
  await expect(rates.locator('svg.chart')).toContainText('MCP · ');
  await expect(rates.locator('svg.chart')).toContainText('Claude Code');
  await hold(page);

  // Health.
  await openView(page, 'Health');
  for (const title of ['Events per Day', 'Sync Passes']) await checkCard(page, title);

  // Nothing on any view names an install.
  const body = await page.locator('body').innerText();
  expect(body).not.toMatch(/[0-9a-f]{32}/);

  // The proof ends on the Overview, a chart's tooltip showing.
  await openView(page, 'Overview');
  await page.evaluate(() => window.scrollTo(0, 0));
  const chart = page
    .getByRole('region', { name: 'Weekly Active Installs by Client' })
    .locator('svg.chart');
  const box = (await chart.boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.8, box.y + box.height * 0.5);
  await expect(page.getByRole('tooltip')).toBeVisible();
  await page.waitForTimeout(2000);
});

test('Platforms: Common Window Sizes, the most common main window sizes per client, then Other', async ({
  signedIn: page,
  dashboard,
}) => {
  await page.goto(`${dashboard.url}/#platforms?days=30`);
  await expect(
    page.getByRole('heading', { level: 1, name: 'Platforms', exact: true }),
  ).toBeVisible();
  await expect(page.locator('main')).not.toHaveAttribute('aria-busy', 'true');
  // Right after Window Size Classes.
  const titles = await page
    .locator('section.card h2')
    .evaluateAll((nodes) => nodes.map((node) => node.firstChild?.textContent?.trim() ?? ''));
  expect(titles.indexOf('Common Window Sizes')).toBe(titles.indexOf('Window Size Classes') + 1);
  const card = page.getByRole('region', { name: 'Common Window Sizes', exact: true });
  await card.scrollIntoViewIfNeeded();
  await expect(card.locator('.note')).toHaveText(
    'Installs by main window size: the 10 most common per client, then Other.',
  );
  const chart = card.locator('svg.chart');
  await expect(chart).toBeVisible();
  await expect(chart).toContainText('Mac · 1440 × 900');
  // Each bar's label as drawn (its full name is also its title).
  const labels = await chart
    .locator('text.label')
    .evaluateAll((nodes) => nodes.map((node) => node.firstChild?.textContent ?? ''));
  expect(labels).toEqual([
    'Android · Other',
    'Mac · 1440 × 900',
    'Mac · 1280 × 800',
    'Mac · Other',
  ]);
  await expect(card.getByRole('button', { name: 'Table: Common Window Sizes' })).toBeVisible();
  await expect(
    card.getByRole('button', { name: 'Download CSV: Common Window Sizes' }),
  ).toBeVisible();
  await hold(page);
  // Its table: the client, the size and the installs.
  await card.getByRole('button', { name: 'Table: Common Window Sizes' }).click();
  const table = card.getByRole('table');
  await expect(table.locator('thead th')).toHaveText(['Client', 'Window Size', 'Installs']);
  await expect(table.locator('tbody tr').nth(1).locator('td')).toHaveText([
    'Mac',
    '1440 × 900',
    '6',
  ]);
  await card.scrollIntoViewIfNeeded();
  await page.waitForTimeout(2000);
  await expect(card).toBeInViewport();
});
