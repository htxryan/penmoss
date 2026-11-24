// Quick Access: pins, its menu, its order, and No notes.
import { expect, type Page, test } from './fixtures';
import { collectErrors, newNote } from './support/app';
import { menuLayout, noteAction } from './note-menu';
import { storedSetting } from './stored';

const RUN = `h${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
// T53, item 10.
test('Quick Access removes from its menu, reorders, and names the notebook when asked', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/');
  const a = await newNote(page, `Pin A ${RUN}`, 'A.');
  await noteAction(page, 'pin-quick-access');
  const b = await newNote(page, `Pin B ${RUN}`, 'B.');
  await noteAction(page, 'pin-quick-access');
  const pins = page.getByTestId('quick-access').getByTestId('quick-access-note');
  const ids = () =>
    pins.evaluateAll((links) =>
      links.map((link) => link.getAttribute('data-note-id')).filter((id) => id !== null),
    );
  await expect.poll(async () => (await ids()).slice(-2)).toEqual([a, b]);

  // Alt+↑ moves the focused pin up.
  await page.getByTestId('quick-access').locator(`[data-note-id="${b}"]`).focus();
  await page.keyboard.press('Alt+ArrowUp');
  await expect.poll(async () => (await ids()).slice(-2)).toEqual([b, a]);

  // Settings → Sidebar: each pin's notebook under its title.
  await page.goto('/settings/sidebar');
  await expect(page.getByTestId('quick-access-notebook')).not.toBeChecked();
  await page.getByTestId('quick-access-notebook').check();
  await expect.poll(() => storedSetting(page, 'quickAccess.showNotebook')).toBe(true);
  await page.goBack();
  // The git notebook's name.
  await expect(
    page.getByTestId('quick-access').locator(`[data-note-id="${a}"] .sb-item-notebook`),
  ).toHaveText('Notes');

  // Right-click: the open group leads, as on the tree's notes (A1571), then Remove from Quick
  // Access, for both.
  for (const id of [a, b]) {
    await page
      .getByTestId('quick-access')
      .locator(`[data-note-id="${id}"]`)
      .click({ button: 'right' });
    expect(await menuLayout(page.getByRole('menu'))).toEqual([
      'quick-access-open-tab',
      'quick-access-open-window',
      '—',
      'quick-access-remove',
    ]);
    await page.getByTestId('quick-access-remove').click();
    await expect(page.locator(`[data-testid="quick-access"] [data-note-id="${id}"]`)).toHaveCount(
      0,
    );
  }
  await page.goto('/settings/sidebar');
  await expect(page.getByTestId('quick-access-notebook')).toBeChecked();
  await page.getByTestId('quick-access-notebook').uncheck();
  await expect.poll(() => storedSetting(page, 'quickAccess.showNotebook')).toBe(false);
  expect(errors).toEqual([]);
});
// T53, items 10, follow-up.
test('Quick Access shows with no pins; a note dragged in from Notebooks or Recent Notes is pinned', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/');
  const section = page.getByTestId('quick-access');
  const pins = section.getByTestId('quick-access-note');
  const ids = () =>
    pins.evaluateAll((links) =>
      links.map((link) => link.getAttribute('data-note-id')).filter((id) => id !== null),
    );
  const unpinAll = async () => {
    // One at a time: a second Remove on a pin still showing would pin it again.
    for (let left = await pins.count(); left > 0; left -= 1) {
      await pins.first().click({ button: 'right' });
      await page.getByTestId('quick-access-remove').click();
      await expect(pins).toHaveCount(left - 1);
    }
  };
  // Recent Notes shows for the drag from it (a new notebook hides no section).
  await expect(page.getByTestId('sidebar-section-recent')).toBeVisible();
  const a = await newNote(page, `Drag Pin A ${RUN}`, 'A.');
  const b = await newNote(page, `Drag Pin B ${RUN}`, 'B.');
  // Other runs' pins may show late, as the note list comes in: only the end of the list is ours.
  const last = async (count: number) => (await ids()).slice(-count);

  // A note from Notebooks, dropped on the section's title: pinned, last.
  const treeRow = page.locator(`[role="treeitem"][data-key="note:${a}"]`);
  await treeRow.scrollIntoViewIfNeeded();
  await treeRow.dragTo(section.locator('.sb-section-head'));
  await expect.poll(() => last(1)).toEqual([a]);
  await expect
    .poll(
      async () => (((await storedSetting(page, 'quickAccess.notes')) ?? []) as string[]).slice(-1),
      { timeout: 15_000 },
    )
    .toEqual([a]);
  // Pinned, not moved: it is still in its notebook.
  await expect(treeRow).toBeVisible();

  // A note from Recent Notes, dropped on the top half of a pin: pinned before it.
  const recent = page.locator(`[data-testid="recent-note"][data-note-id="${b}"]`);
  const target = section.locator(`[data-note-id="${a}"]`);
  await recent.dragTo(target, { targetPosition: { x: 20, y: 3 } });
  await expect.poll(() => last(2)).toEqual([b, a]);

  // A pinned note dropped again moves, never twice.
  await treeRow.dragTo(section.locator(`[data-note-id="${b}"]`), {
    targetPosition: { x: 20, y: 3 },
  });
  await expect.poll(() => last(2)).toEqual([a, b]);
  expect((await ids()).filter((id) => id === a)).toHaveLength(1);

  // With nothing pinned the section still shows, quietly asking for a note.
  await unpinAll();
  await expect(section).toBeVisible();
  await expect(section.getByTestId('quick-access-empty')).toBeVisible();
  await expect
    .poll(async () => ((await storedSetting(page, 'quickAccess.notes')) ?? []) as string[], {
      timeout: 15_000,
    })
    .not.toContain(a);
  expect(errors).toEqual([]);
});

const SHOTS = process.env['PENMOSS_EVIDENCE'];

const section = (page: Page, name: string) =>
  page.getByTestId('source-section').and(page.getByRole('region', { name, exact: true }));

const tree = (page: Page, name: string) =>
  section(page, name).getByRole('tree', { name: 'Folders and notes' });

type Edges = { left: number; right: number; top: number; bottom: number };

const edges = (page: Page, selector: string): Promise<Edges> =>
  page
    .locator(selector)
    .first()
    .evaluate((element) => {
      const b = element.getBoundingClientRect();
      return { left: b.left, right: b.right, top: b.top, bottom: b.bottom };
    });
test.describe('in Quanta, with a folder and two notes', () => {
  test.use({
    seed: {
      name: 'Quanta',
      folders: ['Substation'],
      notes: [{ title: 'Alpha' }, { title: 'Beta' }],
    },
  });

  // Ryan’s feedback of 6 Nov 2026 (Personal), items 1, 4.
  test('a note’s menu pins it to Quick Access and unpins it; an open, empty Quick Access says No notes', async ({
    page,
  }) => {
    const errors = collectErrors(page);
    await page.setViewportSize({ width: 1280, height: 860 });
    await page.goto('/');
    const quick = page.getByTestId('quick-access');
    // 4: open and empty, quiet words centred in its panel, not a gap.
    const none = quick.getByTestId('quick-access-none');
    await expect(none).toHaveText('No notes');
    expect(await none.evaluate((element) => getComputedStyle(element).textAlign)).toBe('center');
    const panel = await edges(page, '[data-testid="quick-access"]');
    const words = await none.evaluate((element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      const b = range.getBoundingClientRect();
      return { left: b.left, right: b.right };
    });
    expect(Math.abs(words.left - panel.left - (panel.right - words.right))).toBeLessThan(2);
    if (SHOTS) await quick.screenshot({ path: `${SHOTS}/quick-access-empty.png` });
    // Collapsed, it is its title row alone.
    await quick.getByRole('button', { name: 'Quick Access', exact: true }).click();
    await expect(none).toHaveCount(0);
    await quick.getByRole('button', { name: 'Quick Access', exact: true }).click();

    // 1: Pin to Quick Access from the note's own menu in the tree.
    const alpha = tree(page, 'Quanta').getByRole('link', { name: 'Alpha', exact: true });
    await alpha.click({ button: 'right' });
    const pin = page.getByTestId('note-menu-quick-access');
    await expect(pin).toHaveText('Pin to Quick Access');
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/note-menu-pin.png` });
    await pin.click();
    await expect(page.getByRole('menu')).toHaveCount(0);
    await expect(quick.getByTestId('quick-access-note')).toHaveText(['Alpha']);
    await expect(none).toHaveCount(0);
    await expect
      .poll(async () => (await storedSetting(page, 'quickAccess.notes')) as unknown[])
      .toHaveLength(1);

    // Pinned, the same item unpins it.
    await alpha.click({ button: 'right' });
    await expect(pin).toHaveText('Unpin from Quick Access');
    await pin.click();
    await expect(quick.getByTestId('quick-access-note')).toHaveCount(0);
    await expect(none).toBeVisible();
    expect(errors).toEqual([]);
  });
});

