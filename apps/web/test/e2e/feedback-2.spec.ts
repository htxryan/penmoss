import { expect, test, type Page } from './fixtures';
import { storedRecord } from './stored';
import { NEW_NOTE } from './keys';
import { notebookAction } from './notebook-actions';

// T42 (#104 items 1–9): Ryan's second round of feedback, in the web app (the Mac app runs the
// same page; its own suite covers what differs there). On a git notebook (T59): search is this
// device's words, versions are git's commits, settings are the notebook's (A827), and a stopped
// sync is fixed in Settings → Notebooks.

const ULID = /\/notes\/([0-9A-HJKMNP-TV-Z]{26})$/;
const RUN = `g${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(error.message));
  return errors;
}

const info = (page: Page) => page.getByRole('complementary', { name: 'Metadata' });

async function newNote(page: Page, title: string, text: string): Promise<string> {
  await expect(page.locator('button[data-command="note.new"]').first()).toBeVisible();
  await page.keyboard.press(NEW_NOTE);
  await expect(page).toHaveURL(ULID);
  await expect(page.getByTestId('note-title')).toBeFocused();
  await page.keyboard.type(title);
  await page.keyboard.press('Enter');
  await page.keyboard.type(text);
  await expect(page.getByTestId('note-view')).toHaveAttribute('data-ready', 'true');
  return ULID.exec(new URL(page.url()).pathname)![1]!;
}

async function openInfo(page: Page) {
  // Metadata's tab icon down the note's edge (T53 item 9): it opens the tab, or closes the panel
  // while that tab shows.
  const tab = page.getByTestId('note-tab-info');
  if ((await tab.getAttribute('aria-selected')) !== 'true') await tab.click();
  await expect(info(page)).toBeVisible();
}

test('2: one search, no type picker; a git notebook’s words, quietly, online and offline', async ({
  page,
  context,
}) => {
  const errors = collectErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  const word = `onesearch${RUN}`;
  const id = await newNote(page, `One search ${RUN}`, `A note about ${word}.`);
  // This device's index reads the stored note (A7).
  await expect.poll(async () => (await storedRecord(page, id))?.text ?? '').toContain(word);
  await page.keyboard.press('ControlOrMeta+Shift+KeyF');
  const search = page.getByTestId('search');
  await expect(search).toBeVisible();
  await expect(search.getByRole('radiogroup')).toHaveCount(0);
  await expect(search.getByRole('radio')).toHaveCount(0);
  await page.keyboard.type(word);
  const result = search.locator(`[role="option"][data-note-id="${id}"]`);
  await expect(result).toBeVisible();
  // Without search by meaning (this stand-in Mac has none), Words only, quietly, and no notice
  // (A1156).
  await expect(search.getByTestId('search-status')).toContainText('on this device');
  await expect(search.getByTestId('search-words-only')).toBeVisible();
  await expect(search.getByTestId('search-notice')).toHaveCount(0);

  // Offline: the same, from this device.
  await context.setOffline(true);
  try {
    await page.keyboard.press('Backspace');
    await expect(result).toBeVisible();
    await expect(search.getByTestId('search-status')).toContainText('on this device');
    await expect(search.getByTestId('search-words-only')).toBeVisible();
    await expect(search.getByTestId('search-notice')).toHaveCount(0);
  } finally {
    await context.setOffline(false);
  }
  await page.keyboard.press('Escape');
  expect(errors).toEqual([]);
});

test('3: Kind is a label on periodic notes only', async ({ page }) => {
  const errors = collectErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await newNote(page, `Kind ${RUN}`, 'An ordinary note.');
  await openInfo(page);
  const details = info(page).getByTestId('note-details');
  await expect(details).toContainText('Folder');
  await expect(details).not.toContainText('Kind');
  await expect(info(page).getByTestId('info-kind')).toHaveCount(0);

  await page.locator('button[data-command="journal.today"]').first().click();
  await expect(page.getByTestId('note-view')).toHaveAttribute('data-ready', 'true');
  await openInfo(page);
  await expect(info(page).getByTestId('info-kind')).toContainText('Daily note');
  await expect(info(page).getByTestId('note-details')).not.toContainText('Kind');
  expect(errors).toEqual([]);
});

test('4: sidebar tips only add something: icon names; note rows have none (A1119)', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await newNote(page, `Hover ${RUN}`, 'Hover my row.');
  const tooltip = page.getByTestId('tooltip');
  const sidebar = page.locator('.sidebar');

  // The shortcuts are icons (T51, A932), New Note too (T52): each one's tip names it, with its keys.
  for (const [selector, name] of [
    ['button[data-command="note.new"]', 'New Note'],
    ['.sb-graph', 'Graph'],
    ['[data-testid="open-search"]', 'Search'],
  ] as const) {
    await sidebar.locator(selector).hover();
    await expect(tooltip, selector).toHaveText(new RegExp(`^${name} \\(.+\\)$`));
    await page.mouse.move(900, 600);
  }

  // A note's row has no tooltip (Quanta feedback 2, A1119): the edit time covered the rows below.
  // Scrolled into view first: a scroll hides tooltips, and the shared workspace's list is long.
  const row = page.getByRole('treeitem', { name: `Hover ${RUN}` });
  await row.scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  await row.hover();
  await page.waitForTimeout(800);
  await expect(tooltip).toBeHidden();
  await page.mouse.move(900, 600);

  // The rail hides labels: there each item's tip names it, with its keys.
  await page.getByTestId('toggle-sidebar').click();
  try {
    await expect(page.getByTestId('app-root')).toHaveAttribute('data-sidebar', 'collapsed');
    await sidebar.locator('.sb-graph').hover();
    await expect(tooltip).toHaveText(/^Graph \(.+\)$/);
  } finally {
    await page.mouse.move(900, 600);
    await page.getByTestId('toggle-sidebar').click();
    await expect(page.getByTestId('app-root')).not.toHaveAttribute('data-sidebar', 'collapsed');
  }
  expect(errors).toEqual([]);
});

test('5: version history says versions are automatic; saving one now is secondary', async ({
  page,
}) => {
  test.setTimeout(90_000);
  const errors = collectErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await newNote(page, `Versions ${RUN}`, 'Some text to keep.');
  // The tab strip's Version History (the ⋯ menu leaves the tabs to it, A991).
  await page.getByTestId('note-tab-history').click();
  const panel = page.getByTestId('history-panel');
  // A git notebook's versions are its commits (A858): each sync is one, and Save is Sync Now.
  // The head's ⓘ says so (Ryan's review of #192, finding 13), with a link to the docs.
  await page.getByTestId('history-about').click();
  const about = page.getByTestId('history-about-text');
  await expect(about).toContainText(
    'Each sync with git is a version: this Mac commits its changes when it pushes',
  );
  await expect(about.getByRole('link', { name: 'Learn More' })).toHaveAttribute(
    'href',
    'https://penmoss.app/docs/history/#version-history',
  );
  await page.getByTestId('history-about').click();
  await expect(about).toHaveCount(0);
  await expect(panel.getByRole('button', { name: 'Save version', exact: true })).toHaveCount(0);
  const save = panel.getByRole('button', { name: 'Sync Now' });
  // A quiet button, not the panel's main action, described by the explanation.
  await expect(save).toHaveClass(/\bquiet\b/);
  await expect(save).toHaveAccessibleDescription(/Each sync with git is a version/);
  await save.click();
  await expect(panel.getByTestId('history-status')).toContainText('Saved a version', {
    timeout: 40_000,
  });
  expect(errors).toEqual([]);
});

test('6: the note’s actions are in one ⋯ menu; Full width and Copy Agent Reference stay on the bar', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await newNote(page, `Menu ${RUN}`, 'Text for the menu.');
  const bar = page.locator('.note-top .note-actions');
  // Two buttons and the menu (Copy Agent Reference since T52, A962; the Note Panel and Comments
  // buttons left for the tab icons down the note's edge in T53 item 9): nothing else on the bar.
  await expect(bar.locator(':scope > button, :scope > a, :scope > .menu-anchor')).toHaveCount(3);
  await expect(bar.getByTestId('toggle-full-width')).toBeVisible();
  await expect(bar.getByTestId('copy-agent-reference')).toBeVisible();
  await expect(
    bar.locator('[data-command="note.togglePanel"], [data-command="note.comments"]'),
  ).toHaveCount(0);
  const menuButton = bar.getByTestId('note-menu');
  await expect(menuButton).toHaveAccessibleName('Note Actions');

  // Keyboard: ↓ opens it on its first item, Escape closes it and gives focus back.
  await menuButton.focus();
  await page.keyboard.press('ArrowDown');
  const menu = page.getByRole('menu', { name: 'Note Actions' });
  await expect(menu).toBeVisible();
  // Three groups (T51, A937): what the note shows, copying it, what happens to it. The panel's
  // tabs are the strip's (A991). Full Width leads, as every bar button is in ⋯ (A1134).
  await expect(menu.getByRole('menuitemcheckbox', { name: 'Full Width' })).toBeFocused();
  const items = menu.locator('[role="menuitem"], [role="menuitemcheckbox"], [role="separator"]');
  const names = await items.evaluateAll((elements) =>
    elements.map((element) =>
      element.getAttribute('role') === 'separator'
        ? '—'
        : (element.querySelector('.menu-label')?.textContent ?? ''),
    ),
  );
  expect(names).toEqual([
    'Full Width',
    'Markdown Source',
    '—',
    'Copy Note as Markdown',
    'Copy Note as Rich Text',
    'Copy Agent Reference',
    '—',
    'Pin to Quick Access',
    'Open in New Window',
    'Move to Folder…',
    'Move to Trash',
  ]);
  // Add a Tag (the Metadata tab has it) and Send Feedback (the sidebar has it) left the menu.
  await expect(menu.getByRole('menuitem', { name: /Add a Tag|Send Feedback/i })).toHaveCount(0);
  await expect(menu.getByRole('menuitemcheckbox', { name: 'Markdown Source' })).toHaveAttribute(
    'aria-checked',
    'false',
  );
  // An item with a shortcut names it, which a person also sees.
  await expect(menu.getByRole('menuitemcheckbox', { name: 'Markdown Source' })).toHaveAttribute(
    'aria-keyshortcuts',
    /.+/,
  );
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(menuButton).toBeFocused();

  // Markdown Source from the menu, and its checked state.
  await menuButton.click();
  await menu.getByRole('menuitemcheckbox', { name: 'Markdown Source' }).click();
  await expect(page.getByTestId('note-markdown')).toContainText('Text for the menu.');
  await menuButton.click();
  await expect(menu.getByRole('menuitemcheckbox', { name: 'Markdown Source' })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await page.keyboard.press('Escape');
  expect(errors).toEqual([]);
});

test('7: Settings → Display hides sidebar shortcuts, on the rail too; Search stays', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/settings/display');
  const settings = page.getByTestId('display-settings');
  await expect(settings).toBeVisible();
  const today = settings.getByRole('checkbox', { name: 'Today' });
  const graph = settings.getByRole('checkbox', { name: 'Graph' });
  await expect(settings.getByRole('checkbox', { name: /Search/ })).toBeDisabled();
  await expect(settings.getByRole('checkbox', { name: /Search/ })).toBeChecked();
  // Enabled once this device's copy of the settings is read: before, they are only defaults.
  await expect(today).toBeEnabled();
  const actions = page.locator('.sidebar .sb-actions');
  try {
    await expect(today).toBeChecked();
    await expect(graph).toBeChecked();
    await today.uncheck();
    await graph.uncheck();
    await expect(today).not.toBeChecked();

    // Synced: once the notebook has pushed them, after a reload the sidebar leaves them out,
    // expanded and as a rail. Back to the notes in the app, so the change is not cut off by a load.
    await page.locator('.settings-bar .back-link').click();
    await expect(actions.locator('[data-command="journal.today"]')).toHaveCount(0);
    await expect(page.getByTestId('section-sync')).toHaveAttribute('data-state', 'synced', {
      timeout: 40_000,
    });
    await expect(page.getByTestId('section-sync')).toHaveAttribute('data-pending', '0', {
      timeout: 40_000,
    });
    await page.reload();
    await expect(actions.locator('[data-command="app.search"]')).toBeVisible();
    await expect(actions.locator('[data-command="journal.thisWeek"]')).toBeVisible();
    await expect(actions.locator('[data-command="app.palette"]')).toBeVisible();
    await expect(actions.locator('[data-command="journal.today"]')).toHaveCount(0);
    await expect(actions.locator('[data-command="app.graph"]')).toHaveCount(0);
    await page.getByTestId('toggle-sidebar').click();
    await expect(page.getByTestId('app-root')).toHaveAttribute('data-sidebar', 'collapsed');
    await expect(actions.locator('[data-command="app.search"]')).toBeVisible();
    await expect(actions.locator('[data-command="journal.today"]')).toHaveCount(0);
    await expect(actions.locator('[data-command="app.graph"]')).toHaveCount(0);
    await page.getByTestId('toggle-sidebar').click();

    // A hidden shortcut's command still runs from the palette.
    await page.keyboard.press('ControlOrMeta+KeyK');
    await page.keyboard.type('Graph');
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/\/graph/);
  } finally {
    await page.goto('/settings/display');
    await expect(today).toBeEnabled();
    for (const box of [today, graph]) if (!(await box.isChecked())) await box.check();
    await expect(today).toBeChecked();
    await expect(graph).toBeChecked();
    // And synced again.
    await page.locator('.settings-bar .back-link').click();
    await expect(actions.locator('[data-command="journal.today"]')).toBeVisible();
    await expect(page.getByTestId('section-sync')).toHaveAttribute('data-state', 'synced', {
      timeout: 40_000,
    });
  }
  expect(errors).toEqual([]);
});

test('8: Add a tag suggests every tag on any note, by keyboard too', async ({ page }) => {
  const errors = collectErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  const tag = `sug${RUN}`;
  // A third tag the open note never gets, so the list still has something to offer at the
  // end, on a fresh workspace too.
  await newNote(page, `Tagged ${RUN}`, `Seeds #${tag}/beans, #${tag}x and #${tag}zz`);
  // The tag pane has the tags once the note's text is read.
  await expect(page.getByRole('button', { name: new RegExp(`^#${tag}x,`) })).toBeVisible();
  // The open note's own inline tag is on it already: never suggested (N6).
  await newNote(page, `Untagged ${RUN}`, `No tags yet but #${tag}inline here.`);
  await openInfo(page);
  const panel = info(page);
  await expect(panel.getByTestId('info-inline-tags')).toContainText(`#${tag}inline`);
  await panel.getByRole('button', { name: 'Add a Tag', exact: true }).click();
  const field = panel.getByRole('combobox', { name: 'Add a tag' });
  await expect(field).toBeFocused();
  // The browser's own form history never shows over it.
  await expect(field).toHaveAttribute('autocomplete', 'off');
  await expect(field).toHaveAttribute('aria-expanded', 'false');

  await field.pressSequentially(tag.slice(0, -2));
  const list = panel.getByRole('listbox', { name: 'Tags' });
  await expect(field).toHaveAttribute('aria-expanded', 'true');
  await expect(list.getByRole('option')).toHaveText([`#${tag}/beans`, `#${tag}x`, `#${tag}zz`]);

  // ↓ chooses the first, ↓ the next, ↑ back; Enter adds the chosen one.
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await expect(list.getByRole('option', { name: `#${tag}x` })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await page.keyboard.press('ArrowUp');
  await expect(list.getByRole('option', { name: `#${tag}/beans` })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(field).toHaveAttribute('aria-activedescendant', /.+/);
  await page.keyboard.press('Enter');
  await expect(panel.getByRole('button', { name: `#${tag}/beans`, exact: true })).toBeVisible();
  await expect(field).toHaveValue('');
  await expect(field).toBeFocused();

  // A note's own tags are not suggested again; a click adds one.
  await field.pressSequentially(tag);
  await expect(list.getByRole('option')).toHaveText([`#${tag}x`, `#${tag}zz`]);
  await list.getByRole('option', { name: `#${tag}x` }).click();
  await expect(panel.getByRole('button', { name: `#${tag}x`, exact: true })).toBeVisible();

  // Escape closes the list first, then the field.
  await field.pressSequentially(tag);
  await expect(list.getByRole('option')).toHaveText([`#${tag}zz`]);
  await expect(field).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.press('Escape');
  await expect(field).toHaveAttribute('aria-expanded', 'false');
  await expect(field).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(field).toHaveCount(0);
  expect(errors).toEqual([]);
});

