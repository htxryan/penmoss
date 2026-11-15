// A note’s ⋯ menu.
import { expect, type Page, test } from './fixtures';
import { collectErrors, newNote, ULID } from './support/app';

const RUN = `g${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
// T42, item 6.
test('the note’s actions are in one ⋯ menu; Full width and Copy Agent Reference stay on the bar', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await newNote(page, `Menu ${RUN}`, 'Text for the menu.');
  // At the tab strip's end since PEN-140 (A1505), the main window having no title row.
  const bar = page.locator('.tab-strip-end .note-actions');
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

const section = (page: Page, name: string) =>
  page.getByTestId('source-section').and(page.getByRole('region', { name, exact: true }));

const tree = (page: Page, name: string) =>
  section(page, name).getByRole('tree', { name: 'Folders and notes' });

async function openNote(page: Page, notebook: string, title: string): Promise<string> {
  await tree(page, notebook).getByRole('link', { name: title, exact: true }).click();
  await expect(page).toHaveURL(ULID);
  await expect(page.getByTestId('note-title')).toHaveValue(title);
  return ULID.exec(new URL(page.url()).pathname)![1]!;
}
test.describe('in Quanta, with two folders and two notes', () => {
  test.use({
    seed: {
      name: 'Quanta',
      folders: ['Substation', 'Geotech'],
      notes: [{ title: 'Alpha' }, { title: 'Penmoss Feedback' }],
    },
  });

  // Ryan’s feedback of 5 Nov 2026 (Personal), item 13.
  test('Rename in a note’s menu edits its title in its row; Escape leaves it as it was', async ({
    page,
  }) => {
    const errors = collectErrors(page);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto('/');
    const quanta = tree(page, 'Quanta');
    await quanta.getByRole('treeitem', { name: 'Penmoss Feedback', exact: true }).click({
      button: 'right',
    });
    await page.getByTestId('note-menu-rename').click();
    const field = page.getByRole('textbox', { name: 'Rename note Penmoss Feedback' });
    await expect(field).toBeFocused();
    await field.fill('Feedback, renamed');
    await page.keyboard.press('Enter');
    await expect(
      quanta.getByRole('treeitem', { name: 'Feedback, renamed', exact: true }),
    ).toBeVisible();
    await openNote(page, 'Quanta', 'Feedback, renamed');
    // Escape leaves a title as it was.
    await quanta.getByRole('treeitem', { name: 'Alpha', exact: true }).click({ button: 'right' });
    await page.getByTestId('note-menu-rename').click();
    await page.keyboard.type('Nope');
    await page.keyboard.press('Escape');
    await expect(quanta.getByRole('treeitem', { name: 'Alpha', exact: true })).toBeVisible();
    expect(errors).toEqual([]);
  });
});
