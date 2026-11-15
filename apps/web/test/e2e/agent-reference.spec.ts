/**
 * Copy Agent Reference's short text (PEN-69): one line naming the git notebook's local MCP server
 * and the read_note call with the note's short id (`K7QD-9HTF2CXA`: the notebook's 4 characters,
 * then the last 8 of the note's id). The proof pastes what was copied into the note, so it shows.
 */
import { expect, test, type Page } from './fixtures';

test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

const ULID = /\/notes\/([0-9A-HJKMNP-TV-Z]{26})$/;

const body = (page: Page) => page.getByTestId('note-body').locator('.ProseMirror');

async function newNote(page: Page, title: string): Promise<string> {
  await page
    .getByTestId('sidebar-shortcuts')
    .getByRole('button', { name: 'New Note', exact: true })
    .click();
  await expect(page).toHaveURL(ULID);
  await expect(page.getByTestId('note-title')).toBeFocused();
  await page.keyboard.type(title);
  await page.keyboard.press('Enter');
  await expect(body(page)).toBeFocused();
  return ULID.exec(new URL(page.url()).pathname)![1]!;
}

test('PEN-69: Copy Agent Reference copies one short line with the note’s short id', async ({
  page,
}) => {
  await page.goto('/');
  const id = await newNote(page, 'Penmoss Roadmap');
  await page.getByTestId('copy-agent-reference').click();
  await expect(page.getByTestId('copy-status')).toHaveText('Copied Agent Reference');
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toMatch(
    new RegExp(
      `^Reference note via Penmoss MCP \\(penmoss mcp --notebook "[^"]+"\\) tool read_note \\{"id":"[0-9A-HJKMNP-TV-Z]{4}-${id.slice(-8)}"\\}$`,
    ),
  );
  // The long id is nowhere in it: the short id is the last 8 characters only.
  expect(copied).not.toContain(id);
  // Shown in the note, as it would be pasted into an agent's conversation.
  await body(page).click();
  await page.keyboard.insertText(copied);
  await expect(body(page)).toContainText(`tool read_note {"id":"`);
  await expect(body(page)).toContainText(`-${id.slice(-8)}"}`);
  await body(page).scrollIntoViewIfNeeded();
  await page.waitForTimeout(2000);
  await expect(body(page)).toContainText('Reference note via Penmoss MCP');
});
