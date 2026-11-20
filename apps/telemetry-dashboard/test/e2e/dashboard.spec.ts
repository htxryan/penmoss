/**
 * The usage dashboard (PEN-137, AC30–AC33, AC14's dashboard part): behind Access, over the fixture
 * D1, every view draws its charts; each chart answers hover with a tooltip, opens its table and
 * downloads its CSV; the filters narrow it; Paths hides the rare path; it fits a phone. The proof
 * walk ends on the Overview; the Platforms test holds on Common Window Sizes (PEN-174).
 * Sessions (PEN-173) has its own proof walk, "Sessions: the list, a session's timeline, its
 * install's sessions and a copied link", which ends on a session page with a stretch heading
 * pinned; the tests after it cover its other states.
 */
import { expect, test as base, type Locator, type Page } from '@playwright/test';
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
  ['sessions', 'Sessions'],
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
    if (id === 'sessions') {
      // Sessions draws no chart: its cards are tables and lists.
      await expect(page.locator('main')).not.toHaveAttribute('aria-busy', 'true');
      await expect(page.locator('[data-card]').first()).toBeVisible();
    } else {
      await expect(page.locator('svg.chart').first()).toBeVisible();
    }
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    expect(overflow, name).toBeLessThanOrEqual(0);
  }
  // A session's page too (PEN-173).
  await page.goto(`${dashboard.url}/#sessions`);
  await page.locator('tbody a').first().click();
  await expect(page.getByRole('heading', { level: 1, name: /^Session on / })).toBeVisible();
  await expect(page.locator('main')).not.toHaveAttribute('aria-busy', 'true');
  await expect(page.locator('[data-card="timeline"]')).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(overflow, 'a session').toBeLessThanOrEqual(0);
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

// ---------------------------------------------------------------------------------------------
// Sessions (PEN-173).

/** The list's rows. */
const sessionRows = (page: Page) =>
  page.getByRole('region', { name: 'Recent Sessions' }).locator('tbody tr');

/** Waits for the view to be drawn. */
async function settled(page: Page): Promise<void> {
  await expect(page.locator('main')).not.toHaveAttribute('aria-busy', 'true');
}

/**
 * Waits for the session `href` names to be drawn. `settled` alone can pass before a navigation's
 * render marks `main` busy, so after a click or a hash change wait for what the new page shows.
 */
async function sessionShown(page: Page, href: string): Promise<void> {
  const session = new URLSearchParams(href.slice(href.indexOf('?') + 1)).get('session')!;
  await expect(page.locator('.ids')).toContainText(`Session ${session}`);
  await settled(page);
}

/** Opens the session `link` names and waits for it to be drawn. */
async function openSession(page: Page, link: Locator): Promise<void> {
  const href = (await link.getAttribute('href'))!;
  await link.click();
  await sessionShown(page, href);
}

/** The text a download handed the browser (recorded by keepBlobs). */
const lastBlob = (page: Page) =>
  page.evaluate(() => (window as unknown as { blobs: Blob[] }).blobs.at(-1)!.text());

interface SessionEvent {
  readonly at: number;
  readonly client: string;
  readonly kind: string;
  readonly name: string;
}

/**
 * The newest Mac session on the list's first page that goes Launch, Home, Command Palette, New
 * Note (its window and layout events aside), with its events spread out (not today's, whose times may all be now): its row's link.
 */
async function appSession(page: Page, dashboard: Dashboard) {
  const links = sessionRows(page).locator('td:first-child a');
  for (let i = 0; i < (await links.count()); i++) {
    const href = (await links.nth(i).getAttribute('href'))!;
    const params = new URLSearchParams(href.slice(href.indexOf('?') + 1));
    const answer = await page.request.get(
      `${dashboard.url}/api/session?install=${params.get('install')}&session=${params.get('session')}`,
      { headers: { 'cf-access-jwt-assertion': dashboard.token } },
    );
    const { events } = (await answer.json()) as { events: SessionEvent[] };
    // A launch is followed by its window's size and layout (PEN-174), before any screen.
    const names = events
      .filter((e) => e.kind !== 'app' || (e.name !== 'window' && e.name !== 'layout'))
      .slice(0, 4)
      .map((e) => `${e.kind}:${e.name}`);
    const spread = new Set(events.map((e) => e.at)).size === events.length;
    if (
      spread &&
      events[0]?.client === 'mac' &&
      names.join(' ') === 'app:launch screen:home command:app.palette command:note.new'
    ) {
      return links.nth(i);
    }
  }
  throw new Error('no Mac session on the first page goes Launch, Home, Palette, New Note');
}

