import { expect, test, type Locator, type Page } from './fixtures';

// PEN-140 (web): each notebook's badge, a colour and a letter, number or icon. With nothing
// chosen it is a preset picked from the notebook's id and the first letter of its name, so
// Personal and Penmoss are both P (duplicates are fine). A notebook's page in Settings has its
// Badge rows on Overview; a change shows at once on its sidebar row, and stays after a reload.

const RUN = `${Date.now().toString(36)}${100 + Math.floor(Math.random() * 900)}`;

/** The ten presets' colours (packages/ui/src/theme/builtins.ts, NOTEBOOK_BADGE_COLOURS). */
const PRESETS: Readonly<Record<string, string>> = {
  moss: '#3c7a4b',
  teal: '#1f7a7a',
  blue: '#2f5d8a',
  indigo: '#4a4fa3',
  violet: '#7448a0',
  rose: '#a8436b',
  red: '#b23a3a',
  orange: '#a8541a',
  ochre: '#8a6d12',
  slate: '#4f5966',
};

test.use({
  seed: { name: 'Personal', notes: [{ title: `Groceries ${RUN}`, markdown: 'Oats.' }] },
});

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(error.message));
  return errors;
}

/** A notebook's section of the sidebar. */
export const sidebarSection = (page: Page, name: string): Locator =>
  page.getByTestId('source-section').and(page.getByRole('region', { name, exact: true }));

/** The badge at the start of a notebook's row in the sidebar. */
export const sidebarBadge = (page: Page, name: string): Locator =>
  sidebarSection(page, name).locator('.sb-section-head').getByTestId('notebook-badge');

/** Opens a notebook's page in Settings, from its row in All Notebooks. */
export async function openNotebookSettings(page: Page, name: string): Promise<void> {
  await page.getByTestId('sidebar-settings').click();
  await page
    .getByRole('navigation', { name: 'Settings sections' })
    .getByRole('link', { name: 'All Notebooks', exact: true })
    .click();
  // By the row's name alone: a repository's path may hold the name too.
  await page
    .getByTestId('git-notebook-row')
    .filter({
      has: page.locator('.git-notebook-row-name', { hasText: new RegExp(`^${name}(Primary)?$`) }),
    })
    .click();
  await expect(page.getByTestId('git-notebook')).toBeVisible();
}