// Quanta feedback (PEN-182): the collapsed sidebar's pin opens the pinned notes beside the rail.
test('the rail’s Quick Access opens its pinned notes beside the rail, and one opens', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/');
  const a = await newNote(page, `Rail Pin A ${RUN}`, 'A.');
  await noteAction(page, 'pin-quick-access');
  await newNote(page, `Rail Pin B ${RUN}`, 'B.');
  // Not on the open sidebar: Quick Access is its section there.
  await expect(page.getByTestId('quick-access-flyout')).toHaveCount(0);
  await page.getByTestId('toggle-sidebar').click();
  await expect(page.getByTestId('app-root')).toHaveAttribute('data-sidebar', 'collapsed');
  const pin = page.getByTestId('quick-access-flyout');
  await expect(pin).toHaveAccessibleName('Quick Access');
  await pin.click();
  const menu = page.getByRole('menu', { name: 'Quick Access' });
  await expect(menu.locator(`[data-note-id="${a}"]`)).toHaveText(`Rail Pin A ${RUN}`);
  // Beside the rail, level with the pin, inside the window.
  const [pinBox, menuBox, rail] = await Promise.all([
    pin.boundingBox(),
    menu.boundingBox(),
    page.locator('#app-sidebar').boundingBox(),
  ]);
  expect(menuBox!.x).toBeGreaterThanOrEqual(rail!.x + rail!.width);
  // Once its rise has finished (pm-rise).
  await expect
    .poll(async () => Math.abs((await menu.boundingBox())!.y - pinBox!.y))
    .toBeLessThanOrEqual(1);
  expect(menuBox!.x + menuBox!.width).toBeLessThanOrEqual(1280);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/quick-access-rail.png` });
  // Escape closes it, focus back on the pin.
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await expect(pin).toBeFocused();
  // Choosing a note opens it.
  await pin.click();
  await menu.locator(`[data-note-id="${a}"]`).click();
  await expect(menu).toBeHidden();
  await expect(page).toHaveURL(new RegExp(a));
  await expect(page.getByTestId('app-root')).toHaveAttribute('data-sidebar', 'collapsed');
  expect(errors).toEqual([]);
});
