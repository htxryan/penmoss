import AxeBuilder from '@axe-core/playwright';
import {
  expect,
  GitHost,
  macContext,
  test,
  type Browser,
  type BrowserContext,
  type Locator,
  type Page,
} from './fixtures';
import { BUILT_IN_THEMES } from '@penmoss/ui/theme';
import { NEW_FOLDER, NEW_NOTE, VERSION_HISTORY, LINE_END, SELECT_TO_LINE_START } from './keys';
import { noteAction } from './note-menu';

// T36, extended by T31: no serious or critical axe violations (WCAG 2.0, 2.1 and 2.2 A and AA)
// on every main screen, light and dark, at desktop and phone widths; every built-in theme on a
// note and Settings (T28); and the icon buttons' tooltips. On a git notebook (T59): the screens
// the Mac app has without a server.

const ULID = /\/notes\/([0-9A-HJKMNP-TV-Z]{26})$/;
const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 720 };
const SEARCH = 'ControlOrMeta+Shift+KeyF';

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(error.message));
  return errors;
}

/**
 * The slash and link menus are listboxes the note drives with aria-activedescendant: focus stays
 * in the editor (aria-controls), and the arrow keys move the active option and scroll it into
 * view (editing.spec.ts, links.spec.ts). So they are rightly not in the tab order, which axe's
 * scrollable-region-focusable cannot tell from a region the keyboard cannot reach.
 */
const EDITOR_MENU = /^<div [^>]*data-testid="(slash|link)-menu"/;

/**
 * Pins the pattern that justifies EDITOR_MENU's exclusion (review N7): while `menu` is open,
 * the editor keeps focus, names the listbox in aria-controls and its highlighted option in
 * aria-activedescendant, and the arrow keys move that option. If a menu ever stops working
 * this way, this fails and the exclusion goes with it.
 */
async function expectEditorDrivesMenu(page: Page, menu: Locator): Promise<void> {
  const listbox = menu.locator('xpath=self::*[@role="listbox"] | .//*[@role="listbox"]').first();
  const id = await listbox.getAttribute('id');
  expect(id).toBeTruthy();
  const editor = body(page);
  await expect(editor).toBeFocused();
  await expect(editor).toHaveAttribute('aria-controls', id!);
  const active = await editor.getAttribute('aria-activedescendant');
  expect(active).toBeTruthy();
  await expect(listbox.locator(`[id="${active}"]`)).toHaveAttribute('role', 'option');
  if ((await listbox.getByRole('option').count()) < 2) return; // Nowhere for the arrows to go.
  await page.keyboard.press('ArrowDown');
  await expect(editor).not.toHaveAttribute('aria-activedescendant', active!);
  await page.keyboard.press('ArrowUp');
  await expect(editor).toHaveAttribute('aria-activedescendant', active!);
}

/** Serious and critical violations, one line each, so a failure names the rule and the nodes. */
async function seriousViolations(page: Page): Promise<string[]> {
  // wcag22aa adds one rule in axe 4.14: target-size (24 px, or spaced 24 px apart).
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
    .analyze();
  return results.violations
    .filter((violation) => violation.impact === 'serious' || violation.impact === 'critical')
    .map((violation) =>
      violation.id === 'scrollable-region-focusable'
        ? { ...violation, nodes: violation.nodes.filter((node) => !EDITOR_MENU.test(node.html)) }
        : violation,
    )
    .filter((violation) => violation.nodes.length > 0)
    .map(
      (violation) =>
        `${violation.id} (${violation.impact}): ${violation.nodes
          .slice(0, 5)
          .map((node) => node.target.join(' '))
          .join(', ')}`,
    );
}

/**
 * Menus, sheets and dialogs fade or slide in, and controls fade their colours: axe measures
 * once every transition and every finite animation has finished (spinners loop for ever).
 */
async function still(page: Page) {
  await page.waitForFunction(() =>
    document
      .getAnimations()
      .every(
        (animation) =>
          animation.playState !== 'running' ||
          (!(animation instanceof CSSTransition) &&
            animation.effect?.getComputedTiming().iterations === Infinity),
      ),
  );
}

/** One screen's check; soft, so a run names every failing screen, not just the first. */
async function check(page: Page, where: string) {
  await still(page);
  expect.soft(await seriousViolations(page), where).toEqual([]);
}