/**
 * Scrolls so the stretch `title`'s heading is pinned at the top of the window: the window's top
 * goes 40px past the stretch's top, so its first row slides under the heading. The page must
 * reach that far; at 1280×720 the last stretch ends too near the page's foot to, so the desktop
 * checks pin a stretch with others after it.
 */
async function pinStretch(page: Page, title: string) {
  const section = page.locator('section.stretch', {
    has: page.locator('.stretch-title', { hasText: new RegExp(`^${title}`) }),
  });
  const reached = await section.evaluate((node) => {
    const top = node.getBoundingClientRect().top + window.scrollY + 40;
    window.scrollTo(0, top);
    return Math.abs(window.scrollY - top) < 2;
  });
  expect(reached, `the page scrolls 40px past the ${title} stretch's top`).toBe(true);
  const heading = section.locator('.stretch-head');
  await expect
    .poll(async () => Math.round((await heading.boundingBox())!.y), { timeout: 5000 })
    .toBe(0);
  return section;
}

test("Sessions: the list, a session's timeline, its install's sessions and a copied link", async ({
  signedIn: page,
  dashboard,
  context,
}) => {
  test.setTimeout(120_000);
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], {
    origin: dashboard.url,
  });
  await page.goto(`${dashboard.url}/#overview`);
  await settled(page);

  // AC1: the tab after Paths, the newest sessions first.
  const tabs = page.getByRole('navigation', { name: 'Views' }).getByRole('link');
  await expect(tabs).toHaveText([
    'Overview',
    'Commands & Shortcuts',
    'First Run',
    'Paths',
    'Sessions',
    'Platforms',
    'Agents',
    'Health',
  ]);
  await openView(page, 'Sessions');
  await expect(page).toHaveTitle('Sessions · Penmoss Usage');
  const list = page.getByRole('region', { name: 'Recent Sessions' });
  await expect(list.locator('thead th')).toHaveText([
    'Started',
    'Length',
    'Client',
    'Version',
    'OS',
    'Events',
    'First Screen',
    'Last Screen',
  ]);
  await expect(sessionRows(page)).toHaveCount(50);
  const firstRow = sessionRows(page).first();
  await expect(firstRow.locator('td').first()).toHaveText(/^\d{1,2} \w{3}, \d{2}:\d{2}$/);
  await expect(firstRow.locator('td').nth(6)).toContainText('Home');
  await expect(firstRow.locator('td').nth(6).locator('.cell-id')).toHaveText('screen:home');
  // Newest first: each start no later than the one above it (the API's own order is unit tested).
  const pager = list.getByLabel('Pages');
  await expect(pager.locator('.pager-range')).toHaveText(/^1–50 of [\d,]+$/);
  const total = Number(
    (await pager.locator('.pager-range').textContent())!.split(' of ')[1]!.replaceAll(',', ''),
  );
  expect(total).toBeGreaterThan(100);
  await expect(pager.getByRole('link', { name: 'Newer' })).toHaveAttribute('aria-disabled', 'true');
  await hold(page);

  // AC2: Older, then Newer, the page in the address.
  await pager.getByRole('link', { name: 'Older' }).click();
  await expect(pager.locator('.pager-range')).toHaveText(
    `51–100 of ${total.toLocaleString('en-GB')}`,
  );
  await expect(page).toHaveURL(/#sessions\?days=30&page=2$/);
  await page.reload();
  await expect(list.getByLabel('Pages').locator('.pager-range')).toHaveText(/^51–100 of /);
  await list.getByLabel('Pages').getByRole('link', { name: 'Newer' }).click();
  await expect(pager.locator('.pager-range')).toHaveText(/^1–50 of /);
  await expect(page).toHaveURL(/#sessions\?days=30$/);

  // The list's CSV: its own columns, the install cut to 8 characters.
  const download = page.waitForEvent('download');
  await list.getByRole('button', { name: 'Download CSV: Recent Sessions' }).click();
  expect((await download).suggestedFilename()).toBe('penmoss-sessions-30d.csv');
  const csv = (await lastBlob(page)).trim().split('\n');
  expect(csv[0]).toBe(
    'Started,Length,Client,Version,OS,Events,First Screen,First Screen ID,Last Screen,Last Screen ID,Install,Session',
  );
  expect(csv).toHaveLength(51);
  expect(csv[1]).toMatch(/^\d{4}-\d\d-\d\dT[\d:.]+Z,\d+,/);
  expect(csv[1]).toMatch(/,[0-9a-f]{8},[0-9a-f]{16}$/);

  // Nothing on the list names a whole install.
  expect(await page.locator('body').innerText()).not.toMatch(/[0-9a-f]{32}/);

  // AC3, AC4: a Mac session's timeline, in stretches by screen, with each event's props in words.
  const link = await appSession(page, dashboard);
  await link.scrollIntoViewIfNeeded();
  await link.click();
  const title = page.getByRole('heading', {
    level: 1,
    name: /^Session on \d{1,2} \w{3}, \d\d:\d\d UTC$/,
  });
  await expect(title).toBeVisible();
  await settled(page);
  const sessionTitle = (await title.textContent())!;
  await expect(page).toHaveTitle(`${sessionTitle} · Penmoss Usage`);
  await expect(page).toHaveURL(/#sessions\?days=30&install=[0-9a-f]{32}&session=[0-9a-f]{16}$/);
  await expect(page.getByRole('link', { name: '← All Sessions' })).toBeVisible();
  // AC11: the install by its first 8 characters only.
  await expect(page.locator('.ids')).toHaveText(
    /^Install [0-9a-f]{8}… · Session [0-9a-f]{16} · Expanded Window$/,
  );
  expect(await page.locator('body').innerText()).not.toMatch(/[0-9a-f]{32}/);
  await expect(page.locator('.tile dt')).toHaveText([
    'Length',
    'Events',
    'Client',
    'Actor',
    'Version',
    'Channel',
    'OS',
  ]);
  await expect(page.locator('.tile', { hasText: 'Client' }).locator('dd')).toHaveText('Mac');
  const timeline = page.getByRole('region', { name: 'Timeline' });
  const rows = timeline.locator('li.ev');
  await expect(rows.first().locator('.ev-kind')).toHaveText('App');
  await expect(rows.first().locator('.ev-name')).toContainText('Launch');
  await expect(rows.first().locator('.ev-since')).toHaveText('0:00');
  // The launch's window size and layout (PEN-174), in words.
  const opened = rows.filter({ has: page.locator('.cell-id', { hasText: /^app:window$/ }) });
  await expect(opened.first().locator('.prop-chip').first()).toHaveText('Window Main');
  await expect(opened.first().locator('.prop-chip', { hasText: 'Full Screen' })).toHaveText(
    'Full Screen No',
  );
  const layout = rows.filter({ has: page.locator('.cell-id', { hasText: /^app:layout$/ }) });
  await expect(layout.locator('.prop-chip', { hasText: 'Sidebar Width' })).toHaveText(
    'Sidebar Width 280',
  );
  const headings = timeline.locator('.stretch-title');
  await expect(headings.nth(0)).toHaveText('Before Any Screen');
  await expect(headings.nth(1)).toHaveText('Home screen:home');
  await expect(headings.nth(2)).toHaveText('Note screen:note');
  await expect(timeline.locator('.stretch-summary').nth(2)).toContainText('came from Home');
  // Every event in seq order: the rows' indexes run 0, 1, 2…
  const indexes = await rows.evaluateAll((nodes) =>
    nodes.map((node) => Number((node as HTMLElement).dataset['index'])),
  );
  expect(indexes).toEqual(indexes.map((_, i) => i));
  const palette = rows.filter({ has: page.locator('.cell-id', { hasText: /^app\.palette$/ }) });
  await expect(palette.locator('.ev-name')).toContainText('Command Palette');
  await expect(palette.locator('.ev-gap')).toHaveText(/^\+\d+s$/);
  await expect(palette.locator('.prop-chip')).toHaveText([
    'Source Key',
    'Keys Mod+K',
    'Own Shortcut No',
    'Ran Yes',
  ]);
  await hold(page);

  // AC18: a click makes an event the current one; Arrow Down moves to the next.
  await palette.click();
  await expect(palette).toHaveAttribute('aria-current', 'true');
  await expect(timeline.locator('li.ev[aria-current]')).toHaveCount(1);
  await page.keyboard.press('ArrowDown');
  const newNote = rows.nth(Number(await palette.getAttribute('data-index')) + 1);
  await expect(newNote).toHaveAttribute('aria-current', 'true');
  await expect(newNote.locator('.ev-name')).toContainText('New Note');
  await expect(palette).not.toHaveAttribute('aria-current');
  await expect(newNote).toBeFocused();
  await hold(page);

  // The timeline's CSV: one row per event.
  const timelineDownload = page.waitForEvent('download');
  await timeline.getByRole('button', { name: 'Download CSV: Timeline' }).click();
  expect((await timelineDownload).suggestedFilename()).toMatch(
    /^penmoss-session-[0-9a-f]{16}\.csv$/,
  );
  const timelineCsv = (await lastBlob(page)).trim().split('\n');
  expect(timelineCsv[0]).toBe('Seq,Since Start,Gap,Kind,Event,Event ID,Screen,Screen ID,Details');
  expect(timelineCsv.length - 1).toBe(await rows.count());

  // AC4: scrolled, the heading of the stretch being read stays pinned at the top.
  await pinStretch(page, 'Home');
  await hold(page);

  // AC5: the install's sessions, oldest first, the open one marked; an earlier one opens.
  const side = page.getByRole('region', { name: /^This Install's Sessions [\d,]+$/ });
  const open = side.locator('a[aria-current="page"]');
  await expect(open).toContainText('This Session');
  const starts = await side
    .locator('.ss-when')
    .evaluateAll((nodes) => nodes.map((node) => node.textContent ?? ''));
  expect(starts.length).toBeGreaterThan(3);
  const items = side.locator('a.ss-item');
  const at = await items.evaluateAll((nodes) =>
    nodes.findIndex((node) => node.getAttribute('aria-current') === 'page'),
  );
  expect(at).toBeGreaterThan(0);
  const earlier = items.nth(at - 1);
  await page.evaluate(() => window.scrollTo(0, 200));
  await earlier.scrollIntoViewIfNeeded();
  const scrolled = await page.evaluate(() => window.scrollY);
  expect(scrolled).toBeGreaterThan(100);
  const shownHref = page.url().slice(page.url().indexOf('#'));
  await openSession(page, earlier);
  // A session opens at the top; Previous Session and Next Session are its neighbours.
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
  await expect(page.getByRole('link', { name: 'Next Session' })).toHaveAttribute(
    'href',
    /session=/,
  );
  await hold(page);

  // AC15: Back shows the session before, where it was scrolled.
  await page.goBack();
  await sessionShown(page, shownHref);
  await expect(page.getByRole('heading', { level: 1, name: sessionTitle })).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(scrolled);

  // AC6: Copy Link says so, and the copied address opens straight to the session.
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.getByRole('button', { name: 'Copy Link' }).click();
  await expect(page.locator('.copied')).toHaveText('Link Copied');
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toBe(page.url());
  await hold(page);
  const other = await context.newPage();
  await other.setExtraHTTPHeaders({ 'cf-access-jwt-assertion': dashboard.token });
  await other.goto(copied);
  await expect(other.getByRole('heading', { level: 1, name: sessionTitle })).toBeVisible();
  await other.close();
  await expect(page.locator('.copied')).toBeEmpty({ timeout: 5000 });

  // The proof ends on the session, the Home stretch's heading pinned over its events.
  await page.bringToFront();
  await pinStretch(page, 'Home');
  await page.waitForTimeout(2000);
});

/** The fixture's install with 520 sessions, all older than 30 days (fixture.ts BIG_INSTALL). */
const BIG_INSTALL = 'b5'.repeat(16);
const bigSession = (index: number) => index.toString(16).padStart(16, '0');

test('Sessions: an install’s first and last sessions, and its side list held to 500', async ({
  signedIn: page,
  dashboard,
}) => {
  // AC5: the install's first session, a CLI run: Previous Session disabled, the cut line.
  await page.goto(
    `${dashboard.url}/#sessions?days=30&install=${BIG_INSTALL}&session=${bigSession(0)}`,
  );
  await settled(page);
  await expect(page.getByRole('heading', { level: 1, name: /^Session on / })).toBeVisible();
  const side = page.getByRole('region', { name: "This Install's Sessions 520" });
  await expect(side.locator('.cut')).toHaveText(
    'Showing 500 of 520: this session and the 499 after it.',
  );
  await expect(side.locator('a.ss-item')).toHaveCount(500);
  await expect(side.locator('a.ss-item').first()).toHaveAttribute('aria-current', 'page');
  const previous = page.getByRole('link', { name: 'Previous Session' });
  await expect(previous).toHaveAttribute('aria-disabled', 'true');
  await expect(previous).not.toHaveAttribute('href');
  await expect(page.locator('.stretch-title')).toHaveText(['CLI Run']);
  await expect(page.locator('.stretch-summary')).toHaveText('from 0:00 · 1–2s here');
  await expect(page.locator('.tile', { hasText: 'Length' }).locator('dd')).toHaveText('1–2s');
  await expect(page.locator('.tile', { hasText: 'Client' }).locator('dd')).toHaveText('CLI');
  await expect(page.locator('.ids')).toHaveText(`Install b5b5b5b5… · Session ${bigSession(0)}`);
  await expect(page.locator('li.ev .prop-chip')).toHaveText([
    'Flags --json',
    'Exit OK',
    'Took 1–2s',
    'Terminal Yes',
  ]);
  // The list scrolls inside its card, not the window.
  const list = side.locator('ol.ss');
  expect(await list.evaluate((node) => node.scrollHeight > node.clientHeight)).toBe(true);
  await hold(page);

  // In the middle: 250 before it and 249 after, the open one in the middle of the box.
  await page.goto(
    `${dashboard.url}/#sessions?days=30&install=${BIG_INSTALL}&session=${bigSession(260)}`,
  );
  await settled(page);
  await expect(side.locator('.cut')).toHaveText(
    'Showing 500 of 520: this session, the 250 before it and the 249 after it.',
  );
  const open = side.locator('a[aria-current="page"]');
  await expect(open).toContainText('This Session');
  const [box, entry] = await Promise.all([list.boundingBox(), open.boundingBox()]);
  const middle = box!.y + box!.height / 2;
  expect(Math.abs(entry!.y + entry!.height / 2 - middle)).toBeLessThan(entry!.height);

  // Its last session, an agent's MCP connection: Next Session disabled.
  await openSession(page, page.getByRole('link', { name: 'Next Session' }));
  await expect(page).toHaveURL(new RegExp(`session=${bigSession(261)}$`));
  await page.goto(
    `${dashboard.url}/#sessions?days=30&install=${BIG_INSTALL}&session=${bigSession(519)}`,
  );
  await settled(page);
  await expect(side.locator('.cut')).toHaveText(
    'Showing 500 of 520: this session and the 499 before it.',
  );
  await expect(side.locator('a.ss-item').last()).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('link', { name: 'Next Session' })).toHaveAttribute(
    'aria-disabled',
    'true',
  );
  await expect(page.locator('.stretch-title')).toHaveText(['MCP Connection']);
  await expect(page.locator('.tile', { hasText: 'Actor' }).locator('dd')).toHaveText('Agent');
  await expect(page.locator('li.ev').nth(1).locator('.prop-chip')).toHaveText([
    'Agent Claude Code',
    'Result OK',
    'Took <1s',
  ]);
  await hold(page);

  // A fixture install's first session was its first run, which reported no screens.
  await page.goto(`${dashboard.url}/#sessions`);
  await expect(page.getByRole('heading', { level: 1, name: 'Sessions' })).toBeVisible();
  await settled(page);
  await openSession(page, sessionRows(page).first().locator('a'));
  const own = page.getByRole('region', { name: /^This Install's Sessions [\d,]+$/ });
  await openSession(page, own.locator('a.ss-item').first());
  await expect(own.locator('.cut')).toHaveCount(0);
  await expect(page.locator('.stretch-title')).toHaveText(['First Run']);
  await hold(page);
});

test('Sessions: an address that names no session, and a session past 90 days', async ({
  signedIn: page,
  dashboard,
}) => {
  // AC16: the wrong shape, or one id alone: no request, Not a Session Link.
  const asked: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/api/session?')) asked.push(request.url());
  });
  for (const query of [
    'install=nothex&session=0000000000000000',
    `install=${'a0'.repeat(16)}`,
    'session=0000000000000000',
  ]) {
    await page.goto(`${dashboard.url}/#sessions?days=30&${query}`);
    await expect(page.getByRole('heading', { level: 1, name: 'Not a Session Link' })).toBeVisible();
    await expect(page.getByText("This address doesn't name a session.")).toBeVisible();
    await expect(page).toHaveTitle('Not a Session Link · Penmoss Usage');
  }
  await expect(page.getByRole('link', { name: 'All Sessions', exact: true })).toBeVisible();
  await expect(page.getByTestId('freshness')).toHaveCount(0);
  expect(asked).toEqual([]);
  const bad = await page.request.get(
    `${dashboard.url}/api/session?install=nothex&session=0000000000000000`,
    { headers: { 'cf-access-jwt-assertion': dashboard.token } },
  );
  expect(bad.status()).toBe(400);
  await hold(page);

  // AC7: a session with nothing in the last 90 days.
  await page.goto(
    `${dashboard.url}/#sessions?days=30&install=${'a0'.repeat(16)}&session=0123456789abcdef`,
  );
  await expect(page.getByRole('heading', { level: 1, name: 'Session Not Found' })).toBeVisible();
  await expect(page.getByText(/^Nothing from this session in the last 90 days\./)).toBeVisible();
  await expect(page.locator('.range')).toBeVisible();
  await expect(page.getByTestId('freshness')).toBeVisible();
  await expect(page.getByRole('link', { name: '← All Sessions' })).toBeVisible();
  await expect(page).toHaveTitle('Session Not Found · Penmoss Usage');
  await hold(page);
  await page.getByRole('link', { name: 'All Sessions', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Sessions' })).toBeVisible();
});

test('Sessions: nothing matches over 365 days, which reads the last 90', async ({
  signedIn: page,
  dashboard,
}) => {
  // AC14.
  await page.goto(`${dashboard.url}/#sessions?days=365&client=android&actor=script`);
  await settled(page);
  await expect(page.getByLabel('Period', { exact: true })).toHaveValue('365');
  const list = page.getByRole('region', { name: 'Recent Sessions' });
  await expect(list.getByText('Nothing in this period.')).toBeVisible();
  await expect(list.locator('thead th').first()).toHaveText('Started');
  await expect(list.getByLabel('Pages')).toHaveCount(0);
  await expect(list.locator('.note')).toContainText('over the last 90 days');
  const range = (await page.locator('.range').textContent())!;
  const [from, to] = range.replace(' (UTC)', '').split(' to ');
  const year = new Date().getUTCFullYear();
  const days = (Date.parse(`${to} ${year}`) - Date.parse(`${from} ${year}`)) / 86_400_000;
  expect([89, 89 - 365, 89 - 366]).toContain(Math.round(days));
  await hold(page);
});

test('Sessions: Copy Link refused shows the address to copy by hand', async ({
  signedIn: page,
  dashboard,
}) => {
  // AC6: the browser refuses the clipboard.
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: () => Promise.reject(new Error('refused')) },
    });
  });
  await page.goto(`${dashboard.url}/#sessions`);
  await settled(page);
  await openSession(page, sessionRows(page).nth(5).locator('a'));
  await page.getByRole('button', { name: 'Copy Link' }).click();
  const field = page.getByLabel('Session Link');
  await expect(field).toHaveValue(page.url());
  await expect(field).toBeFocused();
  await expect(page.getByText('Select the link and copy it.')).toBeVisible();
  // Selected, ready to copy.
  expect(
    await field.evaluate(
      (input: HTMLInputElement) =>
        input.selectionEnd! - input.selectionStart! === input.value.length,
    ),
  ).toBe(true);
  await hold(page);
});

