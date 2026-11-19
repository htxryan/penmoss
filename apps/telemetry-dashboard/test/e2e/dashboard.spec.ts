/**
 * The usage dashboard (PEN-137, AC30–AC33, AC14's dashboard part): behind Access, over the fixture
 * D1, every view draws its charts; each chart answers hover with a tooltip, opens its table and
 * downloads its CSV; the filters narrow it; Paths hides the rare path; it fits a phone. The proof
 * walk ends on the Overview.
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
  expect(csv[0]).toBe(header.map((cell) => (/[",]/.test(cell) ? `"${cell}"` : cell)).join(','));
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
  const today = page.locator('.tile', { hasText: 'Active Today' }).locator('dd');
  await expect(today).toHaveText('10');
  await page.getByLabel('Client', { exact: true }).selectOption('android');
  await expect(today).toHaveText('2');
  await page.getByLabel('Channel', { exact: true }).selectOption('alpha');
  await expect(today).toHaveText('1');
  await page.getByLabel('Client', { exact: true }).selectOption('');
  await page.getByLabel('Channel', { exact: true }).selectOption('');
  await expect(page.getByLabel('Version', { exact: true }).locator('option')).toHaveCount(5);
  await page.getByLabel('Version', { exact: true }).selectOption('1.3.2');
  await expect(page.getByRole('region', { name: 'Top Versions' }).locator('tbody tr')).toHaveCount(
    1,
  );
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
  await expect(
    page.locator('.tile', { hasText: 'Active in the Last 7 Days' }).locator('dd'),
  ).toHaveText('10');
  for (const title of ['Weekly Active Installs by Client', 'Events by Actor', 'Top Versions']) {
    await checkCard(page, title);
  }
  await expect(
    page.getByRole('list', { name: 'Weekly Active Installs by Client Legend' }),
  ).toContainText('Android');

  // Commands & Shortcuts (AC31).
  await openView(page, 'Commands & Shortcuts');
  for (const title of ['Top 25 Commands', 'Shortcuts']) await checkCard(page, title);
  await expect(page.getByRole('list', { name: 'Top 25 Commands Legend' })).toContainText('Palette');
  const neverUsed = page.getByRole('region', { name: 'Never Used' });
  await expect(neverUsed.getByRole('table')).toContainText('app.graph');

  // First Run and Paths (AC32): the funnel narrows; a path under 5 sessions never shows.
  await openView(page, 'First Run');
  for (const title of ['First Run Funnel', 'Where Installs Gave Up']) await checkCard(page, title);
  await expect(page.getByRole('region', { name: 'First Run Funnel' }).locator('svg')).toContainText(
    'welcome',
  );
  await openView(page, 'Paths');
  await expect(page.getByLabel('Start Event')).toHaveValue('command:app.palette');
  await checkCard(page, 'What Comes After app.palette');
  const paths = page.getByRole('region', { name: 'What Comes After app.palette' });
  await expect(paths.locator('svg')).toContainText('note.new');
  await expect(paths).not.toContainText('app.trash');
  await page.getByLabel('Start Event').fill('command:note.new');
  await page.getByLabel('Start Event').press('Enter');
  await page.getByLabel('Start Event').blur();
  await expect(page.getByRole('region', { name: 'What Comes After note.new' })).toBeVisible();

  // Platforms and Agents (AC33).
  await openView(page, 'Platforms');
  for (const title of ['Clients and OS Versions', 'Version Adoption', 'Window Size Classes']) {
    await checkCard(page, title);
  }
  await openView(page, 'Agents');
  for (const title of ['Events by Actor', 'CLI Commands and MCP Tools by Agent', 'Success Rate']) {
    await checkCard(page, title);
  }
  await expect(
    page.getByRole('list', { name: 'CLI Commands and MCP Tools by Agent Legend' }),
  ).toContainText('claude-code');

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