async function newNote(page: Page, title: string, text: string): Promise<string> {
  await page.goto('/');
  await expect(page.getByTestId('app-root')).toBeVisible();
  await page.keyboard.press(NEW_NOTE);
  await expect(page).toHaveURL(ULID);
  await expect(page.getByTestId('note-title')).toBeFocused();
  await page.keyboard.type(title);
  await page.keyboard.press('Enter');
  await page.keyboard.type(text);
  await expect(page.getByTestId('note-view')).toHaveAttribute('data-ready', 'true');
  return ULID.exec(new URL(page.url()).pathname)![1]!;
}

const NOTE_TEXT = 'Raised beds by the fence. #garden';

const body = (page: Page) => page.getByTestId('note-body').locator('.ProseMirror');
const tree = (page: Page) => page.getByRole('tree', { name: 'Folders and notes' });
const treeItem = (page: Page, name: string) =>
  tree(page).getByRole('treeitem', { name, exact: true });
const searchInput = (page: Page) =>
  page.getByTestId('search').getByRole('combobox', { name: 'Search notes' });
/** The results whose words match (the server's answer may add semantic neighbours, A978). */
const searchResults = (page: Page) =>
  page
    .getByTestId('search')
    .getByRole('listbox', { name: 'Search results' })
    .locator('[role="option"][data-sources~="full-text"]');

/**
 * A window of a stand-in Mac with one notebook, for a serial suite's shared page (axe needs a
 * page in a context of its own, not browser.newPage()).
 */
async function suiteMac(browser: Browser, viewport?: { width: number; height: number }) {
  const host = new GitHost();
  await host.seed();
  const context = await macContext(browser, host, viewport ? { viewport } : {});
  return { host, context, page: await context.newPage() };
}

/** The notebook's sync dot: synced, nothing waiting to be pushed (A860). */
async function synced(page: Page) {
  const dot = page.getByTestId('section-sync');
  await expect(dot).toHaveAttribute('data-state', 'synced', { timeout: 40_000 });
  await expect(dot).toHaveAttribute('data-pending', '0', { timeout: 40_000 });
}

async function newFolder(page: Page, name: string): Promise<Locator> {
  await page.keyboard.press(NEW_FOLDER);
  const input = page.getByRole('textbox', { name: 'New folder name' });
  await expect(input).toBeFocused();
  await input.fill(name);
  await input.press('Enter');
  const row = treeItem(page, name);
  await expect(row).toBeFocused();
  return row;
}

async function openNote(page: Page, id: string) {
  await page.goto(`/notes/${id}`);
  await expect(page.getByTestId('note-view')).toHaveAttribute('data-ready', 'true');
}

async function settings(page: Page, path: string) {
  await page.goto(path);
  await expect(page.getByTestId('settings')).toBeVisible();
  if (path.endsWith('/git-notebooks')) {
    // Checked once loaded: the notebook's row, with its sync state (A1098).
    await expect(page.getByTestId('git-notebook-row')).toBeVisible();
    await expect(page.getByTestId('git-notebook-row')).toHaveAttribute('data-phase', /\w/);
  }
}

/** A git notebook's own page, from the list (A1098). */
async function gitNotebookPage(page: Page) {
  await settings(page, '/settings/git-notebooks');
  await page.getByTestId('git-notebook-row').first().click();
  await expect(page.getByTestId('git-notebook')).toBeVisible();
  await expect(page.getByTestId('git-status')).toBeVisible();
}

