import { anotherMac, expect, seeded, test, type GitHost, type Page } from './fixtures';
import { NEW_FOLDER, VERSION_HISTORY, LINE_END } from './keys';
import { noteAction } from './note-menu';
import { notebookMenuItem } from './notebook-actions';
import { asAgent, syncNow } from './support/sync';
import { readRemote, remoteFiles, remoteMarkdown } from './support/remote';
import { body, collectErrors, newNote } from './support/app';

// T21 on a git notebook (T59, A858): version history (each sync is a commit, attributed to its
// writer; a diff; restore as a new change that reaches another Mac), reverting an agent's
// commit, and Trash (restore into the folder it was deleted from, and delete for good after
// Touch ID). "Save a Version Now" is "Sync Now" here: a version is a commit.

const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;

const panel = (page: Page) => page.getByTestId('history-panel');
const tree = (page: Page) => page.getByRole('tree', { name: 'Folders and notes' });

/** Pushes, then waits until the remote's rendered markdown of the note holds `text`. */
async function pushed(page: Page, host: GitHost, remote: string, id: string, text: string) {
  await syncNow(page);
  await expect
    .poll(() => remoteMarkdown(host, remote, id) ?? '', { timeout: 40_000 })
    .toContain(text);
}

test('history shows attributed versions with a diff, and restores one as a new change', async ({
  page,
  browser,
  host,
  notebook,
}) => {
  test.setTimeout(120_000);
  const errors = collectErrors(page);
  const { remote } = seeded(notebook);
  await page.goto('/');
  const id = await newNote(page, `Trip ${RUN}`, 'Book the night train');

  // On demand: Sync Now saves a version (a commit) of the note as it is.
  await page.keyboard.press(VERSION_HISTORY);
  await expect(panel(page)).toBeVisible();
  // How versions are made is the head's ⓘ, not a paragraph over the list (Ryan's review of #192,
  // finding 13); Sync Now is on the Now row, quiet.
  await page.getByTestId('history-about').click();
  await expect(page.getByTestId('history-about-text')).toContainText(
    'Each sync with git is a version',
  );
  await page.getByTestId('history-about').click();
  await panel(page).getByTestId('history-now').getByRole('button', { name: 'Sync Now' }).click();
  await expect(panel(page).getByTestId('history-status')).toContainText('Saved a version');
  const first = panel(page).getByRole('list', { name: 'Versions' }).getByRole('button').first();
  // One line: the writer's icon (its name for screen readers, and a tooltip on hover), the time,
  // what changed and the lines it changed, under the day.
  await expect(first).toHaveAccessibleName(/Penmoss for Mac/);
  await expect(panel(page).locator('.history-day').first()).toHaveText('Today');
  // Its summary is read after the list shows (main's `readDir`, Ryan's review of #192).
  await expect(first.locator('.history-summary')).toHaveText(
    /^(Added|Edited) “Book the night train”$/,
  );
  await expect(first.locator('.history-lines')).toHaveText(/^\+\d+(−\d+)?$/);
  await first.locator('.history-who').hover();
  await expect(page.getByTestId('tooltip')).toHaveText('Penmoss for Mac');
  await expect.poll(() => remoteMarkdown(host, remote, id) ?? '').toContain('Book the night train');
  // The History tab of the note's side panel (T51, A936): the panel closes.
  await page.getByTestId('note-panel-close').click();
  await expect(panel(page)).toHaveCount(0);

  // Rewrite the note, and wait until it is stored and waits for its push.
  await body(page).click();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.type('Fly instead');
  await expect(page.getByTestId('section-sync')).toHaveAttribute('data-pending', '1');

  // Not pushed yet, the change is not a version; the saved one's diff, then restore it.
  await page.getByTestId('note-tab-history').click();
  await expect(panel(page).getByTestId('history-now')).toContainText('Not saved as a version yet');
  const saved = panel(page).getByRole('list', { name: 'Versions' }).getByRole('button').first();
  await saved.click();
  const diff = panel(page).getByTestId('history-diff');
  await expect(diff.locator('[data-op="add"]')).toContainText(['Book the night train']);
  await panel(page).getByRole('button', { name: 'Restore This Version' }).click();
  await expect(panel(page).getByTestId('history-status')).toContainText('as a new change');
  // The open editor gets the restore as an ordinary change.
  await expect(body(page)).toHaveText('Book the night train');
  await expect(
    panel(page).getByRole('button').filter({ hasText: 'Restore' }).first(),
  ).toBeVisible();

  // Another Mac sees it too.
  await pushed(page, host, remote, id, 'Book the night train');
  expect(remoteMarkdown(host, remote, id)).not.toContain('Fly instead');
  const other = await anotherMac(browser, { remote });
  try {
    const device = other.page;
    await device.goto(`/notes/${id}`);
    await expect(device.getByTestId('note-body').locator('.ProseMirror')).toHaveText(
      'Book the night train',
      { timeout: 40_000 },
    );
  } finally {
    await other.context.close();
  }
  expect(errors).toEqual([]);
});

