import { expect, type Page, test } from './fixtures';
import { body, collectErrors, newNote, ULID } from './support/app';

// T43 on the Mac without a server (T59, D48, A912): a notebook is a git notebook. Two of them
// show side by side, each a section of the sidebar with its own tree and sync state; an open
// note is marked in its own notebook's tree; search finds notes in both. A git notebook holds no notebooks of
// its own (A912): no New Notebook, Turn into Notebook or Close on This Device. Settings → Git
// Notebooks removes one from this Mac (after Touch ID), and its section goes; the other stays.
// The personal workspace's notebooks (made from the palette, closed on a device, turned back
// into folders, mirrored) went with the server.

const RUN = `${Date.now().toString(36)}${100 + Math.floor(Math.random() * 900)}`;
const SEARCH = 'ControlOrMeta+Shift+KeyF';
const PALETTE = 'ControlOrMeta+KeyK';
const WORD = `quill${RUN}`;

/** A notebook's section of the sidebar: a region named for it. */
const section = (page: Page, name: string) =>
  page.getByTestId('source-section').and(page.getByRole('region', { name, exact: true }));
const treeIn = (page: Page, name: string) =>
  section(page, name).getByRole('tree', { name: 'Folders and notes' });

test.describe('in Notes, with an errand', () => {
  test.use({
    seed: {
      name: 'Notes',
      folders: ['Errands'],
      notes: [{ title: `Errand ${RUN}`, markdown: `Buy ${WORD} ink.` }],
    },
  });

  test('two git notebooks side by side: their own trees, search across both, and Remove', async ({
    page,
    host,
    notebook,
  }) => {
    test.setTimeout(120_000);
    const errors = collectErrors(page);
    const [errand] = notebook!.noteIds;
    // A second notebook on this Mac, from another repository.
    const work = await host.seed({
      name: 'Work',
      notes: [{ title: `Parser ${RUN}`, markdown: `The ${WORD} grammar.` }],
    });
    const [parser] = work.noteIds;
    await page.goto('/');

    // Each notebook is a section with its own tree and sync dot.
    for (const name of ['Notes', 'Work']) {
      await expect(section(page, name)).toBeVisible();
      await expect(section(page, name).getByTestId('section-sync')).toHaveAttribute(
        'data-state',
        'synced',
        { timeout: 40_000 },
      );
    }
    await expect(
      treeIn(page, 'Notes').getByRole('treeitem', { name: `Errand ${RUN}`, exact: true }),
    ).toBeVisible();
    await expect(
      treeIn(page, 'Work').getByRole('treeitem', { name: `Parser ${RUN}`, exact: true }),
    ).toBeVisible();
    await expect(
      treeIn(page, 'Notes').getByRole('treeitem', { name: `Parser ${RUN}`, exact: true }),
    ).toHaveCount(0);

    // An open note is marked in its own notebook's tree.
    await page.goto(`/notes/${parser}`);
    await expect(page.getByTestId('note-title')).toHaveValue(`Parser ${RUN}`);
    await expect(
      treeIn(page, 'Work').getByRole('link', { name: `Parser ${RUN}`, exact: true }),
    ).toHaveAttribute('aria-current', 'page');

    // Search finds the word in both notebooks.
    await page.keyboard.press(SEARCH);
    await page.getByTestId('search').getByRole('combobox', { name: 'Search notes' }).fill(WORD);
    const results = page
      .getByTestId('search')
      .getByRole('listbox', { name: 'Search results' })
      .getByRole('option');
    await expect
      .poll(async () =>
        (
          await results.evaluateAll((nodes) =>
            nodes.map((node) => node.getAttribute('data-note-id')),
          )
        ).sort(),
      )
      .toEqual([errand, parser].sort());
    await page.keyboard.press('Escape');

    // No notebooks inside a git notebook (A912): not from the palette, not from a folder's menu.
    await page.goto('/');
    // The keyboard dispatcher attaches once the app has mounted.
    await expect(page.locator('button[data-command="note.new"]').first()).toBeVisible();
    await page.keyboard.press(PALETTE);
    const palette = page.getByRole('dialog', { name: 'Command Palette' });
    await palette.getByRole('combobox', { name: 'Command Palette' }).fill('New Notebook');
    await expect(palette.getByRole('option', { name: /New Notebook/ })).toHaveCount(0);
    await page.keyboard.press('Escape');
    await treeIn(page, 'Notes')
      .getByRole('treeitem', { name: 'Errands', exact: true })
      .click({ button: 'right' });
    const menu = page.getByRole('menu');
    await expect(menu).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: 'Turn into Notebook' })).toHaveCount(0);
    await expect(menu.getByRole('menuitem', { name: 'Close on This Device' })).toHaveCount(0);
    await page.keyboard.press('Escape');

    // Settings → Notebooks lists both; Work's own page removes it from this Mac; Notes stays.
    await page.goto('/settings/git-notebooks');
    await expect(page.getByTestId('git-notebook-row')).toHaveCount(2);
    await page.getByTestId('git-notebook-row').filter({ hasText: 'Work' }).click();
    await expect(page).toHaveURL(/\/settings\/git-notebooks\/[0-9A-Z]{26}$/);
    const card = page
      .getByTestId('git-notebook')
      .filter({ has: page.getByRole('heading', { name: 'Work' }) });
    await card.getByTestId('git-remove').click();
    const confirm = card.getByTestId('git-remove-confirm');
    if (await confirm.isVisible()) await confirm.getByTestId('git-remove-anyway').click();
    await expect(card).toHaveCount(0, { timeout: 20_000 });
    // Back to the list, which has Notes alone.
    await expect(page).toHaveURL(/\/settings\/git-notebooks$/);
    await expect(page.getByTestId('git-notebook-row')).toHaveCount(1);
    expect((await host.notebooks.list()).map((each) => each.name)).toEqual(['Notes']);
    await page.goto('/');
    await expect(section(page, 'Notes')).toBeVisible();
    await expect(section(page, 'Work')).toHaveCount(0);
    await page.goto(`/notes/${errand}`);
    await expect(page.getByTestId('note-title')).toHaveValue(`Errand ${RUN}`);
    expect(errors).toEqual([]);
  });
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
// T42, item 9.
test('Sync stopped opens Settings → Notebooks, where Sync Now starts it again', async ({
  page,
  host,
}) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  // The host refuses this Mac's pushes (a protected branch), until the test lets them through.
  let refuse = true;
  let refused = 0;
  const call = host.call.bind(host);
  host.call = async (method, args) => {
    if (!(refuse && method === 'op' && args[1] === 'push')) return call(method, args);
    refused++;
    return {
      ok: false,
      error: {
        code: 'protected',
        message: 'The host refused the push.',
        hostMessage: 'GH006: Protected branch update failed',
      },
    };
  };
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
  // The notebook's row in the sidebar is a red band too, its dot the bar's (!) (R2-5).
  const head = page.getByTestId('source-section').locator('.sb-section-head');
  await expect(head).toHaveAttribute('data-sync', 'stopped');
  await expect(dot.locator('[data-icon="warning"]')).toHaveCount(1);
  await expect(dot.locator('.dot')).toHaveCount(0);
  const measure = (target = band, text?: string) =>
    target.evaluate((element, inner) => {
      const style = getComputedStyle(element);
      const words = inner ? element.querySelector(inner)! : element;
      const probe = document.createElement('span');
      probe.style.color = 'var(--pm-danger)';
      document.body.append(probe);
      const danger = getComputedStyle(probe).color;
      probe.remove();
      return { background: style.backgroundColor, color: getComputedStyle(words).color, danger };
    }, text);
  // In the light variant, then the dark one (the theme follows the system's).
  const light = [await measure(), await measure(head, '.sb-section-name')];
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect.poll(async () => (await measure()).danger).not.toBe(light[0]!.danger);
  const dark = [await measure(), await measure(head, '.sb-section-name')];
  for (const [scheme, all] of [
    ['light', light],
    ['dark', dark],
  ] as const) {
    for (const [index, colours] of all.entries()) {
      const what = `${scheme} ${index === 0 ? 'status bar' : 'notebook row'}`;
      expect(colours.background, what).toBe(colours.danger);
      expect(contrast(colours.color, colours.background), what).toBeGreaterThanOrEqual(4.5);
    }
  }
  await page.emulateMedia({ colorScheme: 'light' });
  // Flush in the bar, as its other items are: its full height, at its left edge (R2-6).
  const fit = await band.evaluate((element) => {
    const bar = element.closest('.status-bar')!;
    const outer = bar.getBoundingClientRect();
    const own = element.getBoundingClientRect();
    const border = parseFloat(getComputedStyle(bar).borderTopWidth);
    return {
      left: own.left - outer.left,
      top: own.top - outer.top - border,
      bottom: outer.bottom - own.bottom,
    };
  });
  expect(Math.abs(fit.left), 'left').toBeLessThan(0.5);
  expect(Math.abs(fit.top), 'top').toBeLessThan(0.5);
  expect(Math.abs(fit.bottom), 'bottom').toBeLessThan(0.5);
  await expect(page.getByTestId('save-alert')).toContainText('Sync Stopped.');

  // A retry refused again: the sidebar's row and the note's bar stay Sync Stopped all through
  // it, never Syncing (R2-7). Every state either shows from here is kept.
  await page.evaluate(() => {
    const seen: unknown[] = [];
    for (const element of document.querySelectorAll(
      '[data-testid="section-sync"], [data-testid="save-status"]',
    )) {
      seen.push(element.getAttribute('data-state'));
      new MutationObserver(() => seen.push(element.getAttribute('data-state'))).observe(element, {
        attributeFilter: ['data-state'],
      });
    }
    (window as unknown as { seen: unknown[] }).seen = seen;
  });
  const before = refused;
  await page.keyboard.press('ControlOrMeta+KeyK');
  const palette = page.getByRole('dialog', { name: 'Command Palette' });
  await palette
    .getByRole('combobox', { name: 'Command Palette' })
    .fill('Sync This Git Notebook Now');
  await expect(palette.getByRole('option').first()).toContainText('Sync This Git Notebook Now');
  await page.keyboard.press('Enter');
  await expect(palette).toBeHidden();
  await expect.poll(() => refused, { timeout: 60_000 }).toBeGreaterThan(before);
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
  // The retry's states, from before it, never Syncing (R2-7).
  const seen = await page.evaluate(() => (window as unknown as { seen: unknown[] }).seen);
  expect(new Set(seen)).toEqual(new Set(['stopped']));

  // Let it through: Sync Now pushes, and the stop goes.
  refuse = false;
  await card.getByTestId('git-sync-now').click();
  await expect(card.getByTestId('git-status')).toHaveAttribute('data-phase', 'synced', {
    timeout: 60_000,
  });
  await expect(card.getByTestId('git-error')).toHaveCount(0);
});