// T31: every main screen in the default theme, light and dark, at desktop and phone widths.
// One workspace for the four passes: a folder with a subfolder, a note of every common block
// filed in it, a note it links to (so one has backlinks), a saved version, and a note in Trash.
test.describe.serial('no serious axe violations on any main screen', () => {
  let host: GitHost;
  let context: BrowserContext;
  let page: Page;
  let errors: string[];
  let main: string;
  let target: string;
  const WORD = `moss${RUN}`;
  const TAG = `bed${RUN}`;
  const FOLDER = `Garden ${RUN}`;
  const SUBFOLDER = `Beds ${RUN}`;
  const MAIN = `Axe screens ${RUN}`;
  const TARGET = `Axe target ${RUN}`;

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(90_000);
    ({ host, context, page } = await suiteMac(browser, DESKTOP));
    errors = collectErrors(page);
    await page.goto('/');
    await expect(tree(page)).toBeVisible();
    await page.getByTestId('tree-root-drop').click();
    await newFolder(page, FOLDER);
    await newFolder(page, SUBFOLDER);

    // New notes go into the subfolder.
    target = await newNoteHere(page, TARGET, `Compost and ${WORD} for the beds.`);
    main = await newNoteHere(page, MAIN, '');
    const type = (text: string) => page.keyboard.type(text);
    const press = (key: string) => page.keyboard.press(key);
    await type('## Beds');
    await press('Enter');
    await type(`Plan the ${WORD} beds with `);
    await type(`[[${TARGET}`);
    const linkMenu = page.getByTestId('link-menu');
    await expect(linkMenu.getByRole('option').first()).toContainText(TARGET);
    await expectEditorDrivesMenu(page, linkMenu);
    await press('Enter');
    await expect(linkMenu).toBeHidden();
    await type(` and [the guide](https://penmoss.app) #${TAG}`);
    await press('Enter');
    await type('- Tomatoes');
    await press('Enter');
    await type('Basil');
    await press('Enter');
    await press('Enter');
    await type('- [ ] Water the beds');
    await press('Enter');
    await press('Enter');
    await type('> [!tip] Water ==early== with `cold` water.');
    await press('Enter');
    await press('Enter');
    await type('| Bed | Plant |');
    await press('Enter');
    await type('North');
    await press('Tab');
    await type('Kale');
    const table = body(page).locator('.pm-table');
    await expect(table.getByRole('toolbar', { name: 'Table' })).toBeVisible();
    await expect(async () => {
      await press('ArrowDown');
      await expect(table.getByRole('toolbar', { name: 'Table' })).toBeHidden({ timeout: 500 });
    }).toPass();
    await type('```ts');
    await press('Enter');
    await type("const beds = 4; // by the fence\nplant('tomato');");
    await expect(page.locator('.hljs-keyword').first()).toBeVisible();
    await expect(body(page).locator('a.pm-wikilink')).toHaveText(TARGET);
    await expect(body(page).locator('li[data-checked]')).toHaveCount(1);
    await expect(body(page).locator('.pm-callout')).toHaveCount(1);

    // A saved version for the history panel: on a git notebook, Sync Now (a version is a commit).
    await page.keyboard.press(VERSION_HISTORY);
    const panel = page.getByTestId('history-panel');
    await panel.getByRole('button', { name: 'Sync Now' }).click();
    await expect(panel.getByTestId('history-status')).toContainText('Saved a version');
    // The History tab of the side panel (T51, A936): back to Metadata, which the passes check.
    await page.getByTestId('note-tab-info').click();
    await expect(panel).toHaveCount(0);

    // A note in Trash.
    await newNoteHere(page, `Axe deleted ${RUN}`, 'Old seed list.');
    await noteAction(page, 'delete-note');
    await expect(treeItem(page, `Axe deleted ${RUN}`)).toHaveCount(0);

    // Each pass reloads the app: leave only once the notebook is stored and pushed.
    await synced(page);
  });

  test.afterAll(async () => {
    await context.close();
    await host.close();
  });

  /** A note in the current folder, from the shortcut, without leaving the page. */
  async function newNoteHere(page: Page, title: string, text: string): Promise<string> {
    await page.keyboard.press(NEW_NOTE);
    await expect(page).toHaveURL(ULID);
    await expect(page.getByTestId('note-title')).toBeFocused();
    await page.keyboard.type(title);
    await page.keyboard.press('Enter');
    if (text) await page.keyboard.type(text);
    await expect(page.getByTestId('note-view')).toHaveAttribute('data-ready', 'true');
    await expect(treeItem(page, title)).toBeVisible();
    return ULID.exec(new URL(page.url()).pathname)![1]!;
  }

  for (const scheme of ['light', 'dark'] as const) {
    test(`desktop, ${scheme}`, async () => {
      test.setTimeout(90_000);
      await page.setViewportSize(DESKTOP);
      await page.emulateMedia({ colorScheme: scheme });

      // The editor, with the sidebar's folders open on the note's folder.
      await openNote(page, main);
      await expect(treeItem(page, SUBFOLDER)).toHaveAttribute('aria-expanded', 'true');
      await treeItem(page, MAIN).scrollIntoViewIfNeeded();
      await expect(page.locator('.hljs-keyword').first()).toBeVisible();
      await check(page, `${scheme} note`);
      // The sidebar's lower panes, scrolled into view (axe skips text its scroller clips).
      await page.getByTestId('calendar').scrollIntoViewIfNeeded();
      await check(page, `${scheme} sidebar calendar`);
      await page.getByTestId('tag-pane').scrollIntoViewIfNeeded();
      await check(page, `${scheme} sidebar tags`);

      // The slash menu, on a new line under the heading.
      await body(page).locator('h2', { hasText: 'Beds' }).click();
      await page.keyboard.press(LINE_END);
      await page.keyboard.press('Enter');
      await page.keyboard.type('/');
      const slash = page.getByRole('listbox', { name: 'Insert block' });
      await expect(slash).toBeVisible();
      await expectEditorDrivesMenu(page, slash);
      await check(page, `${scheme} slash menu`);
      await page.keyboard.press('Escape');
      await expect(slash).toBeHidden();
      await page.keyboard.press('Backspace');
      await page.keyboard.press('Backspace');

      // The selection toolbar and its Turn into menu.
      await body(page).locator('li', { hasText: 'Basil' }).click();
      await page.keyboard.press(LINE_END);
      await page.keyboard.press(SELECT_TO_LINE_START);
      const toolbar = page.getByRole('toolbar', { name: 'Format selection' });
      await expect(toolbar).toBeVisible();
      await check(page, `${scheme} formatting toolbar`);
      await page.keyboard.press(LINE_END);
      await expect(toolbar).toBeHidden();

      // The note it links to, with its backlinks.
      await openNote(page, target);
      await expect(page.getByTestId('note-view')).toContainText(MAIN);
      await check(page, `${scheme} backlinks`);

      // The version history panel, with a version's changes.
      await openNote(page, main);
      await page.getByTestId('note-tab-history').click();
      const panel = page.getByTestId('history-panel');
      await panel.getByRole('list', { name: 'Versions' }).getByRole('button').first().click();
      await expect(panel.getByTestId('history-diff')).toBeVisible();
      await check(page, `${scheme} version history`);
      // The side panel's other tabs (T51, A936): Comments and the Local Graph.
      await page.getByTestId('note-tab-comments').click();
      await expect(page.getByTestId('comments-panel')).toBeVisible();
      await check(page, `${scheme} comments tab`);
      await page.getByTestId('note-tab-graph').click();
      await expect(page.getByTestId('note-graph-count')).toHaveText('1 note · 1 link');
      await check(page, `${scheme} local graph tab`);
      // Back to Metadata, as the next pass expects (the tab is remembered).
      await page.getByTestId('note-tab-info').click();

      // Deleting a folder asks first.
      // From its menu: the row's hover buttons are New Note only (A1120).
      const folder = treeItem(page, SUBFOLDER);
      await folder.click({ button: 'right' });
      await page
        .getByRole('menu', { name: `Folder ${SUBFOLDER}` })
        .getByRole('menuitem', { name: 'Delete Folder…' })
        .click();
      const confirm = page.getByRole('dialog', { name: `Delete “${SUBFOLDER}”?` });
      await expect(confirm).toBeVisible();
      await check(page, `${scheme} delete folder`);
      await confirm.getByRole('button', { name: 'Cancel' }).click();
      await expect(confirm).toBeHidden();

      // Search, with results and a filter: this device's own index (T59: no server search).
      await page.keyboard.press(SEARCH);
      await expect(searchInput(page)).toBeFocused();
      await searchInput(page).fill(WORD);
      await expect(searchResults(page)).toHaveCount(2);
      await page.getByTestId('search').getByRole('combobox', { name: 'Tag' }).selectOption(TAG);
      await expect(searchResults(page)).toHaveCount(1);
      await check(page, `${scheme} search`);
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('search')).toBeHidden();

      // The command palette, the recent-notes switcher and the cheat sheet.
      await page.keyboard.press('ControlOrMeta+KeyK');
      const palette = page.getByRole('dialog', { name: 'Command Palette' });
      await expect(palette.getByRole('option').first()).toBeVisible();
      await check(page, `${scheme} palette`);
      await page.keyboard.press('Escape');
      await expect(palette).toBeHidden();
      await page.keyboard.down('ControlOrMeta');
      await page.keyboard.press('KeyE');
      const switcher = page.getByRole('dialog', { name: 'Recent notes' });
      await expect(switcher).toBeVisible();
      await check(page, `${scheme} recent notes`);
      await page.keyboard.press('Escape');
      await page.keyboard.up('ControlOrMeta');
      await expect(switcher).toBeHidden();
      await page.keyboard.press('ControlOrMeta+Slash');
      const cheat = page.getByRole('dialog', { name: 'Keyboard Shortcuts' });
      await expect(cheat).toBeVisible();
      await check(page, `${scheme} cheat sheet`);
      await page.keyboard.press('Escape');
      await expect(cheat).toBeHidden();

      // The graph, global and local.
      await page.goto('/graph');
      await expect(page.getByTestId('graph-canvas')).toBeVisible();
      await expect(page.getByTestId('graph-count')).toBeVisible();
      await check(page, `${scheme} graph`);
      await page.goto(`/graph?note=${main}&local=1`);
      await expect(page.getByTestId('graph-count')).toHaveText('2 notes · 1 link');
      await check(page, `${scheme} local graph`);

      // Trash, with a deleted note.
      await page.goto('/trash');
      await expect(page.getByTestId('trash')).toContainText(`Axe deleted ${RUN}`);
      await check(page, `${scheme} trash`);

      // Settings, every section the Mac app has with no server (T59).
      for (const path of [
        '/settings',
        '/settings/display',
        '/settings/symbols',
        '/settings/git-notebooks',
        '/settings/agents',
        '/settings/journal',
        '/settings/shortcuts',
      ]) {
        await settings(page, path);
        await check(page, `${scheme} ${path}`);
      }
      await gitNotebookPage(page);
      await check(page, `${scheme} a git notebook's page`);
      expect(errors).toEqual([]);
    });
  }

  for (const scheme of ['light', 'dark'] as const) {
    test(`phone, ${scheme}`, async () => {
      test.setTimeout(60_000);
      await page.setViewportSize(PHONE);
      await page.emulateMedia({ colorScheme: scheme });
      const appBar = page.getByTestId('app-bar');

      // The note, with the formatting bar.
      await openNote(page, main);
      await expect(page.getByRole('toolbar', { name: 'Formatting' })).toBeVisible();
      await check(page, `${scheme} phone note`);

      // The note's action sheet.
      await appBar.getByRole('button', { name: 'Note Actions' }).click();
      const sheet = page.getByRole('menu', { name: 'Note Actions' });
      await expect(sheet).toBeVisible();
      await check(page, `${scheme} phone note actions`);
      await page.keyboard.press('Escape');
      await expect(sheet).toBeHidden();

      // The drawer.
      await appBar.getByRole('button', { name: 'Open Navigation' }).click();
      await expect(page.getByRole('complementary', { name: 'Notes' })).toBeVisible();
      await check(page, `${scheme} phone drawer`);
      await page.getByRole('button', { name: 'Close Navigation' }).click();
      await expect(page.getByRole('complementary', { name: 'Notes' })).toBeHidden();

      // Search, from the app bar.
      await appBar.getByRole('button', { name: 'Search Notes' }).click();
      await expect(searchInput(page)).toBeFocused();
      await searchInput(page).fill(WORD);
      await expect(searchResults(page)).toHaveCount(2);
      await check(page, `${scheme} phone search`);
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('search')).toBeHidden();

      // The palette.
      await page.keyboard.press('ControlOrMeta+KeyK');
      const palette = page.getByRole('dialog', { name: 'Command Palette' });
      await expect(palette.getByRole('option').first()).toBeVisible();
      await check(page, `${scheme} phone palette`);
      await page.keyboard.press('Escape');
      await expect(palette).toBeHidden();

      // Settings, and the git notebook's card.
      for (const path of ['/settings', '/settings/appearance', '/settings/git-notebooks']) {
        await settings(page, path);
        await check(page, `${scheme} phone ${path}`);
      }
      await gitNotebookPage(page);
      await check(page, `${scheme} phone git notebook page`);
      expect(errors).toEqual([]);
    });
  }
});

