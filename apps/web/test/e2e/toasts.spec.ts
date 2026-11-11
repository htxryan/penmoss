import { expect, test, type Locator, type Page } from './fixtures';
import { NEW_FOLDER } from './keys';
import { noteAction } from './note-menu';
import { notebookAction } from './notebook-actions';

// PEN-63: every toast shows in one stack at the bottom centre of the window, drawn on the
// theme's raised surface with its border, text and glyph colours, light or dark, in any theme.
// The sidebar's own message line is gone: a tree action's result is a toast too.

test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

const ULID = /\/notes\/([0-9A-HJKMNP-TV-Z]{26})$/;
const RUN = `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
/** How long the proof video holds on each state. */
const HOLD = 2000;

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(error.message));
  return errors;
}

const treeOf = (page: Page) => page.getByRole('tree', { name: 'Folders and notes' });
const item = (page: Page, name: string) =>
  treeOf(page).getByRole('treeitem', { name, exact: true });
const stack = (page: Page) => page.getByTestId('toast-stack');

async function newFolder(page: Page, name: string, via: 'button' | 'shortcut') {
  if (via === 'button') await (await notebookAction(page, 'New Folder')).click();
  else await page.keyboard.press(NEW_FOLDER);
  const input = page.getByRole('textbox', { name: 'New folder name' });
  await expect(input).toBeFocused();
  await input.fill(name);
  await input.press('Enter');
  const row = item(page, name);
  await expect(row).toBeFocused();
  return row;
}

async function newNote(page: Page, title: string) {
  await page
    .getByTestId('sidebar-shortcuts')
    .getByRole('button', { name: 'New Note', exact: true })
    .click();
  await expect(page).toHaveURL(ULID);
  await expect(page.getByTestId('note-title')).toBeFocused();
  await page.keyboard.type(title);
  await page.keyboard.press('Enter');
  await expect(item(page, title)).toBeVisible();
  await expect(page.getByTestId('note-view')).toHaveAttribute('data-ready', 'true');
}

/** Both rows fully in the sidebar's view before a drag (as folders.spec.ts does). */
async function inView(source: Locator, target: Locator) {
  for (const row of [target, source, target]) {
    await row.evaluate((element) => element.scrollIntoView({ block: 'center' }));
    await expect(row).toBeInViewport({ ratio: 1 });
  }
  await expect(source).toBeInViewport({ ratio: 1 });
}

/** A theme token as the browser computes it, in the form a toast's own style reads. */
async function token(page: Page, name: string, property: 'color' | 'background-color') {
  return page.evaluate(
    ({ name, property }) => {
      const probe = document.createElement('div');
      probe.style.setProperty(property, `var(${name})`);
      document.body.append(probe);
      const value = getComputedStyle(probe).getPropertyValue(property);
      probe.remove();
      return value;
    },
    { name, property },
  );
}

/** What a toast is drawn with. */
async function look(toast: Locator) {
  return toast.evaluate((element) => {
    const style = getComputedStyle(element);
    const glyph = element.querySelector('.toast-glyph');
    return {
      background: style.backgroundColor,
      border: style.borderTopColor,
      borderWidth: style.borderTopWidth,
      colour: style.color,
      radius: style.borderTopLeftRadius,
      glyph: glyph ? getComputedStyle(glyph).color : null,
      glyphIcon: glyph?.getAttribute('data-icon') ?? null,
      inSidebar: element.closest('.sidebar') !== null,
    };
  });
}

/** Controls fade their colours after a theme or mode change: measure once they have. */
async function settled(page: Page) {
  await page.waitForFunction(() =>
    document.getAnimations().every((animation) => !(animation instanceof CSSTransition)),
  );
}

/** Checks `toast` against the theme's raised surface, strong border, text and `glyph` colour. */
async function expectThemed(page: Page, toast: Locator, glyph: '--pm-accent' | '--pm-danger') {
  await settled(page);
  const seen = await look(toast);
  expect(seen.background).toBe(await token(page, '--pm-raised', 'background-color'));
  expect(seen.border).toBe(await token(page, '--pm-border-strong', 'color'));
  expect(seen.borderWidth).toBe('1px');
  expect(seen.colour).toBe(await token(page, '--pm-fg', 'color'));
  expect(seen.radius).toBe('0px');
  expect(seen.glyph).toBe(await token(page, glyph, 'color'));
  expect(seen.glyphIcon).toBe(glyph === '--pm-accent' ? 'check' : 'warning');
  expect(seen.inSidebar).toBe(false);
  return seen;
}

/** The stack's box: centred on the window, its foot `above` px from the bottom edge. */
async function expectPlaced(page: Page, toast: Locator, above: number) {
  await page.waitForFunction(() =>
    document.getAnimations().every((animation) => !(animation instanceof CSSAnimation)),
  );
  const viewport = page.viewportSize()!;
  const box = (await toast.boundingBox())!;
  expect(Math.abs(box.x + box.width / 2 - viewport.width / 2)).toBeLessThanOrEqual(2);
  const foot = await stack(page).evaluate((element) => element.getBoundingClientRect().bottom);
  expect(Math.abs(viewport.height - foot - above)).toBeLessThanOrEqual(2);
  expect(box.x).toBeGreaterThanOrEqual(16 - 0.5);
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width - 16 + 0.5);
}

async function shot(page: Page, name: string) {
  await page.screenshot({ path: test.info().outputPath(`${name}.png`) });
}

test('toasts sit at the bottom centre of the window, in the theme’s colours, stacked', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const errors = collectErrors(page);
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'no-preference' });
  await page.goto('/');
  await expect(treeOf(page)).toBeVisible();

  // A folder with a subfolder and a note in it.
  await page.getByTestId('tree-root-drop').click();
  const outer = await newFolder(page, `Outer ${RUN}`, 'button');
  const inner = await newFolder(page, `Inner ${RUN}`, 'shortcut');
  const title = `Toast note ${RUN}`;
  await newNote(page, title);

  // AC1: Copy Agent Reference from the note's row reports in a toast, not in the sidebar.
  await item(page, title).click({ button: 'right' });
  await page
    .getByRole('menu', { name: `“${title}”` })
    .getByRole('menuitem', { name: 'Copy Agent Reference' })
    .click();
  const copied = page.getByTestId('tree-message');
  await expect(copied).toHaveText('Copied Agent Reference');
  await expect(page.locator('.sidebar .toast')).toHaveCount(0);
  // 20 px above the status bar while it shows.
  const statusBar = await page.getByTestId('status-bar').boundingBox();
  if (!statusBar) throw new Error('The status bar is not showing');
  await expectPlaced(page, copied, 20 + statusBar.height);
  await expect(stack(page)).toHaveAttribute('role', 'status');
  // AC2/AC8: the light theme's raised surface, with a check in the accent.
  const light = await expectThemed(page, copied, '--pm-accent');
  await page.waitForTimeout(HOLD);
  await shot(page, 'toast-light');

  // AC2: dark mode draws it from the dark theme's tokens.
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('html')).toHaveAttribute('data-mode', 'dark');
  const dark = await expectThemed(page, copied, '--pm-accent');
  expect(dark.background).not.toBe(light.background);
  await page.waitForTimeout(HOLD);
  await shot(page, 'toast-dark');
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(page.locator('html')).toHaveAttribute('data-mode', 'light');

  // AC8: a refused drag (a folder into its own subfolder) leads with the warning in danger.
  await inView(outer, inner);
  await outer.dragTo(inner);
  const refused = page.getByTestId('tree-message');
  await expect(refused).toHaveText('A folder cannot move into itself or one of its subfolders.');
  await expectThemed(page, refused, '--pm-danger');
  // AC9: a toast with no controls lets the pointer through to what is under it.
  const box = (await refused.boundingBox())!;
  const hit = await page.evaluate(
    ({ x, y }) => document.elementFromPoint(x, y)?.closest('.toast-stack') !== null,
    { x: box.x + box.width / 2, y: box.y + box.height / 2 },
  );
  expect(hit, 'the toast takes the pointer').toBe(false);

  // AC7: Copy from the note's bar, then Move to Trash: they stack, newest at the bottom.
  await page.getByTestId('copy-agent-reference').click();
  await expect(page.getByTestId('copy-status')).toHaveText('Copied Agent Reference');
  await noteAction(page, 'delete-note');
  const trashed = page.getByTestId('trashed-toast');
  await expect(trashed).toContainText(`Moved “${title}” to Trash`);
  // Measured once each has risen into place.
  await page.waitForFunction(() =>
    document.getAnimations().every((animation) => !(animation instanceof CSSAnimation)),
  );
  const toasts = stack(page).locator('.toast');
  const boxes = await toasts.evaluateAll((elements) =>
    elements.map((element) => {
      const rect = element.getBoundingClientRect();
      return { top: rect.top, bottom: rect.bottom, testId: element.getAttribute('data-testid') };
    }),
  );
  expect(boxes.length).toBeGreaterThanOrEqual(2);
  expect(boxes.length).toBeLessThanOrEqual(3);
  expect(boxes.at(-1)!.testId).toBe('trashed-toast');
  for (let index = 1; index < boxes.length; index++) {
    const gap = boxes[index]!.top - boxes[index - 1]!.bottom;
    expect(Math.abs(gap - 8), `gap ${index}`).toBeLessThanOrEqual(1);
  }
  // The toast with controls takes the pointer; its Undo has focus (A524).
  await expect(trashed.getByRole('button', { name: 'Undo' })).toBeFocused();
  await page.waitForTimeout(HOLD);
  await shot(page, 'toast-stack');

  // AC4: at a phone's width, 72 px above the bottom edge, 16 px or more from each side.
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(trashed).toBeVisible();
  await expectPlaced(page, trashed, 72);
  await page.waitForTimeout(HOLD);
  await shot(page, 'toast-phone');
  await page.setViewportSize({ width: 1280, height: 720 });

  // Undo brings the note back.
  await trashed.getByRole('button', { name: 'Undo' }).click();
  await expect(page).toHaveURL(ULID);
  await expect(trashed).toBeHidden();

  // AC3: in another theme (Slate), its own raised, border, text and accent colours.
  await page.goto('/settings/appearance');
  const settings = page.getByTestId('appearance-settings');
  await settings.locator('label.theme-card[data-theme-id="slate"]').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'slate');
  await page.goBack();
  await expect(item(page, title)).toBeVisible();
  await item(page, title).click({ button: 'right' });
  await page
    .getByRole('menu', { name: `“${title}”` })
    .getByRole('menuitem', { name: 'Copy Agent Reference' })
    .click();
  await expect(copied).toHaveText('Copied Agent Reference');
  const slate = await expectThemed(page, copied, '--pm-accent');
  expect(slate.background).not.toBe(dark.background);
  await page.waitForTimeout(HOLD);
  await shot(page, 'toast-slate');
  await expect(copied).toBeVisible();
  expect(errors).toEqual([]);
});

test('with reduced motion a toast shows and goes without moving', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await expect(treeOf(page)).toBeVisible();
  const title = `Still ${RUN}`;
  await newNote(page, title);
  await page.getByTestId('copy-agent-reference').click();
  const toast = page.getByTestId('copy-status');
  await expect(toast).toBeVisible();
  // AC10: no animation, and announced through the stack's one status region.
  expect(await toast.evaluate((element) => getComputedStyle(element).animationName)).toBe('none');
  await expect(page.locator('[role="status"]:has([data-testid="copy-status"])')).toHaveCount(1);
  await expect(toast).toBeHidden();
});