const SHOTS = process.env['PENMOSS_EVIDENCE'];

async function openNote(page: Page, title: string, notebook = 'Quanta'): Promise<void> {
  await section(page, notebook)
    .getByRole('tree', { name: 'Folders and notes' })
    .getByRole('link', { name: title, exact: true })
    .click();
  await expect(page).toHaveURL(ULID);
  await expect(page.getByTestId('note-title')).toHaveValue(title);
}
test.describe('in Quanta, with notes of links, lists and headings', () => {
  test.use({
    seed: {
      name: 'Quanta',
      notes: [
        { title: 'Links', markdown: 'See the docs here.\n' },
        {
          title: 'Outline',
          markdown: '1. one\n   1. two\n      1. three\n         1. four\n2. five\n',
        },
        { title: 'Lists', markdown: '1. one\n2. two\n3. three\n' },
        { title: 'Heading', markdown: 'first line\n\nsecond line\n' },
      ],
    },
  });

  // Ryan’s feedback of 6 Nov 2026 (Quanta), item 5.
  test('with two notebooks open, the breadcrumb starts with the note’s notebook', async ({
    page,
    host,
  }) => {
    const errors = collectErrors(page);
    await page.goto('/');
    await openNote(page, 'Links');
    // One notebook: no notebook in the breadcrumb. Since PEN-140 (A1505) it is the status bar's
    // place, the title being the tab's.
    await expect(page.getByTestId('note-source-crumb')).toHaveCount(0);
    await host.seed({ name: 'Work', notes: [{ title: 'Parser' }] });
    await expect(section(page, 'Work')).toBeVisible({ timeout: 40_000 });
    const crumbs = page.getByTestId('status-place');
    await expect(crumbs.getByTestId('note-source-crumb')).toHaveText('Quanta');
    await openNote(page, 'Parser', 'Work');
    await expect(crumbs.getByTestId('note-source-crumb')).toHaveText('Work');
    await expect(
      page.locator('.tab-strip').getByRole('tab', { selected: true }),
    ).toHaveAccessibleName(/^Parser/);
    if (SHOTS) await page.locator('.status-bar').screenshot({ path: `${SHOTS}/breadcrumb.png` });
    expect(errors).toEqual([]);
  });
});