/**
 * Controls fade their colours (120 ms), so right after a theme or mode changes they show a
 * blend of the old and new colours: measure once the transitions have finished.
 */
async function settled(page: Page) {
  await page.waitForFunction(() =>
    document.getAnimations().every((animation) => !(animation instanceof CSSTransition)),
  );
}

// T28: every built-in theme, light and dark, on a note (code, callout, highlight) and on
// Settings → Appearance. One note and one page for the 16 checks, each its own test.
test.describe.serial('no serious axe violations in every built-in theme', () => {
  let host: GitHost;
  let context: BrowserContext;
  let page: Page;
  let errors: string[];
  let id: string;

  test.beforeAll(async ({ browser }) => {
    ({ host, context, page } = await suiteMac(browser));
    errors = collectErrors(page);
    id = await newNote(page, `Axe themes ${RUN}`, NOTE_TEXT);
    await page.keyboard.press('Enter');
    await page.keyboard.type('> [!tip] Water ==early== with `cold` water.');
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    await page.keyboard.type('```ts');
    await page.keyboard.press('Enter');
    await page.keyboard.type("const beds = 4; // by the fence\nplant('tomato');");
    await expect(page.locator('.hljs-keyword').first()).toBeVisible();
    // Each check reloads the app: leave only once the notebook is stored and pushed.
    await synced(page);
  });

  test.afterAll(async () => {
    await context.close();
    await host.close();
  });

  for (const theme of BUILT_IN_THEMES) {
    for (const mode of ['Light', 'Dark'] as const) {
      test(`${theme.name}, ${mode.toLowerCase()}`, async () => {
        await page.goto('/settings/appearance');
        const settings = page.getByTestId('appearance-settings');
        await settings.locator(`label.theme-card[data-theme-id="${theme.id}"]`).click();
        await settings.getByTestId('theme-mode').getByText(mode).click();
        await expect(page.locator('html')).toHaveAttribute('data-theme', theme.id);
        await expect(page.locator('html')).toHaveAttribute('data-mode', mode.toLowerCase());
        await settled(page);
        expect(await seriousViolations(page), `${theme.id} ${mode} appearance`).toEqual([]);
        await page.goto(`/notes/${id}`);
        await expect(page.getByTestId('note-view')).toHaveAttribute('data-ready', 'true');
        await expect(page.locator('.hljs-keyword').first()).toBeVisible();
        await settled(page);
        expect(await seriousViolations(page), `${theme.id} ${mode} note`).toEqual([]);
        expect(errors).toEqual([]);
      });
    }
  }
});

