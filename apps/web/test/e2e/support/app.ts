/**
 * Helpers most specs share (web.md 4.3): the page's errors, a note's id from its URL, the note's
 * editor, and a new note made from the keyboard. A spec keeps its own only where it differs.
 */
import { expect, type Page } from '@playwright/test';
import { NEW_NOTE } from '../keys';

/** A note's page: its id in the path. */
export const ULID = /\/notes\/([0-9A-HJKMNP-TV-Z]{26})$/;

/**
 * Every error the page logs or throws, for a test to expect none of at its end. `expected`: the
 * console errors a test brings about on purpose (a refused socket, a fetch while offline).
 */
export function collectErrors(page: Page, expected?: RegExp): string[] {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error' && !expected?.test(message.text())) {
      errors.push(message.text());
    }
  });
  page.on('pageerror', (error) => errors.push(error.message));
  return errors;
}

/**
 * Holds the page still for `ms` while the proof records its video (`PENMOSS_PROOF=1`, `task
 * proof:web`, the factory's F5), so a state shows long enough to see; no wait otherwise (A1528).
 * Never for a test's own timing: a check that nothing happens in a time waits on its own.
 */
export async function holdForProof(page: Page, ms: number): Promise<void> {
  if (process.env['PENMOSS_PROOF'] === '1') await page.waitForTimeout(ms);
}

/** The open note's editor. */
export const body = (page: Page) => page.getByTestId('note-body').locator('.ProseMirror');

/**
 * A new note from the New Note key, once the app has drawn its New Note button: its title, then
 * `text` in its body. Returns its id.
 */
export async function newNote(page: Page, title: string, text: string): Promise<string> {
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