async function newNoteFromButtonAndEnter(page: Page, title: string, text = ''): Promise<string> {
  await page
    .getByRole('button', { name: /^New Note/ })
    .first()
    .click();
  await expect(page).toHaveURL(ULID);
  await expect(page.getByTestId('note-title')).toBeFocused();
  await page.keyboard.type(title);
  await page.keyboard.press('Enter');
  if (text) await page.keyboard.type(text);
  await expect(page.getByTestId('note-view')).toHaveAttribute('data-ready', 'true');
  return ULID.exec(new URL(page.url()).pathname)![1]!;
}

// T39 pass 2.
test('the sync pill is read out only when it needs attention', async ({ page, context, host }) => {
  test.setTimeout(120_000);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await newNoteFromButtonAndEnter(page, `Pill ${RUN}`, 'Text.');
  // The notebook's dot (A933), and the sidebar's live region.
  const pill = page.getByTestId('section-sync');
  const alert = page.getByTestId('sync-alert');
  await expect(pill).toHaveAttribute('data-state', 'synced', { timeout: 40_000 });
  // Not a live region itself: Syncing and Synced on every edit are not announced.
  expect(await pill.getAttribute('role')).toBeNull();
  await expect(alert).toHaveText('');
  // The Mac loses its network: a remote on this Mac needs none (#174 review), so git's is taken
  // down too, and the next push fails as it would.
  await context.setOffline(true);
  host.network = 'down';
  await body(page).click();
  await page.keyboard.type(' More.');
  await expect(pill).toHaveAttribute('data-state', 'offline', { timeout: 40_000 });
  await expect(alert).toContainText('Offline');
  host.network = 'up';
  await context.setOffline(false);
  await expect(pill).toHaveAttribute('data-state', 'synced', { timeout: 40_000 });
  await expect(alert).toHaveText('');
  expect(errors).toEqual([]);
});