test("reverts an agent's edit, keeping a later edit by the user", async ({
  page,
  host,
  notebook,
}) => {
  test.setTimeout(120_000);
  const errors = collectErrors(page);
  const { remote } = seeded(notebook);
  await page.goto('/');
  const id = await newNote(page, `Agent ${RUN}`, 'Written by Ryan');
  await pushed(page, host, remote, id, 'Written by Ryan');

  // An agent on its own clone (the local MCP, A993) appends a paragraph and pushes it.
  await asAgent(host, remote, `Claude ${RUN}`, (local) => {
    local.edit(id, { op: 'append', markdown: 'Summary added by Claude' }, null);
  });
  await expect(async () => {
    await syncNow(page);
    await expect(body(page)).toContainText('Summary added by Claude', { timeout: 2_000 });
  }).toPass({ timeout: 40_000 });

  // The user keeps writing in the first paragraph.
  await body(page).getByText('Written by Ryan').click();
  await page.keyboard.press(LINE_END);
  await page.keyboard.type(', then edited');
  await pushed(page, host, remote, id, 'Written by Ryan, then edited');

  await page.getByTestId('note-tab-history').click();
  const agentVersion = panel(page)
    .getByRole('list', { name: 'Versions' })
    .getByRole('button', { name: new RegExp(`Claude ${RUN}`) });
  await expect(agentVersion).toBeVisible({ timeout: 15_000 });
  await agentVersion.click();
  await expect(panel(page).getByTestId('history-diff').locator('[data-op="add"]')).toContainText([
    'Summary added by Claude',
  ]);
  await panel(page).getByRole('button', { name: 'Revert This Edit' }).click();
  await expect(panel(page).getByTestId('history-status')).toContainText('later edits are kept');
  await expect(body(page)).not.toContainText('Summary added by Claude');
  await expect(body(page)).toContainText('Written by Ryan, then edited');
  expect(errors).toEqual([]);
});

