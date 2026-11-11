import { expect, test, type Locator, type Page } from '@playwright/test';
import {
  body,
  gitNotebook,
  go,
  launch,
  mainBounds,
  notebookSection,
  removeDataDirs,
  ULID,
  type Launched,
} from './support';

// PEN-63 in the Mac app: with two git notebooks, Move to Notebook… reports “Moved 1 note to
// “Personal”.” in a toast at the bottom centre of the main window, not in the sidebar, drawn on
// the theme's raised surface, light and dark. The web suite's toasts.spec.ts covers the rest.

const opened: Launched[] = [];
const RUN = `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
const MOVED = 'Moved 1 note to “Personal”.';

test.afterEach(async () => {
  for (const { app } of opened.splice(0)) await app.close().catch(() => undefined);
});
test.afterAll(() => removeDataDirs());

/** A notebook's action on its name's row, shown while the pointer is over the row. */
async function action(section: Locator, name: string): Promise<Locator> {
  const head = section.locator('.sb-section-head:has(.tree-actions)').first();
  await head.scrollIntoViewIfNeeded();
  await head.hover();
  return head.locator('.tree-actions').getByRole('button', { name, exact: true });
}

async function newNote(page: Page, notebook: string, title: string): Promise<void> {
  await (await action(notebookSection(page, notebook), 'New Note in This Notebook')).click();
  await expect(page).toHaveURL(ULID);
  await expect(page.getByTestId('note-title')).toBeFocused();
  await page.keyboard.type(title);
  await page.keyboard.press('Enter');
  await page.keyboard.type('Moss on the north side.');
  await expect(body(page)).toContainText('Moss on the north side.');
}

/** Move to Notebook… from the note's row, into Personal's top level. */
async function moveToPersonal(page: Page, title: string): Promise<void> {
  const row = notebookSection(page, 'Work').getByRole('treeitem', { name: title, exact: true });
  await row.click({ button: 'right' });
  await page.getByTestId('menu-move-to-notebook').click();
  const picker = page.getByTestId('folder-picker');
  await expect(picker).toBeVisible();
  await picker.getByRole('combobox').fill('Personal');
  await picker.getByRole('combobox').press('Enter');
  await expect(picker).toBeHidden();
  await expect(
    notebookSection(page, 'Personal').getByRole('treeitem', { name: title, exact: true }),
  ).toBeVisible();
}

/** A theme token as the page computes it. */
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

/** The toast sits at the bottom centre of the window, outside the sidebar, in the theme. */
async function expectToast(page: Page, toast: Locator): Promise<string> {
  await expect(toast).toHaveText(MOVED);
  await page.waitForFunction(() =>
    document
      .getAnimations()
      .every(
        (animation) => !(animation instanceof CSSAnimation || animation instanceof CSSTransition),
      ),
  );
  const seen = await toast.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const stack = element.closest('.toast-stack')!.getBoundingClientRect();
    const bar = document.querySelector('.status-bar')?.getBoundingClientRect() ?? null;
    const style = getComputedStyle(element);
    return {
      centre: rect.left + rect.width / 2,
      foot: stack.bottom,
      width: window.innerWidth,
      height: window.innerHeight,
      bar: bar ? bar.height : 0,
      inSidebar: element.closest('.sidebar') !== null,
      background: style.backgroundColor,
      border: style.borderTopColor,
      colour: style.color,
      glyph: getComputedStyle(element.querySelector('.toast-glyph')!).color,
    };
  });
  expect(seen.inSidebar).toBe(false);
  expect(Math.abs(seen.centre - seen.width / 2)).toBeLessThanOrEqual(2);
  expect(Math.abs(seen.height - seen.foot - (20 + seen.bar))).toBeLessThanOrEqual(2);
  expect(seen.background).toBe(await token(page, '--pm-raised', 'background-color'));
  expect(seen.border).toBe(await token(page, '--pm-border-strong', 'color'));
  expect(seen.colour).toBe(await token(page, '--pm-fg', 'color'));
  expect(seen.glyph).toBe(await token(page, '--pm-accent', 'color'));
  await expect(page.locator('.sidebar .toast')).toHaveCount(0);
  return seen.background;
}

test('Move to Notebook… reports in a toast at the bottom centre of the window, light and dark', async () => {
  test.setTimeout(240_000);
  const launched = await launch();
  opened.push(launched);
  const { page, errors } = launched;
  await mainBounds(launched.app, { x: 0, y: 0, width: 1280, height: 720 });
  await gitNotebook(launched, 'Work');
  await gitNotebook(launched, 'Personal');

  // Light.
  await go(page, '/settings/appearance');
  await page.getByTestId('theme-mode').getByText('Light').click();
  await expect(page.locator('html')).toHaveAttribute('data-mode', 'light');
  await go(page, '/');
  const first = `Moss walk ${RUN}`;
  await newNote(page, 'Work', first);
  await moveToPersonal(page, first);
  const toast = page.getByTestId('tree-message');
  const light = await expectToast(page, toast);
  await page.waitForTimeout(2000);

  // Dark: the dark theme's raised surface.
  await go(page, '/settings/appearance');
  await page.getByTestId('theme-mode').getByText('Dark').click();
  await expect(page.locator('html')).toHaveAttribute('data-mode', 'dark');
  await go(page, '/');
  const second = `Moss path ${RUN}`;
  await newNote(page, 'Work', second);
  await moveToPersonal(page, second);
  const dark = await expectToast(page, toast);
  expect(dark).not.toBe(light);
  await page.waitForTimeout(2000);
  await expect(toast).toBeVisible();
  expect(errors).toEqual([]);
});
