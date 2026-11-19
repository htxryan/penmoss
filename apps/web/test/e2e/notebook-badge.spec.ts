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
    .getByRole('navigation', { name: 'Settings Sections' })
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

/**
 * Picks an icon in the open notebook page's picker (A1568): Choose Icon…, the search focused,
 * `query` typed, the icon clicked; the picker closes.
 */
async function chooseIcon(page: Page, query: string, name: string): Promise<void> {
  await page.getByTestId('git-panel-overview').getByTestId('badge-icon-choose').click();
  const picker = page.getByTestId('icon-picker');
  const search = picker.getByTestId('icon-picker-search');
  await expect(search).toBeFocused();
  await search.fill(query);
  await picker.locator(`[data-value="lucide:${name}"]`).click();
  await expect(picker).toHaveCount(0);
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
  // Icon starts as Lucide's notebook; Choose Icon… opens the picker (A1568).
  await expect(group.getByTestId('badge-icon-current')).toHaveAttribute(
    'data-value',
    'lucide:notebook',
  );
  await chooseIcon(page, 'star', 'star');
  const preview = group.getByTestId('badge-preview').getByTestId('notebook-badge').first();
  await expect(preview).toHaveAttribute('data-glyph', 'icon:lucide:star');
  await expect(preview).toHaveAttribute('data-color', hex);
  await expect(preview).toHaveAccessibleName('Penmoss');
  await expect(group.getByTestId('badge-reset')).toBeEnabled();
  // The tab in the preview fills its frame, as the sidebar's row does: no empty band above it,
  // and its foot is not cut by the frame (ac17).
  const strip = (await group.locator('.badge-preview-strip').boundingBox())!;
  const tab = (await group.locator('.badge-preview-strip > .tab').boundingBox())!;
  expect(tab.y - strip.y).toBeLessThanOrEqual(1.5);
  expect(strip.y + strip.height - (tab.y + tab.height)).toBeGreaterThanOrEqual(0.5);

  // Back to the notes: the sidebar's row has changed at once, the other notebook's has not.
  await page.locator('.settings-bar .back-link').click();
  const penmoss = sidebarBadge(page, 'Penmoss');
  await expect(penmoss).toHaveAttribute('data-glyph', 'icon:lucide:star');
  await expect(penmoss).toHaveAttribute('data-color', hex);
  await expect(penmoss.locator('svg[data-lucide="star"]')).toBeVisible();
  await expect(sidebarBadge(page, 'Personal')).toHaveAttribute('data-glyph', 'letter:P');

  // Kept in the notebook's own settings: a reload shows it the same.
  await page.reload();
  await expect(sidebarBadge(page, 'Penmoss')).toHaveAttribute('data-glyph', 'icon:lucide:star');
  await expect(sidebarBadge(page, 'Penmoss').locator('svg[data-lucide="star"]')).toBeVisible();
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
  await expect(sidebarBadge(page, 'Penmoss')).toHaveAttribute('data-glyph', 'icon:lucide:star');
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

  // No title row above the text (AC20): the note's buttons are at the strip's end. The status bar
  // names no place since A1587 (the tab and the sidebar do): its save status comes first.
  await expect(page.locator('.note-main .note-top')).toHaveCount(0);
  await expect(page.locator('.tab-strip-end').getByTestId('note-menu')).toBeVisible();
  const stripBox = (await page.getByTestId('tab-strip').boundingBox())!;
  const scrollBox = (await page.getByTestId('note-scroll').boundingBox())!;
  expect(scrollBox.y).toBeCloseTo(stripBox.y + stripBox.height, 0);
  await expect(page.getByTestId('status-place')).toHaveCount(0);
  await expect(page.locator('[data-testid="status-bar"] > :not(.sr-only)').first()).toHaveAttribute(
    'data-testid',
    'save-status',
  );
  // The tab's Reveal in Sidebar shows the note in its notebook's section.
  await groceriesTab.click({ button: 'right' });
  await page.getByTestId('tab-menu-reveal').click();
  await expect(sidebarSection(page, 'Personal').locator(':focus')).toContainText(
    `Groceries ${RUN}`,
  );
  // From a tab behind, too: its tab comes in front and its row is shown.
  await meetingTab.click({ button: 'right' });
  await page.getByTestId('tab-menu-reveal').click();
  await expect(meetingTab).toHaveAttribute('aria-selected', 'true');
  await expect(sidebarSection(page, 'Penmoss').locator(':focus')).toContainText(meeting);
  await groceriesTab.click();
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
  await chooseIcon(page, 'star', 'star');
  await page.locator('.settings-bar .back-link').click();
  const penmossTab = strip.getByRole('tab', { name: new RegExp(`^${meeting}, Penmoss`) });
  await expect(penmossTab.getByTestId('notebook-badge')).toHaveAttribute(
    'data-glyph',
    'icon:lucide:star',
  );
  await expect(penmossTab.locator('svg[data-lucide="star"]')).toBeVisible();
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

/** Each icon badge's glyph colour beside its badge's own ink, both as computed `rgb()`. */
async function iconInks(badges: Locator): Promise<Array<{ ink: string; drawn: string }>> {
  return badges.evaluateAll((elements) =>
    elements
      .filter((badge) => badge.querySelector('svg'))
      .map((badge) => {
        const probe = document.createElement('span');
        probe.style.color = 'var(--nb-badge-ink)';
        badge.append(probe);
        const ink = getComputedStyle(probe).color;
        probe.remove();
        return { ink, drawn: getComputedStyle(badge.querySelector('svg')!).color };
      }),
  );
}

test('an icon badge keeps its own ink on a selected or hovered row (Ryan, 15 Nov 2026)', async ({
  page,
  host,
}) => {
  test.setTimeout(120_000);
  const errors = collectErrors(page);
  await host.seed({ name: 'Penmoss', notes: [{ title: `Roadmap ${RUN}`, markdown: 'Tabs.' }] });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');
  const accent = await page.evaluate(() => {
    const probe = document.createElement('span');
    probe.style.color = 'var(--pm-accent)';
    document.body.append(probe);
    const colour = getComputedStyle(probe).color;
    probe.remove();
    return colour;
  });

  // Penmoss: a star on red, as Ryan's Personal notebook had it.
  await openNotebookSettings(page, 'Penmoss');
  const group = page.getByTestId('git-panel-overview');
  await group.getByTestId('badge-preset-red').click();
  await group.getByTestId('badge-kind-icon').check();
  await chooseIcon(page, 'star', 'star');

  // Its entry in Settings' nav is the selected one: the star stays in the badge's ink.
  const entry = page
    .getByTestId('settings-notebook-entry')
    .filter({ hasText: 'Penmoss' })
    .and(page.locator('[aria-current="page"]'));
  await expect(entry.getByTestId('notebook-badge')).toHaveAttribute(
    'data-glyph',
    'icon:lucide:star',
  );
  const [selected] = await iconInks(entry.getByTestId('notebook-badge'));
  expect(selected!.drawn).toBe(selected!.ink);
  expect(selected!.drawn).not.toBe(accent);
  // Hovered too, and every other badge on the page (the list's row, the heading, the preview).
  await entry.hover();
  for (const each of await iconInks(page.getByTestId('notebook-badge'))) {
    expect(each.drawn).toBe(each.ink);
  }

  // The sidebar's row and the note's tab, selected.
  await page.locator('.settings-bar .back-link').click();
  const row = sidebarSection(page, 'Penmoss').getByRole('link', {
    name: `Roadmap ${RUN}`,
    exact: true,
  });
  await expect(row).toBeVisible({ timeout: 40_000 });
  await row.click();
  const tab = page.getByRole('tablist', { name: 'Open Tabs' }).getByRole('tab', { selected: true });
  await expect(tab.getByTestId('notebook-badge')).toHaveAttribute('data-glyph', 'icon:lucide:star');
  await sidebarBadge(page, 'Penmoss').hover();
  const drawn = await iconInks(page.getByTestId('notebook-badge'));
  expect(drawn.length).toBeGreaterThanOrEqual(2);
  for (const each of drawn) expect(each.drawn).toBe(each.ink);
  expect(errors).toEqual([]);
});

test('the icon picker: filtered by name and tag, picked by keyboard alone, recently used (A1568)', async ({
  page,
  host,
}) => {
  test.setTimeout(120_000);
  const errors = collectErrors(page);
  await host.seed({ name: 'Penmoss', notes: [{ title: `Roadmap ${RUN}`, markdown: 'Tabs.' }] });
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');
  await openNotebookSettings(page, 'Penmoss');
  const group = page.getByTestId('git-panel-overview');
  await group.getByTestId('badge-kind-icon').check();

  // Opened from Choose Icon…: a modal dialog, its search focused, the current icon marked.
  await group.getByTestId('badge-icon-choose').click();
  const picker = page.getByTestId('icon-picker');
  const dialog = picker.getByRole('dialog', { name: 'Choose an Icon' });
  await expect(dialog).toHaveAttribute('aria-modal', 'true');
  const search = picker.getByTestId('icon-picker-search');
  await expect(search).toBeFocused();
  const grid = picker.getByRole('listbox', { name: 'Icons' });
  await expect(grid.locator('[data-value="lucide:notebook"]')).toHaveAttribute(
    'aria-current',
    'true',
  );
  // Thousands of icons, a few rows of them drawn.
  const count = (await picker.locator('.dlg-foot').textContent())!.match(/([\d,]+) icons/)![1]!;
  expect(Number(count.replace(',', ''))).toBeGreaterThan(1500);
  expect(await grid.getByRole('option').count()).toBeLessThan(400);

  // By name: the whole name first.
  await search.fill('notebook pen');
  await expect(grid.getByRole('option').first()).toHaveAttribute(
    'data-value',
    'lucide:notebook-pen',
  );
  await expect(grid.getByRole('option', { name: 'Notebook Pen', exact: true })).toBeVisible();
  // By a tag the name does not have: "favourite" finds the star.
  await search.fill('favourite');
  await expect(grid.locator('[data-value="lucide:star"]')).toBeVisible();
  // Nothing found.
  await search.fill('zzqqxx');
  await expect(picker.getByTestId('icon-picker-empty')).toHaveText('No icons match “zzqqxx”.');
  await expect(grid.getByRole('option')).toHaveCount(0);

  // The keyboard alone: type, → twice to the third result, its name in the footer, Return.
  await search.fill('rocket');
  const options = grid.getByRole('option');
  await expect(options.first()).toHaveAttribute('data-value', 'lucide:rocket');
  await expect(options.first()).toHaveAttribute('aria-selected', 'true');
  const third = (await options.nth(2).getAttribute('data-value'))!;
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await expect(options.nth(2)).toHaveAttribute('aria-selected', 'true');
  await expect(search).toHaveAttribute(
    'aria-activedescendant',
    (await options.nth(2).getAttribute('id'))!,
  );
  await expect(picker.getByTestId('icon-picker-active')).toHaveText(
    (await options.nth(2).getAttribute('aria-label'))!,
  );
  await page.keyboard.press('Enter');
  await expect(picker).toHaveCount(0);
  // Focus is back on Choose Icon…, and the row shows the pick.
  await expect(group.getByTestId('badge-icon-choose')).toBeFocused();
  await expect(group.getByTestId('badge-icon-current')).toHaveAttribute('data-value', third);

  // Space on Choose Icon… opens it again: Recently Used first, the last pick in it.
  await page.keyboard.press('Space');
  await expect(search).toBeFocused();
  await expect(picker.locator('.icon-picker-head').first()).toHaveText('Recently Used');
  await expect(grid.getByRole('option').first()).toHaveAttribute('data-value', third);
  // Escape closes it with nothing changed.
  await page.keyboard.press('Escape');
  await expect(picker).toHaveCount(0);
  await expect(group.getByTestId('badge-icon-current')).toHaveAttribute('data-value', third);

  // ↓ moves a row down: to the cell below the first result.
  await page.keyboard.press('Enter');
  await search.fill('arrow');
  await expect(grid.getByRole('option').first()).toHaveAttribute('data-value', /^lucide:.*arrow/);
  const columns = await grid.locator('.icon-picker-row').first().getByRole('option').count();
  expect(columns).toBeGreaterThan(5);
  await page.keyboard.press('ArrowDown');
  const below = grid.getByRole('option').nth(columns);
  await expect(below).toHaveAttribute('aria-selected', 'true');
  const belowValue = (await below.getAttribute('data-value'))!;
  await page.keyboard.press('Enter');
  await expect(picker).toHaveCount(0);

  // The sidebar's badge draws it.
  await page.locator('.settings-bar .back-link').click();
  const badge = sidebarBadge(page, 'Penmoss');
  await expect(badge).toHaveAttribute('data-glyph', `icon:${belowValue}`);
  await expect(
    badge.locator(`svg[data-lucide="${belowValue.slice('lucide:'.length)}"]`),
  ).toBeVisible();
  expect(errors).toEqual([]);
});
