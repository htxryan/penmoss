import { readThreads } from '@penmoss/sync-client/comments';
import { expect, seeded, test, type Page } from './fixtures';
import { COMMENT, NEW_NOTE } from './keys';
import { readRemote, remoteMarkdown } from './support/remote';
import { syncNow } from './support/sync';

// T48: comment threads in the app, on a git notebook (T59): kept in the note's document, so
// they reach the repository with it, and never in its markdown. Sending a thread to a Claude Code
// session through the repository (T60, #193) is in agent-comments.spec.ts.

const ULID = /\/notes\/([0-9A-HJKMNP-TV-Z]{26})$/;
const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(error.message));
  return errors;
}

const body = (page: Page) => page.getByTestId('note-body').locator('.ProseMirror');
const panel = (page: Page) => page.getByTestId('comments-panel');
const threads = (page: Page) => panel(page).getByTestId('comment-thread');
/** A comment floating over the note at its passage (T52 item 5). */
const popover = (page: Page) => page.getByTestId('comment-popover');

/** The Comments tab, opened from its icon down the note's edge if it is not showing (T53 item 9). */
async function showComments(page: Page) {
  if (!(await panel(page).isVisible())) await page.getByTestId('note-tab-comments').click();
  await expect(panel(page)).toBeVisible();
}

/** Whether a floating comment sits clear of its passage, below or above it. */
async function besidePassage(page: Page, passage: ReturnType<Page['locator']>) {
  const at = (await passage.boundingBox())!;
  const box = (await popover(page).boundingBox())!;
  return box.y >= at.y + at.height - 1 || box.y + box.height <= at.y + 1;
}

async function newNote(page: Page, title: string, text: string): Promise<string> {
  await expect(page.locator('button[data-command="note.new"]')).toBeVisible();
  await page.keyboard.press(NEW_NOTE);
  await expect(page).toHaveURL(ULID);
  await expect(page.getByTestId('note-title')).toBeFocused();
  await page.keyboard.type(title);
  await page.keyboard.press('Enter');
  await page.keyboard.type(text);
  await expect(page.getByTestId('note-view')).toHaveAttribute('data-ready', 'true');
  return ULID.exec(new URL(page.url()).pathname)![1]!;
}

/**
 * Selects `text` in the note's body, as a drag would, until the editor has it: the selection
 * toolbar shows. A selection made through the DOM is the page's until ProseMirror reads it, and
 * a view update in between (an awareness or sync tick) puts back the editor's own caret; a drag
 * goes through the editor's mouse handling and never meets this.
 */
async function selectText(page: Page, text: string): Promise<void> {
  await expect(async () => {
    await body(page).evaluate((root, wanted) => {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const at = node.textContent?.indexOf(wanted) ?? -1;
        if (at < 0) continue;
        const range = document.createRange();
        range.setStart(node, at);
        range.setEnd(node, at + wanted.length);
        const selection = window.getSelection()!;
        selection.removeAllRanges();
        selection.addRange(range);
        (root as HTMLElement).focus();
        return;
      }
      throw new Error(`no "${wanted}"`);
    }, text);
    await expect(page.getByTestId('selection-toolbar')).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 15_000 });
}