test('Trash restores a note into its folder, and deletes it for good', async ({
  page,
  host,
  notebook,
}) => {
  test.setTimeout(120_000);
  const errors = collectErrors(page);
  const { remote } = seeded(notebook);
  await page.goto('/');
  await expect(page.locator('button[data-command="note.new"]')).toBeVisible();
  const folder = `Archive ${RUN}`;
  await page.keyboard.press(NEW_FOLDER);
  const name = page.getByRole('textbox', { name: 'New folder name' });
  await name.fill(folder);
  await name.press('Enter');
  await expect(tree(page).getByRole('treeitem', { name: folder, exact: true })).toBeFocused();
  const title = `Receipts ${RUN}`;
  const id = await newNote(page, title, 'Keep for taxes');
  const row = tree(page).getByRole('treeitem', { name: title, exact: true });
  await expect(row).toHaveAttribute('aria-level', '2');
  await pushed(page, host, remote, id, 'Keep for taxes');

  await noteAction(page, 'delete-note');
  await expect(row).toHaveCount(0);
  // The notebook's Trash, in its row's ⋯ (T53 item 4, R2-21).
  await (await notebookMenuItem(page, 'Trash')).click();
  const entry = page.getByTestId('trash').locator(`[data-note-id="${id}"]`);
  await expect(entry).toContainText(title);
  await expect(entry).toContainText(`from ${folder}`);
  // A git notebook keeps Trash until a person deletes for good: no 30 days (A828).
  await expect(entry).toContainText('kept until deleted for good');

  await entry.getByRole('button', { name: `Restore ${title}` }).click();
  await expect(page).toHaveURL(new RegExp(`/notes/${id}$`));
  await expect(body(page)).toHaveText('Keep for taxes');
  await expect(row).toHaveAttribute('aria-level', '2');

  // Again, then for good.
  await noteAction(page, 'delete-note');
  // The notebook's Trash, in its row's ⋯ (T53 item 4, R2-21).
  await (await notebookMenuItem(page, 'Trash')).click();
  await expect(entry).toBeVisible();
  await entry.getByRole('button', { name: `Delete ${title} for Good` }).click();
  await entry.getByRole('button', { name: 'Delete for Good' }).click();
  // The title is isolated (⁨…⁩), and the notebook's git history still keeps it (A828).
  await expect(page.getByTestId('trash-status')).toHaveText(
    `Deleted “⁨${title}⁩” for good. The repository’s git history still keeps it.`,
  );
  await expect(entry).toHaveCount(0);
  // Gone from the notebook once pushed: no rendered file, no note (A828). Git's history keeps
  // its old commits.
  await syncNow(page);
  await expect
    .poll(() => remoteFiles(host, remote).filter((path) => path.includes(id)), {
      timeout: 40_000,
    })
    .toEqual([]);
  expect(remoteMarkdown(host, remote, id)).toBeNull();
  const read = await readRemote(host, remote);
  expect(read.workspace.notes.map((note) => note.id)).not.toContain(id);
  expect(read.ops.note(id)).toBeUndefined();
  expect(errors).toEqual([]);
});

