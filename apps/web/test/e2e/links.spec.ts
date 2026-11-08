import { LocalNotebook } from '@penmoss/git-notebook/local';
import { expect, seeded, test, type Page } from './fixtures';
import { DOC_END } from './keys';
import { noteAction } from './note-menu';
import { syncNow } from './support/sync';
import { readRemote, remoteMarkdown } from './support/remote';

// T16: [[ completion from the local registry (offline included), links that follow
// renames in the editor, the markdown and (on a git notebook, T59) the notebook's rendered
// markdown and another device's backlinks read from the remote, and the Backlinks panel.

const ULID = /\/notes\/([0-9A-HJKMNP-TV-Z]{26})(\?.*)?$/;
const TAG = `l${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const ALPHA = `Alpha ${TAG}`;
const BETA = `Beta ${TAG}`;
const GAMMA = `Gamma ${TAG}`;
const RENAMED = `Allotment ${TAG}`;

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (message) => {
    // Refused sockets and fetches are expected while offline.
    if (
      message.type() === 'error' &&
      !/ERR_INTERNET_DISCONNECTED|WebSocket|Failed to fetch|net::/.test(message.text())
    ) {
      errors.push(message.text());
    }
  });
  page.on('pageerror', (error) => errors.push(error.message));
  return errors;
}

const body = (page: Page) => page.getByTestId('note-body').locator('.ProseMirror');
const menu = (page: Page) => page.getByTestId('link-menu');

async function createNote(page: Page, title: string): Promise<string> {
  await page
    .getByTestId('sidebar-shortcuts')
    .getByRole('button', { name: 'New Note', exact: true })
    .click();
  await expect(page).toHaveURL(ULID);
  await expect(page.getByTestId('note-title')).toBeFocused();
  await page.keyboard.type(title);
  await page.keyboard.press('Enter');
  return ULID.exec(new URL(page.url()).pathname)![1]!;
}

async function openNote(page: Page, title: string) {
  await page.getByTestId('note-list').getByRole('link', { name: title, exact: true }).click();
  await expect(page.getByTestId('note-title')).toHaveValue(title);
  await expect(page.getByTestId('note-view')).toHaveAttribute('data-ready', 'true');
}

/** Types `[[query`, waits for `option` to be first in the menu, and picks it. */
async function linkVia(page: Page, query: string, option: string) {
  await page.keyboard.type(`[[${query}`);
  await expect(menu(page)).toBeVisible();
  await expect(menu(page).getByRole('option').first()).toContainText(option);
  await page.keyboard.press('Enter');
  await expect(menu(page)).toBeHidden();
}

test('links notes by id through [[ completion, follows renames, and lists backlinks', async ({
  page,
  context,
  host,
  notebook,
}) => {
  test.setTimeout(120_000);
  const { remote } = seeded(notebook);
  const errors = collectErrors(page);
  await page.goto('/');
  await expect(page.getByTestId('empty-state')).toBeVisible();

  const alpha = await createNote(page, ALPHA);
  await page.keyboard.type('Raised beds and compost.');
  await page.keyboard.press('Enter');
  await page.keyboard.type('## Watering');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Every morning.');
  const beta = await createNote(page, BETA);
  await page.keyboard.type(`Mentions ${GAMMA.toLowerCase()} without a link. `);
  await linkVia(page, `alpha ${TAG}`, ALPHA);
  await page.keyboard.type('is the plan.');
  const gamma = await createNote(page, GAMMA);
  await page.keyboard.type('See ');
  // Fuzzy: initials and the tag find Alpha.
  await linkVia(page, `al ${TAG}`, ALPHA);
  await page.keyboard.type('and ');
  await page.keyboard.type(`[[${BETA}#Nope|the beta note]]`);
  await page.keyboard.type(' today.');

  const links = body(page).locator('a.pm-wikilink');
  await expect(links).toHaveText([ALPHA, 'the beta note']);
  await expect(links.first()).toHaveAttribute('data-note-id', alpha);
  await expect(links.nth(1)).toHaveAttribute('data-note-id', beta);

  // Offline, completion still works from the local registry and can create a note.
  host.network = 'down';
  await context.setOffline(true);
  await page.keyboard.press('Enter');
  await page.keyboard.type('[[Offline idea ' + TAG);
  await expect(menu(page).getByRole('option').last()).toContainText(`Create “Offline idea ${TAG}”`);
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('Enter');
  await expect(links).toHaveCount(3);
  await expect(links.nth(2)).toHaveText(`Offline idea ${TAG}`);
  await expect(links.nth(2)).toHaveAttribute('data-state', 'resolved');
  host.network = 'up';
  await context.setOffline(false);

  // Clicking a link opens its note; its backlinks list both linking notes with context.
  await links.first().click();
  await expect(page).toHaveURL(new RegExp(`/notes/${alpha}$`));
  await expect(page.getByTestId('note-title')).toHaveValue(ALPHA);
  const linked = page.getByTestId('linked-mentions');
  await expect(linked.getByRole('link', { name: GAMMA })).toBeVisible({ timeout: 20_000 });
  await expect(linked.getByRole('link', { name: BETA })).toBeVisible();
  await expect(linked).toContainText(`See ${ALPHA} and the beta note today.`);

  // Unlinked mentions: Beta mentions Gamma's title without linking it.
  await openNote(page, GAMMA);
  await expect(page.getByTestId('unlinked-mentions').getByRole('link', { name: BETA })).toBeVisible(
    {
      timeout: 30_000,
    },
  );

  // Rename Alpha: every link to it shows (and exports) the new title.
  await openNote(page, ALPHA);
  await page.getByTestId('note-title').fill(RENAMED);
  await openNote(page, GAMMA);
  await expect(links.first()).toHaveText(RENAMED);
  await noteAction(page, 'toggle-markdown');
  await expect(page.getByTestId('note-markdown')).toContainText(
    `See [[${RENAMED}]] and [[${BETA}#Nope|the beta note]] today.`,
  );
  await noteAction(page, 'toggle-markdown');
  await openNote(page, BETA);
  await expect(body(page).locator('a.pm-wikilink')).toHaveText([RENAMED]);

  // The notebook re-renders the linking notes' markdown with the new title when it pushes.
  await syncNow(page);
  await expect
    .poll(() => remoteMarkdown(host, remote, gamma) ?? '', { timeout: 40_000 })
    .toContain(`See [[${RENAMED}]] and`);
  // Another device reading the remote finds both backlinks.
  const read = await readRemote(host, remote);
  const data = new LocalNotebook(read.ops).backlinks(alpha) as { linked: Array<{ id: string }> };
  expect(new Set(data.linked.map((row) => row.id))).toEqual(new Set([beta, gamma]));

  // A link to a heading opens the note there.
  await openNote(page, GAMMA);
  await body(page).click();
  await page.keyboard.press(DOC_END);
  await page.keyboard.press('Enter');
  await linkVia(page, `${RENAMED}#wat`, 'Watering');
  await body(page)
    .locator('a.pm-wikilink', { hasText: `${RENAMED} › Watering` })
    .click();
  await expect(page).toHaveURL(new RegExp(`/notes/${alpha}\\?heading=Watering$`));

  expect(errors).toEqual([]);
});