test('threads on a passage and at a point: reply, resolve, reopen, the filter, and never in the markdown', async ({
  page,
  context,
  host,
  notebook,
}) => {
  const errors = collectErrors(page);
  await page.goto('/');
  const id = await newNote(page, `Comments ${RUN}`, 'The garden plan needs work.');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Water the tomatoes daily');
  // The Comments tab's icon is always down the note's edge (T53 item 9); the count appears on
  // it with the first open thread.
  await expect(page.getByTestId('note-tab-comments')).toHaveAccessibleName('Comments');
  await expect(page.getByTestId('comments-count')).toHaveCount(0);

  // A passage: the toolbar's Comment, written floating over the note at the selection (T52).
  await selectText(page, 'garden plan');
  await page.getByTestId('selection-toolbar').getByRole('button', { name: 'Comment' }).click();
  await expect(popover(page).getByTestId('comment-draft')).toContainText('garden plan');
  expect(await besidePassage(page, body(page).getByText('The garden plan needs work.'))).toBe(true);
  await expect(page.getByTestId('comment-new')).toBeFocused();
  await page.getByTestId('comment-new').fill('Make this tighter');
  await page.getByTestId('comment-new-send').click();
  await expect(popover(page)).toHaveCount(0);
  await expect(body(page).locator('.pm-comment')).toHaveText('garden plan');
  await expect(page.getByTestId('comments-count')).toHaveText('1');

  // A point: the caret and the shortcut, quoting its line.
  await body(page).getByText('tomatoes').click();
  await page.keyboard.press(COMMENT);
  await expect(popover(page).getByTestId('comment-draft')).toContainText(
    'Water the tomatoes daily',
  );
  await page.getByTestId('comment-new').fill('Daily is a lot');
  await page.keyboard.press('ControlOrMeta+Enter');
  await expect(body(page).locator('.pm-comment-marker')).toHaveCount(1);
  await expect(page.getByTestId('comments-count')).toHaveText('2');

  // Escape closes a floating composer and gives the note its focus back.
  await page.keyboard.press(COMMENT);
  await expect(popover(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(popover(page)).toHaveCount(0);
  await expect(body(page)).toBeFocused();

  // A click on a passage opens its thread floating there; Escape closes it.
  await body(page).locator('.pm-comment').click();
  await expect(popover(page).getByTestId('comment-floating-thread')).toContainText(
    'Make this tighter',
  );
  expect(await besidePassage(page, body(page).locator('.pm-comment'))).toBe(true);
  await page.keyboard.press('Escape');
  await expect(popover(page)).toHaveCount(0);

  // The Comments tab lists every thread.
  await showComments(page);
  await expect(threads(page)).toHaveCount(2);

  // In the order of the text.
  await expect(threads(page).nth(0).getByTestId('comment-quote')).toContainText('garden plan');

  // Another window of the same note sees them, and a reply arrives there live.
  const other = await context.newPage();
  await other.goto(`/notes/${id}`);
  await expect(other.getByTestId('note-view')).toHaveAttribute('data-ready', 'true');
  await expect(other.locator('.ProseMirror .pm-comment')).toHaveText('garden plan');
  // From the list: the note scrolls to it, and it opens floating at its passage (T52).
  await threads(page).nth(0).getByRole('button', { name: 'Reply' }).click();
  await expect(popover(page).getByTestId('comment-floating-thread')).toBeVisible();
  await expect(page.getByTestId('comment-reply')).toBeFocused();
  await page.getByTestId('comment-reply').fill('Or cut it');
  await page.getByTestId('comment-reply-send').click();
  await page.keyboard.press('Escape');
  await expect(popover(page)).toHaveCount(0);
  // The panel stays open per device: open there already, or opened now.
  if (!(await other.getByTestId('comments-panel').isVisible())) {
    await other.getByTestId('note-tab-comments').click();
  }
  await expect(other.getByTestId('comment-body').filter({ hasText: 'Or cut it' })).toBeVisible();

  // Resolve: behind the Resolved filter, kept, and reopened from there.
  await threads(page).nth(0).getByTestId('comment-resolve').click();
  await expect(threads(page)).toHaveCount(1);
  await expect(body(page).locator('.pm-comment')).toHaveCount(0);
  await panel(page).getByTestId('comments-filter-resolved').click();
  await expect(threads(page)).toHaveCount(1);
  await expect(threads(page).getByTestId('comment-resolved-by')).toContainText('Resolved by');
  await threads(page).getByTestId('comment-reopen').click();
  await expect(threads(page)).toHaveCount(0);
  await panel(page).getByTestId('comments-filter-open').click();
  await expect(threads(page)).toHaveCount(2);

  // The ⋯ menu's Comments closes the panel and opens it again.
  await page.getByTestId('note-tab-comments').click();
  await expect(panel(page)).toHaveCount(0);
  await page.getByTestId('note-tab-comments').click();
  await expect(threads(page)).toHaveCount(2);

  // A comment is not the note (A770): the threads reach the repository in the note's document,
  // and never its markdown. Pushed by Sync Now (A1013), not by waiting out the push delay: 12 s
  // after the last change, which with the rest of the test went past its 30 s under load.
  const { remote } = seeded(notebook);
  await syncNow(page);
  await expect
    .poll(
      async () => {
        const doc = (await readRemote(host, remote)).ops.note(id);
        return doc ? readThreads(doc).filter((thread) => thread.status === 'open').length : 0;
      },
      { timeout: 20_000, intervals: [1_000] },
    )
    .toBe(2);
  const markdown = remoteMarkdown(host, remote, id) ?? '';
  expect(markdown).toContain('The garden plan needs work.');
  expect(markdown).not.toContain('Make this tighter');
  expect(markdown).not.toContain('Or cut it');

  // The first comment is never deleted on its own (A784): its replies stay, and it says so.
  // Found by its reply: removing the first comment empties its text.
  const first = threads(page).filter({ hasText: 'Or cut it' });
  await expect(first.getByTestId('comment')).toHaveCount(2);
  await first.getByTestId('comment').nth(0).getByTestId('comment-remove').click();
  await expect(first.getByTestId('comment-removed')).toHaveText('Comment removed');
  await expect(first.getByTestId('comment-body')).toHaveText('Or cut it');
  // A lone first comment has no Delete of its own; the thread's Delete asks first.
  const point = threads(page).filter({ hasText: 'Daily is a lot' });
  await expect(point.getByTestId('comment-remove')).toHaveCount(0);
  await point.getByTestId('comment-delete-thread').click();
  await point.getByTestId('comment-delete-cancel').click();
  await expect(threads(page)).toHaveCount(2);
  await point.getByTestId('comment-delete-thread').click();
  await point.getByTestId('comment-delete-confirm').click();
  await expect(threads(page)).toHaveCount(1);
  await expect(other.getByTestId('comment-thread')).toHaveCount(1);
  // The Comments tab's icon carries the count (T53 item 9: the note's bar and the phone's app bar
  // no longer do).
  const commentsTab = page.getByTestId('note-tab-comments');
  await expect(commentsTab.getByTestId('comments-count')).toHaveText('1');
  await expect(commentsTab).toHaveAccessibleName('Comments, 1 open');
  await expect(page.getByTestId('comments-count')).toHaveCount(1);
  expect(errors).toEqual([]);
  await other.close();
});

test('a comment on the note as a whole: from the Comments tab and the ⋯ menu, listed first (T52)', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await page.goto('/');
  await newNote(page, `Note comments ${RUN}`, 'The garden plan needs work.');
  await selectText(page, 'garden plan');
  await page.getByTestId('selection-toolbar').getByRole('button', { name: 'Comment' }).click();
  await page.getByTestId('comment-new').fill('On a passage');
  await page.getByTestId('comment-new-send').click();
  await showComments(page);
  await panel(page).getByTestId('comments-add-note').click();
  await expect(panel(page).getByTestId('comment-note-draft')).toContainText('The note as a whole');
  await panel(page).getByTestId('comment-new').fill('Needs a summary at the top');
  await panel(page).getByTestId('comment-new-send').click();
  await expect(threads(page)).toHaveCount(2);
  await expect(threads(page).nth(0).getByTestId('comment-note-level')).toBeVisible();
  await expect(threads(page).nth(0)).toContainText('Needs a summary at the top');
  // No marker in the text for it: only the passage is drawn.
  await expect(body(page).locator('.pm-comment-marker')).toHaveCount(0);
  await expect(page.getByTestId('comments-count')).toHaveText('2');
  // The Comments tab's Add Note Comment opens the composer.
  await panel(page).getByTestId('comments-add-note').click();
  await expect(panel(page).getByTestId('comment-note-draft')).toBeVisible();
  await expect(panel(page).getByTestId('comment-new')).toBeFocused();
  expect(errors).toEqual([]);
});