test.describe('a note with many versions (Ryan’s review of #193)', () => {
  /** A long note: 120 paragraphs, 239 lines of markdown. */
  const LONG = Array.from({ length: 120 }, (_, i) => `Paragraph ${i + 1} of a long note.`).join(
    '\n\n',
  );
  test.use({ seed: { name: 'Notes', notes: [{ title: 'Long', markdown: LONG }] } });

  test('History stays in the window, numbers the diff’s lines, and keeps its actions on one row', async ({
    page,
    host,
    notebook,
  }) => {
    test.setTimeout(180_000);
    const errors = collectErrors(page);
    const { remote, noteIds } = seeded(notebook);
    const id = noteIds[0]!;
    // Versions enough to fill the list well past the window: an agent's edits, one a commit.
    for (let i = 1; i <= 24; i++) {
      await asAgent(host, remote, 'Claude', (local) => {
        local.edit(id, { op: 'append', markdown: `Edit ${i}` }, null);
      });
    }
    await page.setViewportSize({ width: 1440, height: 800 });
    await page.goto(`/notes/${id}`);
    await expect(async () => {
      await syncNow(page);
      await expect(body(page)).toContainText('Edit 24', { timeout: 2_000 });
    }).toPass({ timeout: 40_000 });
    await page.getByTestId('note-tab-history').click();
    const rows = panel(page).getByRole('list', { name: 'Versions' }).locator('.history-entry');
    await expect(rows).toHaveCount(25);
    const diff = panel(page).getByTestId('history-diff');
    await expect(diff.locator('[data-op="add"]')).toContainText(['Edit 24']);

    // R2-10: nothing around the panel can scroll. Its rows' screen reader names (`.sr-only`,
    // placed absolutely) hung below the list, down to the last version, and the note's pane
    // scrolled the whole view up to reach them, leaving an empty band under the window.
    const overflowing = () =>
      page.evaluate(() => {
        const out: string[] = [];
        for (
          let el = document.querySelector('[data-testid="history-panel"]')?.parentElement ?? null;
          el;
          el = el.parentElement
        ) {
          if (el.scrollHeight > el.clientHeight + 1 || el.scrollTop > 0) {
            out.push(`${el.tagName}.${el.className}: ${el.scrollHeight} > ${el.clientHeight}`);
          }
        }
        return out;
      });
    expect(await overflowing()).toEqual([]);
    const top = async () => (await panel(page).boundingBox())!.y;
    const before = await top();
    await rows.nth(3).hover();
    await page.mouse.wheel(0, 2_000);
    await page.mouse.wheel(0, 2_000);
    // The list scrolled, not the view around it.
    await expect
      .poll(() => rows.last().evaluate((row) => row.getBoundingClientRect().bottom))
      .toBeLessThan(800);
    expect(await top()).toBe(before);
    expect(await overflowing()).toEqual([]);

    // R2-13: a gutter with this version's line numbers, running on across the fold.
    const numbers = await diff
      .locator('pre[data-numbered] > span')
      .evaluateAll((spans) =>
        spans.map((span) =>
          span.classList.contains('diff-fold')
            ? `fold ${(span.querySelector('.diff-fold-lines') as HTMLElement).dataset['n']}`
            : `${span.getAttribute('data-op')} ${(span.querySelector('.diff-num') as HTMLElement).dataset['n']}`,
        ),
      );
    // The note file's lines: its front matter (4), its 239 and 23 edits' (a blank line and the
    // edit each: 46), then the 24th's two.
    expect(numbers).toEqual(['fold 1–287', 'same 288', 'same 289', 'add 290', 'add 291']);
    // Drawn by CSS: the diff's selected text has the lines, never their numbers.
    const selected = await diff.locator('pre').evaluate((pre) => {
      const range = document.createRange();
      range.selectNodeContents(pre);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      return selection.toString();
    });
    expect(selected).toContain('\n Edit 23\n+\n+Edit 24');
    expect(selected).not.toMatch(/28[89]|29[01]/);
    const gutter = diff.locator('.diff-num').first();
    expect(await gutter.evaluate((el) => getComputedStyle(el).userSelect)).toBe('none');

    // R2-11 and R2-12: Restore, Revert and Copy in one row, words and icons, no ↑/↓ hint.
    const actions = panel(page).locator('.history-actions');
    const buttons = actions.getByRole('button');
    await expect(buttons).toHaveText(['Restore', 'Revert', 'Copy']);
    await expect(actions.locator('kbd')).toHaveCount(0);
    const oneRow = () =>
      buttons.evaluateAll(
        (all) => new Set(all.map((button) => Math.round(button.getBoundingClientRect().top))).size,
      );
    expect(await oneRow()).toBe(1);
    await buttons.first().hover();
    await expect(page.getByTestId('tooltip')).toHaveText('Restore This Version');
    // A narrower panel: the words go, Revert's and Copy's first, then Restore's; still one row,
    // each button still named in full.
    const width = (rem: number) =>
      page
        .locator('.note-columns')
        .evaluate(
          (el, w) => (el as HTMLElement).style.setProperty('--pm-panel-width', `${w}rem`),
          rem,
        );
    const words = actions.locator('.history-action-word:visible');
    await width(13);
    await expect(actions).toHaveAttribute('data-fit', '1');
    await expect(words).toHaveText(['Restore']);
    expect(await oneRow()).toBe(1);
    await width(7);
    await expect(actions).toHaveAttribute('data-fit', '2');
    await expect(words).toHaveCount(0);
    expect(await oneRow()).toBe(1);
    await expect(actions.getByRole('button', { name: 'Restore This Version' })).toBeVisible();
    await expect(actions.getByRole('button', { name: 'Copy Text' })).toBeVisible();
    await width(26);
    await expect(actions).not.toHaveAttribute('data-fit');
    await expect(buttons).toHaveText(['Restore', 'Revert', 'Copy']);
    expect(errors).toEqual([]);
  });
});
