import { expect, test, type Locator, type Page } from '@playwright/test';
import {
  body,
  gitNotebook,
  launch,
  mainBounds,
  notebookSection,
  removeDataDirs,
  ULID,
  type Launched,
} from './support';

// PEN-69 in the Mac app: Copy Agent Reference copies one short line, the git notebook's local
// MCP server and read_note with the note's short id (the notebook's 4 characters, then the last
// 8 of the note's id), on the Mac's own clipboard. The test pastes it into the note, so it shows.

const opened: Launched[] = [];

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

async function newNote(page: Page, notebook: string, title: string): Promise<string> {
  await (await action(notebookSection(page, notebook), 'New Note in This Notebook')).click();
  await expect(page).toHaveURL(ULID);
  await expect(page.getByTestId('note-title')).toBeFocused();
  await page.keyboard.type(title);
  await page.keyboard.press('Enter');
  await expect(body(page)).toBeFocused();
  return ULID.exec(new URL(page.url()).pathname)![1]!;
}

test('Copy Agent Reference copies one short line with the note’s short id', async () => {
  test.setTimeout(180_000);
  const launched = await launch();
  opened.push(launched);
  const { app, page, errors } = launched;
  await mainBounds(app, { x: 0, y: 0, width: 1280, height: 720 });
  await gitNotebook(launched, 'Personal');
  const id = await newNote(page, 'Personal', 'Penmoss Roadmap');

  await page.getByTestId('copy-agent-reference').click();
  await expect(page.getByTestId('copy-status')).toHaveText('Copied Agent Reference');
  const copied = await app.evaluate(({ clipboard }) => clipboard.readText());
  expect(copied).toMatch(
    new RegExp(
      `^Reference note via Penmoss MCP \\(penmoss mcp --notebook "Personal"\\) tool read_note \\{"id":"[0-9A-HJKMNP-TV-Z]{4}-${id.slice(-8)}"\\}$`,
    ),
  );
  expect(copied).not.toContain(id);

  // Shown in the note, as it would be pasted into an agent's conversation.
  await body(page).click();
  await page.keyboard.insertText(copied);
  await expect(body(page)).toContainText(`-${id.slice(-8)}"}`);
  await body(page).scrollIntoViewIfNeeded();
  await page.waitForTimeout(2000);
  await expect(body(page)).toContainText('Reference note via Penmoss MCP (penmoss mcp --notebook');
  expect(errors).toEqual([]);
});