test('notebooks get default badges, and one is changed in Settings (PEN-140, AC17, AC18)', async ({
  page,
  host,
}) => {
  test.setTimeout(120_000);
  const errors = collectErrors(page);
  await host.seed({ name: 'Penmoss', notes: [{ title: `Roadmap ${RUN}`, markdown: 'Tabs.' }] });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');

  // Both start with the first letter of their name, in one of the presets: P and P.
  for (const name of ['Personal', 'Penmoss']) {
    const badge = sidebarBadge(page, name);
    await expect(badge).toBeVisible();
    await expect(badge).toHaveAttribute('data-glyph', 'letter:P');
    await expect(badge.locator('.nb-badge-text')).toHaveAttribute('data-text', 'P');
    expect(Object.values(PRESETS)).toContain(await badge.getAttribute('data-color'));
    // Before the name, on the same row, the sync dot still at its end.
    const head = sidebarSection(page, name).locator('.sb-section-head');
    const badgeBox = (await badge.boundingBox())!;
    const nameBox = (await head.locator('.sb-section-name').boundingBox())!;
    const dotBox = (await head.getByTestId('section-sync').boundingBox())!;
    expect(badgeBox.x + badgeBox.width).toBeLessThanOrEqual(nameBox.x + 1);
    expect(dotBox.x).toBeGreaterThan(nameBox.x);
    // Centred on the name's line.
    expect(
      Math.abs(badgeBox.y + badgeBox.height / 2 - (nameBox.y + nameBox.height / 2)),
    ).toBeLessThan(3);
  }
  const before = await sidebarBadge(page, 'Penmoss').getAttribute('data-color');
  // A colour it does not have yet.
  const [preset, hex] = Object.entries(PRESETS).find(([, colour]) => colour !== before)!;

  await openNotebookSettings(page, 'Penmoss');
  // Its badge in the list's row and the page's heading too.
  await expect(
    page.getByTestId('git-notebook').locator('h1').getByTestId('notebook-badge'),
  ).toBeVisible();
  const group = page.getByTestId('git-panel-overview');
  await group.getByTestId('badge-row').scrollIntoViewIfNeeded();
  // Its rows in the Overview's first group, right after the notebook's name (PEN-146's page).
  const rows = group.locator('.lf-group').first().locator('> .lf-row');
  await expect(rows.nth(0)).toHaveAttribute('data-setting', 'notebook-name');
  await expect(rows.nth(1)).toHaveAttribute('data-setting', 'badge');
  await expect(group.getByTestId('badge-row').locator('.lf-row-label')).toHaveText('Badge');
  await expect(group.getByTestId('badge-row')).toBeVisible();
  // Ten presets and Custom…, Letter / Number / Icon, Reset to Default (greyed out: nothing set).
  await expect(group.getByRole('radiogroup', { name: 'Colour' }).getByRole('radio')).toHaveCount(
    10,
  );
  await expect(group.getByRole('button', { name: /^Custom Colour: Custom…$/ })).toBeVisible();
  await expect(group.getByTestId('badge-kind-letter')).toBeChecked();
  await expect(group.getByTestId('badge-letter')).toHaveValue('P');
  await expect(group.getByTestId('badge-reset')).toBeDisabled();

  await group.getByTestId(`badge-preset-${preset}`).click();
  await expect(group.getByTestId(`badge-preset-${preset}`)).toHaveAttribute('aria-checked', 'true');
  await group.getByTestId('badge-kind-icon').check();
  // Shows is one segmented control, the chosen kind filled with the app's accent (ac17).
  const segment = (kind: string) =>
    group.locator(`label:has([data-testid="badge-kind-${kind}"]) > span`);
  const accent = await page.evaluate(() => {
    const probe = document.createElement('span');
    probe.style.background = 'var(--pm-accent)';
    document.body.append(probe);
    const colour = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return colour;
  });
  await expect(segment('icon')).toHaveCSS('background-color', accent);
  await expect(segment('letter')).not.toHaveCSS('background-color', accent);
  const [letterBox, numberBox] = [
    (await segment('letter').boundingBox())!,
    (await segment('number').boundingBox())!,
  ];
  // Side by side, touching: one control, not three loose radios.
  expect(Math.abs(letterBox.x + letterBox.width - 1 - numberBox.x)).toBeLessThanOrEqual(1);
  await expect(group.getByTestId('badge-icons').getByRole('radio')).toHaveCount(24);
  await group.getByTestId('badge-icon-star').click();
  const preview = group.getByTestId('badge-preview').getByTestId('notebook-badge').first();
  await expect(preview).toHaveAttribute('data-glyph', 'icon:star');
  await expect(preview).toHaveAttribute('data-color', hex);
  await expect(preview).toHaveAccessibleName('Penmoss');
  await expect(group.getByTestId('badge-reset')).toBeEnabled();

  // Back to the notes: the sidebar's row has changed at once, the other notebook's has not.
  await page.locator('.settings-bar .back-link').click();
  const penmoss = sidebarBadge(page, 'Penmoss');
  await expect(penmoss).toHaveAttribute('data-glyph', 'icon:star');
  await expect(penmoss).toHaveAttribute('data-color', hex);
  await expect(penmoss.locator('svg[data-icon="star"]')).toBeVisible();
  await expect(sidebarBadge(page, 'Personal')).toHaveAttribute('data-glyph', 'letter:P');

  // Kept in the notebook's own settings: a reload shows it the same.
  await page.reload();
  await expect(sidebarBadge(page, 'Penmoss')).toHaveAttribute('data-glyph', 'icon:star');
  await expect(sidebarBadge(page, 'Penmoss')).toHaveAttribute('data-color', hex);
  await expect(sidebarBadge(page, 'Personal')).toHaveAttribute('data-glyph', 'letter:P');

  // A number this time, then the page on screen for the proof.
  await openNotebookSettings(page, 'Personal');
  const personal = page.getByTestId('git-panel-overview');
  await personal.getByTestId('badge-kind-number').check();
  await personal.getByTestId('badge-number').fill('42');
  await expect(
    personal.getByTestId('badge-preview').getByTestId('notebook-badge').first(),
  ).toHaveAttribute('data-glyph', 'number:42');
  await personal.getByTestId('badge-row').scrollIntoViewIfNeeded();
  await page.waitForTimeout(2_000);
  await page.locator('.settings-bar .back-link').click();
  await expect(sidebarBadge(page, 'Personal')).toHaveAttribute('data-glyph', 'number:42');
  await expect(sidebarBadge(page, 'Penmoss')).toHaveAttribute('data-glyph', 'icon:star');
  await page.waitForTimeout(2_000);
  await expect(sidebarBadge(page, 'Personal')).toBeVisible();
  expect(errors).toEqual([]);
});

