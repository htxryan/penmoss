import type { Locator, Page } from '@playwright/test';

/**
 * A notebook's action on its name's row (T53 item 4): New Note, the sort order, New Folder or
 * Trash. They show while the pointer is over the row, so this hovers it first. `scope` narrows
 * to one notebook's section when there are several.
 */
export async function notebookAction(
  page: Page,
  name: string | RegExp,
  { role = 'button', scope }: { role?: 'button' | 'link'; scope?: Locator } = {},
): Promise<Locator> {
  const head = (scope ?? page.locator('#app-sidebar'))
    .locator('.sb-section-head:has(.tree-actions)')
    .first();
  // In view first: a click that scrolled the sidebar after the hover would leave the pointer
  // off the row, and its actions hidden again.
  await head.scrollIntoViewIfNeeded();
  await head.hover();
  return head.locator('.tree-actions').getByRole(role, { name, exact: typeof name === 'string' });
}
