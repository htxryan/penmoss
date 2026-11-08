import type { Page } from '@playwright/test';

/**
 * Runs one of the open note's actions from the top bar's ⋯ menu (T42, A575; three groups since
 * T51, A937): Markdown Source (`toggle-markdown`), Pin to Quick Access (`pin-quick-access`),
 * Open in New Window (`open-in-window`) and Move to Trash (`delete-note`). The panel's tabs are
 * the strip's (`note-tab-info`, `-comments`, `-history`, `-graph`), not the menu's (A991).
 */
export async function noteAction(page: Page, item: string): Promise<void> {
  await page.getByTestId('note-menu').click();
  await page.getByTestId(item).click();
}
