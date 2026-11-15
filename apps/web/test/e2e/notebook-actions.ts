import type { Locator, Page } from '@playwright/test';

/** A notebook's row in the sidebar: the first, or the one in `scope`. */
const notebookRow = async (page: Page, scope?: Locator): Promise<Locator> => {
  const head = (scope ?? page.locator('#app-sidebar'))
    .locator('.sb-section-head:has(.tree-actions)')
    .first();
  // In view first: a click that scrolled the sidebar after the hover would leave the pointer
  // off the row, and its actions hidden again.
  await head.scrollIntoViewIfNeeded();
  await head.hover();
  return head;
};

/**
 * A notebook's button on its name's row (T53 item 4): New Note, New Folder or ⋯ (More Notebook
 * Actions). They show while the pointer is over the row, so this hovers it first. `scope`
 * narrows to one notebook's section when there are several. Sort Order…, Time Machine, Trash
 * and Rename… are in ⋯: `notebookMenuItem`.
 */
export async function notebookAction(
  page: Page,
  name: string | RegExp,
  { role = 'button', scope }: { role?: 'button' | 'link'; scope?: Locator } = {},
): Promise<Locator> {
  const head = await notebookRow(page, scope);
  return head.locator('.tree-actions').getByRole(role, { name, exact: typeof name === 'string' });
}

/**
 * An item of a notebook row's ⋯ menu, More Notebook Actions (R2-21): Rename…, Sort Order…, Time
 * Machine or Trash. Hovers the row and opens ⋯ first.
 */
export async function notebookMenuItem(
  page: Page,
  name: string | RegExp,
  { scope }: { scope?: Locator } = {},
): Promise<Locator> {
  const head = await notebookRow(page, scope);
  await head.getByRole('button', { name: 'More Notebook Actions', exact: true }).click();
  return page
    .getByRole('menu', { name: 'More Notebook Actions', exact: true })
    .getByRole('menuitem', { name, exact: typeof name === 'string' });
}