/** WCAG contrast of two computed `rgb(…)` colours. */
function contrast(a: string, b: string): number {
  const luminance = (colour: string) => {
    const [r, g, bl] = (colour.match(/[\d.]+/g) ?? []).slice(0, 3).map((part) => {
      const c = Number(part) / 255;
      return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * bl!;
  };
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light! + 0.05) / (dark! + 0.05);
}

test('9: Sync stopped opens Settings → Notebooks, where Sync Now starts it again', async ({
  page,
  host,
}) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  // The host refuses this Mac's pushes (a protected branch), until the test lets them through.
  let refuse = true;
  const call = host.call.bind(host);
  host.call = async (method, args) =>
    refuse && method === 'op' && args[1] === 'push'
      ? {
          ok: false,
          error: {
            code: 'protected',
            message: 'The host refused the push.',
            hostMessage: 'GH006: Protected branch update failed',
          },
        }
      : call(method, args);
  await page.goto('/');
  await newNote(page, `Refused ${RUN}`, 'Kept here until it can go.');
  const dot = page.getByTestId('section-sync');
  await expect(dot).toHaveAttribute('data-state', 'stopped', { timeout: 60_000 });
  await expect(dot).toHaveAttribute('data-label', /Sync Stopped/);
  // The note's bar says so in a red band, the page's colour on the theme's danger colour, at
  // AA contrast, and leads to the same page (finding 12 of the #192 review).
  const band = page.getByTestId('status-bar').getByRole('link', { name: /^Sync Stopped/ });
  await expect(band).toHaveText('Sync Stopped');
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'stopped');
  await expect(band).toHaveAttribute('href', /\/settings\/git-notebooks\/[0-9A-Z]{26}$/);
  const measure = () =>
    band.evaluate((element) => {
      const style = getComputedStyle(element);
      const probe = document.createElement('span');
      probe.style.color = 'var(--pm-danger)';
      document.body.append(probe);
      const danger = getComputedStyle(probe).color;
      probe.remove();
      return { background: style.backgroundColor, color: style.color, danger };
    });
  // In the light variant, then the dark one (the theme follows the system's).
  const light = await measure();
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect.poll(async () => (await measure()).danger).not.toBe(light.danger);
  const dark = await measure();
  for (const [scheme, colours] of [
    ['light', light],
    ['dark', dark],
  ] as const) {
    expect(colours.background, scheme).toBe(colours.danger);
    expect(contrast(colours.color, colours.background), scheme).toBeGreaterThanOrEqual(4.5);
  }
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(page.getByTestId('save-alert')).toContainText('Sync Stopped.');
  // A link, reachable by keyboard.
  await expect(dot).toHaveRole('link');
  await dot.focus();
  await page.keyboard.press('Enter');
  // Its notebook's own page (A1098).
  await expect(page).toHaveURL(/\/settings\/git-notebooks\/[0-9A-Z]{26}$/);
  const card = page.getByTestId('git-notebook');
  await expect(card.getByTestId('git-status')).toHaveAttribute('data-phase', 'stopped');
  await expect(card.getByTestId('git-error')).toContainText('refused the push');
  await expect(card.getByTestId('git-error')).toContainText('GH006');

  // Let it through: Sync Now pushes, and the stop goes.
  refuse = false;
  await card.getByTestId('git-sync-now').click();
  await expect(card.getByTestId('git-status')).toHaveAttribute('data-phase', 'synced', {
    timeout: 60_000,
  });
  await expect(card.getByTestId('git-error')).toHaveCount(0);
});