test('Sessions: Back puts back the page, the filters and the session; a filter goes to page 1', async ({
  signedIn: page,
  dashboard,
}) => {
  // AC15.
  await page.goto(`${dashboard.url}/#sessions`);
  await settled(page);
  await page.getByLabel('Client', { exact: true }).selectOption('mac');
  await expect(page).toHaveURL(/#sessions\?days=30&client=mac$/);
  // The Mac list is drawn: its Older link carries the filter.
  const pager = page.getByRole('region', { name: 'Recent Sessions' }).getByLabel('Pages');
  const older = pager.getByRole('link', { name: 'Older' });
  await expect(older).toHaveAttribute('href', /client=mac&page=2$/);
  await settled(page);
  await older.click();
  await expect(page).toHaveURL(/#sessions\?days=30&client=mac&page=2$/);
  // Page 2 is drawn before a row of it is opened.
  await expect(pager.locator('.pager-range')).toHaveText(/^51–100 of /);
  await settled(page);
  const row = sessionRows(page).first().locator('a');
  await expect(row).toHaveAttribute('href', /client=mac&page=2&install=/);
  await openSession(page, row);
  await expect(page.getByRole('heading', { level: 1, name: /^Session on / })).toBeVisible();
  await expect(page).toHaveURL(/client=mac&page=2&install=/);
  // A tab keeps the filters but not the session.
  await expect(
    page.getByRole('navigation', { name: 'Views' }).getByRole('link', { name: 'Overview' }),
  ).toHaveAttribute('href', '#overview?days=30&client=mac');
  // Back: page 2 of the Mac list, its select showing Mac.
  await page.goBack();
  await expect(page.getByRole('heading', { level: 1, name: 'Sessions' })).toBeVisible();
  await expect(pager.locator('.pager-range')).toHaveText(/^51–100 of /);
  await expect(page.getByLabel('Client', { exact: true })).toHaveValue('mac');
  // Back again: page 1, the filter as it was then.
  await page.goBack();
  await expect(pager.locator('.pager-range')).toHaveText(/^1–50 of /);
  await expect(page.getByLabel('Client', { exact: true })).toHaveValue('mac');
  // Forward to the session, then a filter: the list's first page, which replaces the session.
  await page.goForward();
  await page.goForward();
  await expect(page.getByRole('heading', { level: 1, name: /^Session on / })).toBeVisible();
  await page.getByLabel('Client', { exact: true }).selectOption('android');
  await expect(page.getByRole('heading', { level: 1, name: 'Sessions' })).toBeVisible();
  await expect(page).toHaveURL(/#sessions\?days=30&client=android$/);
  await page.goBack();
  await expect(pager.locator('.pager-range')).toHaveText(/^51–100 of /);
  await expect(page.getByLabel('Client', { exact: true })).toHaveValue('mac');
});

test('Sessions on a phone: the list scrolls in its box, a session stacks, a heading stays pinned', async ({
  signedIn: page,
  dashboard,
}) => {
  // AC12, AC13, AC17.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${dashboard.url}/#sessions`);
  await settled(page);
  const tab = page
    .getByRole('navigation', { name: 'Views' })
    .getByRole('link', { name: 'Sessions' });
  await expect(tab).toBeInViewport({ ratio: 1 });
  const holder = page.getByRole('region', { name: 'Recent Sessions' }).locator('.table-holder');
  expect(await holder.evaluate((node) => node.scrollWidth > node.clientWidth)).toBe(true);
  const overflow = () =>
    page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(await overflow()).toBeLessThanOrEqual(0);
  await hold(page);
  const link = await appSession(page, dashboard);
  await openSession(page, link);
  expect(await overflow()).toBeLessThanOrEqual(0);
  // Tiles two to a row.
  const tiles = page.locator('.tile');
  const [a, b, c] = await Promise.all(
    [0, 1, 2].map(async (i) => (await tiles.nth(i).boundingBox())!),
  );
  expect(Math.round(a!.y)).toBe(Math.round(b!.y));
  expect(c!.y).toBeGreaterThan(a!.y);
  // Each event stacks: its name under its times, its chips under its name.
  const row = page.locator('li.ev').nth(2);
  const [since, name, chips] = await Promise.all(
    ['.ev-since', '.ev-name', '.prop-chips'].map(
      async (part) => (await row.locator(part).boundingBox())!,
    ),
  );
  expect(name!.y).toBeGreaterThan(since!.y);
  expect(chips!.y).toBeGreaterThan(name!.y);
  // This Install's Sessions follows the timeline.
  const timeline = (await page.getByRole('region', { name: 'Timeline' }).boundingBox())!;
  const side = (await page
    .getByRole('region', { name: /^This Install's Sessions/ })
    .boundingBox())!;
  expect(side.y).toBeGreaterThan(timeline.y + timeline.height - 1);
  await pinStretch(page, 'Note');
  await hold(page);
});