test('each note’s tab starts with its notebook’s badge, and the note has no title row (AC8, AC19, AC20)', async ({
  page,
  host,
}) => {
  test.setTimeout(150_000);
  const errors = collectErrors(page);
  const meeting = `Meeting Notes ${RUN}`;
  await host.seed({ name: 'Penmoss', notes: [{ title: meeting, markdown: 'From Penmoss.' }] });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');
  // Personal's "Groceries", then Penmoss's "Meeting Notes" in a tab behind it.
  const personalRow = sidebarSection(page, 'Personal').getByRole('link', {
    name: `Groceries ${RUN}`,
    exact: true,
  });
  await expect(personalRow).toBeVisible({ timeout: 40_000 });
  await personalRow.click();
  await expect(page.getByTestId('note-view')).toHaveAttribute('data-ready', 'true');
  const penmossRow = sidebarSection(page, 'Penmoss').getByRole('link', {
    name: meeting,
    exact: true,
  });
  await expect(penmossRow).toBeVisible({ timeout: 40_000 });
  await penmossRow.click({ button: 'middle' });
  const strip = page.getByRole('tablist', { name: 'Open Tabs' });
  await expect(strip.getByRole('tab')).toHaveCount(2);

  // Each tab starts with its notebook's badge, named for a screen reader (AC19).
  const groceriesTab = strip.getByRole('tab', { name: new RegExp(`^Groceries ${RUN}`) });
  const meetingTab = strip.getByRole('tab', { name: new RegExp(`^${meeting}`) });
  const groceriesBadge = groceriesTab.getByTestId('notebook-badge');
  await expect(groceriesBadge).toHaveAttribute('data-glyph', 'letter:P');
  await expect(groceriesBadge).toHaveAttribute(
    'data-color',
    (await sidebarBadge(page, 'Personal').getAttribute('data-color'))!,
  );
  // The badge is named for its notebook; the tab says it with its title.
  await expect(meetingTab.getByTestId('notebook-badge')).toHaveAttribute('aria-label', 'Penmoss');
  await expect(meetingTab).toHaveAccessibleName(`${meeting}, Penmoss`);
  const badgeBox = (await groceriesBadge.boundingBox())!;
  const titleBox = (await groceriesTab.locator('.tab-title').boundingBox())!;
  expect(badgeBox.x + badgeBox.width).toBeLessThanOrEqual(titleBox.x);

  // No title row above the text (AC20): the note's buttons are at the strip's end, its place at
  // the start of the status bar, before its save status.
  await expect(page.locator('.note-main .note-top')).toHaveCount(0);
  await expect(page.locator('.tab-strip-end').getByTestId('note-menu')).toBeVisible();
  const stripBox = (await page.getByTestId('tab-strip').boundingBox())!;
  const scrollBox = (await page.getByTestId('note-scroll').boundingBox())!;
  expect(scrollBox.y).toBeCloseTo(stripBox.y + stripBox.height, 0);
  const place = page.getByTestId('status-place');
  await expect(place.getByTestId('note-source-crumb')).toHaveText('Personal');
  await expect(page.locator('[data-testid="status-bar"] > :not(.sr-only)').first()).toHaveAttribute(
    'data-testid',
    'status-place',
  );
  const placeBox = (await place.boundingBox())!;
  const saveBox = (await page.getByTestId('save-status').boundingBox())!;
  expect(placeBox.x + placeBox.width).toBeLessThanOrEqual(saveBox.x);
  // A click reveals the note in the sidebar.
  await place.click();
  await expect(sidebarSection(page, 'Personal').locator(':focus')).toContainText(
    `Groceries ${RUN}`,
  );
  // The tab's tooltip: its title, notebook and ⌘ number (AC8).
  await page.mouse.move(640, 500);
  await expect(async () => {
    await meetingTab.hover();
    await expect(page.getByTestId('tooltip')).toHaveText(
      new RegExp(`^${meeting} · Penmoss \\((⌘|Ctrl\\+)2\\)$`),
      { timeout: 3_000 },
    );
  }).toPass();
  await page.mouse.move(640, 500);

  // Two tabs with the same title: once their badges look alike, each names its notebook.
  // Groceries becomes a second "Meeting Notes", in Personal.
  await groceriesTab.click();
  await page.getByTestId('note-title').fill(meeting);
  await expect(strip.getByRole('tab', { name: new RegExp(`^${meeting}`) })).toHaveCount(2);
  const personalColour = (await sidebarBadge(page, 'Personal').getAttribute('data-color'))!;
  const penmossColour = (await sidebarBadge(page, 'Penmoss').getAttribute('data-color'))!;
  await expect(strip.getByTestId('tab-notebook')).toHaveCount(
    personalColour === penmossColour ? 2 : 0,
  );
  // Penmoss in Personal's colour: both badges read P in one colour, so both tabs say whose.
  await openNotebookSettings(page, 'Penmoss');
  const group = page.getByTestId('git-panel-overview');
  const [preset] = Object.entries(PRESETS).find(([, colour]) => colour === personalColour)!;
  await group.getByTestId(`badge-preset-${preset}`).click();
  await page.locator('.settings-bar .back-link').click();
  const suffixes = strip.getByTestId('tab-notebook');
  await expect(suffixes).toHaveCount(2);
  await expect(suffixes.nth(0)).toHaveText(/· Personal$/);
  await expect(suffixes.nth(1)).toHaveText(/· Penmoss$/);
  // The title gives way, so each notebook's name reads in full on the strip (AC8).
  for (const index of [0, 1]) {
    const suffix = suffixes.nth(index);
    await expect(suffix).toBeVisible();
    expect(await suffix.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
      true,
    );
    const tabBox = (await suffix.locator('xpath=..').boundingBox())!;
    const suffixBox = (await suffix.boundingBox())!;
    expect(suffixBox.x + suffixBox.width).toBeLessThanOrEqual(tabBox.x + tabBox.width);
  }
  await page.mouse.move(640, 500);
  await page.waitForTimeout(2_000);
  // A badge changed in Settings changes on its tabs at once (AC17).
  await openNotebookSettings(page, 'Penmoss');
  await page.getByTestId('git-panel-overview').getByTestId('badge-kind-icon').check();
  await page.getByTestId('git-panel-overview').getByTestId('badge-icon-star').click();
  await page.locator('.settings-bar .back-link').click();
  const penmossTab = strip.getByRole('tab', { name: new RegExp(`^${meeting}, Penmoss`) });
  await expect(penmossTab.getByTestId('notebook-badge')).toHaveAttribute('data-glyph', 'icon:star');
  await expect(strip.getByTestId('tab-notebook')).toHaveCount(0);
  await page.mouse.move(640, 500);
  await page.waitForTimeout(2_000);
  await expect(penmossTab).toBeVisible();
  expect(errors).toEqual([]);
});