test('1: a context menu on notes, a selection and folders: Move, Trash with Undo, Rename', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  // A folder to move into, made from the tree.
  await page.getByTestId('tree-root-drop').click();
  await (await notebookAction(page, 'New Folder')).click();
  await page.getByRole('textbox', { name: 'New folder name' }).fill(`Shelf ${RUN}`);
  await page.keyboard.press('Enter');
  const tree = page.getByRole('tree', { name: 'Folders and notes' });
  // The notes start in a folder of their own: in the shared workspace, other runs' notes can sit
  // between new ones at the top level, and a Shift range would take them in.
  await page.getByTestId('tree-root-drop').click();
  await (await notebookAction(page, 'New Folder')).click();
  await page.getByRole('textbox', { name: 'New folder name' }).fill(`Desk ${RUN}`);
  await page.keyboard.press('Enter');
  await tree.getByRole('treeitem', { name: `Desk ${RUN}`, exact: true }).click();
  await newNote(page, `Ctx one ${RUN}`, 'First.');
  await newNote(page, `Ctx two ${RUN}`, 'Second.');
  await newNote(page, `Ctx three ${RUN}`, 'Third.');
  await expect(tree).toHaveAttribute('aria-multiselectable', 'true');
  const row = (name: string) => tree.getByRole('treeitem', { name, exact: true });
  const one = row(`Ctx one ${RUN}`);
  const two = row(`Ctx two ${RUN}`);
  const three = row(`Ctx three ${RUN}`);

  // A plain click opens a note; Shift-click selects the notes between, opening nothing.
  await one.click();
  await expect(page).toHaveURL(ULID);
  const opened = page.url();
  await three.click({ modifiers: ['Shift'] });
  expect(page.url()).toBe(opened);
  for (const each of [one, two, three]) await expect(each).toHaveAttribute('aria-selected', 'true');
  // Toggling one out: Ctrl here (⌘ on a Mac, where Ctrl-click is a right-click).
  await two.click({ modifiers: [process.platform === 'darwin' ? 'Meta' : 'Control'] });
  await expect(two).toHaveAttribute('aria-selected', 'false');
  await two.click({ modifiers: [process.platform === 'darwin' ? 'Meta' : 'Control'] });
  await expect(two).toHaveAttribute('aria-selected', 'true');

  // Right-click a selected note: the in-app menu acts on all three, and names them, as some
  // may be scrolled out of sight (review S1).
  await three.click({ button: 'right' });
  const menu = page.getByRole('menu', { name: '3 notes' });
  await expect(menu).toBeVisible();
  for (const name of ['one', 'two', 'three']) {
    await expect(menu).toHaveAccessibleName(new RegExp(`“Ctx ${name} ${RUN}”`));
    await expect(page.getByTestId('context-menu-caption')).toContainText(`“Ctx ${name} ${RUN}”`);
  }
  await expect(menu.getByRole('menuitem').first()).toBeFocused();
  await menu.getByRole('menuitem', { name: 'Move 3 notes…' }).click();
  const picker = page.getByRole('dialog', { name: 'Move 3 notes to a folder' });
  await expect(picker).toBeVisible();
  await page.keyboard.type(`Shelf ${RUN}`);
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('move-status')).toHaveText(`Moved 3 notes to Shelf ${RUN}`);
  const shelf = tree.getByRole('treeitem', { name: `Shelf ${RUN}`, exact: true });
  await expect(shelf).toHaveAttribute('aria-expanded', 'true');
  for (const each of [one, two, three]) await expect(each).toHaveAttribute('aria-level', '2');

  // From the keyboard: Shift+F10 on a note, which acts on it alone once the selection is gone.
  await one.click();
  await one.focus();
  await page.keyboard.press('Shift+F10');
  const single = page.getByRole('menu', { name: `“Ctx one ${RUN}”` });
  await expect(single).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(single).toHaveCount(0);
  await expect(one).toBeFocused();

  // Two notes to Trash, then Undo brings both back.
  await two.click({ modifiers: ['Shift'] });
  await two.click({ button: 'right' });
  await page
    .getByRole('menu', { name: '2 notes' })
    .getByRole('menuitem', { name: 'Move 2 notes to Trash' })
    .click();
  await expect(page.getByTestId('trashed-toast')).toContainText('Moved 2 notes to Trash');
  await expect(one).toHaveCount(0);
  await expect(two).toHaveCount(0);
  await page.getByTestId('trashed-undo').click();
  await expect(one).toBeVisible();
  await expect(two).toBeVisible();

  // A selection never lingers once a note is opened another way (back, search, a link): the
  // next Move or Trash cannot reach notes chosen earlier (review S1).
  await one.click();
  await two.click({ modifiers: ['Shift'] });
  await expect(two).toHaveAttribute('aria-selected', 'true');
  await page.goBack();
  await expect(one).toHaveAttribute('aria-selected', 'false');
  await expect(two).toHaveAttribute('aria-selected', 'false');
  // ⌘ or Ctrl-click with nothing chosen takes only that note, not the open one unseen.
  await two.click({ modifiers: [process.platform === 'darwin' ? 'Meta' : 'Control'] });
  await two.click({ button: 'right' });
  await expect(page.getByRole('menu', { name: `“Ctx two ${RUN}”` })).toBeVisible();
  await page.keyboard.press('Escape');

  // A folder's menu: Rename, from the context-menu key.
  await shelf.focus();
  await page.keyboard.press('ContextMenu');
  const folderMenu = page.getByRole('menu', { name: `Folder Shelf ${RUN}` });
  await expect(folderMenu.getByRole('menuitem', { name: 'Delete Folder…' })).toBeVisible();
  await folderMenu.getByRole('menuitem', { name: 'Rename' }).click();
  const rename = page.getByRole('textbox', { name: `Rename folder Shelf ${RUN}` });
  await rename.fill(`Shelf2 ${RUN}`);
  await rename.press('Enter');
  await expect(tree.getByRole('treeitem', { name: `Shelf2 ${RUN}`, exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});