test('icon buttons show their name and shortcut as a tooltip on hover and keyboard focus', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await newNote(page, `Tips ${RUN}`, 'Hover the header.');
  // The top bar's buttons (T42, A575): Full Width, Copy Agent Reference (no keys of its own),
  // ⋯; and the panel's tab icons down the note's edge (T53 item 9).
  const info = page.getByTestId('copy-agent-reference');
  const tooltip = page.getByTestId('tooltip');

  // A button with keys shows them after its name.
  await page.getByTestId('note-tab-history').hover();
  await expect(tooltip).toHaveText(/^History \(.+\)$/);
  // The strip's tooltips stay inside the window, at its right edge.
  const strip = (await tooltip.boundingBox())!;
  expect(strip.x + strip.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  await page.mouse.move(0, 0);
  await expect(tooltip).toBeHidden();

  await info.hover();
  await expect(tooltip).toHaveText('Copy Agent Reference');
  // Below the button, inside the window.
  const button = (await info.boundingBox())!;
  const tip = (await tooltip.boundingBox())!;
  expect(tip.y).toBeGreaterThan(button.y + button.height);
  expect(tip.x + tip.width).toBeLessThanOrEqual(page.viewportSize()!.width);
  await page.mouse.move(0, 0);
  await page.getByTestId('note-title').hover();
  await expect(tooltip).toBeHidden();

  // The rightmost button's tooltip stays inside the window.
  await page.getByTestId('note-menu').hover();
  await expect(tooltip).toHaveText('Note Actions');
  const edge = (await tooltip.boundingBox())!;
  expect(edge.x + edge.width).toBeLessThanOrEqual(page.viewportSize()!.width);

  // Keyboard focus shows it at once; Escape hides it.
  await page.mouse.move(0, 0);
  await info.focus();
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Tab');
  await expect(info).toBeFocused();
  await expect(tooltip).toHaveText('Copy Agent Reference');
  await page.keyboard.press('Escape');
  await expect(tooltip).toBeHidden();
  // The tooltip repeats the accessible name: assistive technology does not read it twice.
  await expect(info).toHaveAccessibleName('Copy Agent Reference');
  expect(errors).toEqual([]);
});