test('a tab’s tooltip names its notebook and folders, and a notebook removed in Settings closes its tabs (AC8, AC9)', async ({
  page,
  host,
}) => {
  test.setTimeout(150_000);
  const errors = collectErrors(page);
  const meeting = `Meeting Notes ${RUN}`;
  const roadmap = `Roadmap ${RUN}`;
  await host.seed({
    name: 'Quanta',
    folders: ['Clients'],
    notes: [
      { title: meeting, markdown: 'With the clients.', folder: 'Clients' },
      { title: roadmap, markdown: 'What comes next.' },
    ],
  });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');
  const strip = page.getByRole('tablist', { name: 'Open Tabs' });
  const personalRow = sidebarSection(page, 'Personal').getByRole('link', {
    name: `Groceries ${RUN}`,
    exact: true,
  });
  await expect(personalRow).toBeVisible({ timeout: 40_000 });
  await personalRow.click();
  await expect(page.getByTestId('note-view')).toHaveAttribute('data-ready', 'true');
  // Quanta's Clients folder open, its Meeting Notes in a tab behind, then Roadmap.
  const quanta = sidebarSection(page, 'Quanta');
  const clients = quanta.getByRole('treeitem', { name: 'Clients', exact: true });
  await expect(clients).toBeVisible({ timeout: 40_000 });
  if ((await clients.getAttribute('aria-expanded')) === 'false') {
    await clients.locator('.twisty').click();
  }
  await quanta.getByRole('link', { name: meeting, exact: true }).click({ button: 'middle' });
  await quanta.getByRole('link', { name: roadmap, exact: true }).click({ button: 'middle' });
  await expect(strip.getByRole('tab')).toHaveCount(3);

  // The tooltip of the tab of a note in a folder: title · notebook › folder (⌘ number) (AC8).
  const meetingTab = strip.getByRole('tab', { name: new RegExp(`^${meeting}`) });
  const tooltip = page.getByTestId('tooltip');
  await page.mouse.move(640, 500);
  await expect(async () => {
    await meetingTab.hover();
    await expect(tooltip).toHaveText(
      new RegExp(`^${meeting} · Quanta › Clients \\((⌘|Ctrl\\+)2\\)$`),
      { timeout: 3_000 },
    );
  }).toPass();
  await page.waitForTimeout(2_000);
  await expect(tooltip).toBeVisible();
  await page.mouse.move(640, 500);

  // Roadmap's tab in front, then Settings → Notebooks removes Quanta from this Mac (AC9).
  const roadmapTab = strip.getByRole('tab', { name: new RegExp(`^${roadmap}`) });
  await roadmapTab.click();
  await expect(page.getByTestId('note-title')).toHaveValue(roadmap);
  await openNotebookSettings(page, 'Quanta');
  const card = page
    .getByTestId('git-notebook')
    .filter({ has: page.getByRole('heading', { name: 'Quanta' }) });
  await card.getByTestId('git-remove').click();
  const confirm = card.getByTestId('git-remove-confirm');
  if (await confirm.isVisible()) await confirm.getByTestId('git-remove-anyway').click();
  await expect(page.getByTestId('git-notebook-row')).toHaveCount(1, { timeout: 20_000 });
  // Settings stays on screen; ← Notes goes back to the tab that is left, Personal's.
  await expect(page).toHaveURL(/\/settings/);
  await page.locator('.settings-bar .back-link').click();
  await expect(strip.getByRole('tab')).toHaveCount(1);
  const left = strip.getByRole('tab', { selected: true });
  await expect(left).toHaveAccessibleName(new RegExp(`^Groceries ${RUN}`));
  await expect(page.getByTestId('note-title')).toHaveValue(`Groceries ${RUN}`);
  await expect(page.getByText('Note not found')).toHaveCount(0);
  await page.waitForTimeout(2_000);
  await expect(left).toBeVisible();
  expect(errors).toEqual([]);
});
