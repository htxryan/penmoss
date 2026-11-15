import { expect, seeded, test, type GitHost, type Page } from './fixtures';
import { FULL_WIDTH, INFO_PANEL, LINE_END, NEW_NOTE, SELECT_TO_LINE_START, SIDEBAR } from './keys';
import { storedSetting } from './stored';
import { readRemote, remoteMarkdown } from './support/remote';

// T41: Ryan's Mac app feedback, round 1, in the web app (the Mac app runs the same page; its
// own suite covers the OS check before Delete for good). On a git notebook (T59): full width is
// the notebook's device setting (A827), pushed to its remote; a note with pictures comes from
// another writer, its attachments in the repository.

const ULID = /\/notes\/([0-9A-HJKMNP-TV-Z]{26})$/;
const RUN = `f${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(error.message));
  return errors;
}

const body = (page: Page) => page.getByTestId('note-body').locator('.ProseMirror');
const info = (page: Page) => page.getByRole('complementary', { name: 'Metadata' });

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
 * Waits until this device's stored workspace holds full width as `full`. A page that goes
 * (reload, navigation) right after a change keeps only what was stored, and a reload reads the
 * stored copy first (A624): a change written a moment after the click can otherwise be lost.
 */
async function widthStored(page: Page, full: boolean) {
  await expect.poll(() => storedSetting(page, 'note.fullWidth'), { timeout: 10_000 }).toBe(full);
}

/** Waits until the notebook's remote holds full width as `full`. */
async function widthSynced(host: GitHost, remote: string, full: boolean) {
  await expect
    .poll(async () => (await readRemote(host, remote)).setting('note.fullWidth') === true, {
      timeout: 90_000,
    })
    .toBe(full);
}

const docWidth = (page: Page) =>
  page.locator('.doc:not([hidden])').evaluate((element) => element.getBoundingClientRect().width);

test('the note column: 52rem by default, the full window when asked, remembered', async ({
  page,
  host,
  notebook,
}) => {
  test.setTimeout(150_000);
  const errors = collectErrors(page);
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.goto('/');
  const id = await newNote(page, `Width ${RUN}`, 'A line of text. '.repeat(40));
  // The side panel closed, whichever tab it shows (T51, A936), so the column has the room.
  const closePanel = page.getByTestId('note-panel-close');
  if (await closePanel.isVisible()) await closePanel.click();
  await expect(page.locator('.note-columns')).toHaveAttribute('data-panel', 'closed');
  await expect(
    page.getByRole('tablist', { name: 'Note panel' }).getByRole('tab', { selected: true }),
  ).toHaveCount(0);
  const toggle = page.getByTestId('toggle-full-width');
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  // 52rem of text plus 3rem gutters either side (A500).
  expect(await docWidth(page)).toBe(58 * 16);
  try {
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('note-view')).toHaveAttribute('data-width', 'full');
    const main = await page
      .locator('.note-main')
      .evaluate((element) => element.getBoundingClientRect().width);
    // The whole pane but the panel's strip of tab icons at its right edge (T53 item 9).
    const strip = await page
      .getByTestId('note-rail')
      .evaluate((element) => element.getBoundingClientRect().width);
    expect(strip).toBeGreaterThan(0);
    expect(await docWidth(page)).toBeGreaterThan(main - strip - 20);

    // A synced setting: in the notebook's remote, after a reload, and in Settings → Appearance.
    await widthStored(page, true);
    await widthSynced(host, seeded(notebook).remote, true);
    await page.reload();
    await expect(page.getByTestId('note-view')).toHaveAttribute('data-width', 'full');
    await page.goto('/settings/appearance');
    const setting = page.getByTestId('note-width-setting');
    await expect(setting.getByRole('radio', { name: /Full Window Width/ })).toBeChecked();
    // The segmented control's radios are hidden behind their labels: choose as a person would.
    await setting.locator('label', { hasText: 'The Theme’s' }).click();
    await expect(setting.getByRole('radio', { name: /The Theme’s/ })).toBeChecked();
    await widthStored(page, false);
    await page.goBack();
    await expect(page.getByTestId('note-view')).toHaveAttribute('data-ready', 'true');
    await expect(page.getByTestId('note-view')).not.toHaveAttribute('data-width', 'full');

    // Its shortcut, from the note's body.
    await body(page).click();
    await page.keyboard.press(FULL_WIDTH);
    await expect(page.getByTestId('note-view')).toHaveAttribute('data-width', 'full');
    await page.keyboard.press(FULL_WIDTH);
    await expect(page.getByTestId('note-view')).not.toHaveAttribute('data-width', 'full');
  } finally {
    // Off again, in the remote too. A step that failed in Settings left the note: back to it,
    // so the toggle is there to press.
    if (!(await toggle.isVisible())) await page.goto(`/notes/${id}`);
    if ((await toggle.getAttribute('aria-pressed')) === 'true') await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await widthSynced(host, seeded(notebook).remote, false);
  }
  expect(errors).toEqual([]);
});

test('the Info panel: details, tags edited there, frontmatter and backlinks', async ({ page }) => {
  const errors = collectErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  const tag = `info${RUN}`;
  const id = await newNote(page, `Info ${RUN}`, `Text with an inline #${tag}x tag`);
  await expect(info(page)).toBeVisible();
  // No tags row under the title any more: the chips are in the panel.
  await expect(page.locator('.doc [data-testid="note-tags"]')).toHaveCount(0);
  const panel = info(page);
  await expect(panel.getByTestId('info-folder')).toHaveText('Top level');
  await expect(panel.getByTestId('info-created')).not.toHaveText('Unknown');
  await expect(panel.getByTestId('info-frontmatter')).toContainText(id);
  await expect(panel.getByTestId('info-frontmatter')).toContainText(`Info ${RUN}`);
  await expect(panel.getByTestId('backlinks')).toBeVisible();

  // A tag added in the panel lands in the frontmatter.
  await panel.getByRole('button', { name: 'Add a Tag', exact: true }).click();
  const field = panel.getByRole('combobox', { name: 'Add a tag' });
  await field.fill(tag);
  await field.press('Enter');
  await expect(panel.getByRole('button', { name: `#${tag}`, exact: true })).toBeVisible();
  await expect(panel.getByTestId('info-frontmatter')).toContainText(`[${tag}]`);
  await expect(panel.getByTestId('info-inline-tags')).toContainText(`#${tag}x`);

  // Its shortcut hides and shows it; Add a tag from the palette opens it with the field.
  await body(page).click();
  await page.keyboard.press(INFO_PANEL);
  await expect(info(page)).toHaveCount(0);
  await page.keyboard.press('ControlOrMeta+KeyK');
  await page.keyboard.type('Add a tag to this note');
  await page.keyboard.press('Enter');
  await expect(info(page).getByRole('combobox', { name: 'Add a tag' })).toBeFocused();
  expect(errors).toEqual([]);
});

test('the status bar: save status, counts, and the selection’s counts', async ({ page, host }) => {
  test.setTimeout(120_000);
  const errors = collectErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await newNote(page, `Status ${RUN}`, 'one two three four five');
  const bar = page.getByTestId('status-bar');
  await expect(bar).toBeVisible();
  await expect(bar.getByTestId('save-status')).toHaveAttribute('data-state', 'synced', {
    timeout: 40_000,
  });
  // A git notebook's words (A860): saved here, and pushed to git.
  await expect(bar.getByTestId('save-status')).toContainText('Saved · in git');
  // Routine saving and syncing is not read out; only states that need attention are.
  await expect(bar.getByTestId('save-status')).not.toHaveAttribute('role', /.+/);
  await expect(bar.getByTestId('save-alert')).toHaveText('');
  await expect(bar.getByTestId('note-counts')).toContainText('5 words');
  await expect(bar.getByTestId('note-counts')).toContainText('23 characters');
  await expect(bar.getByTestId('note-counts')).toContainText('1 min read');

  await page.keyboard.type(' six');
  await expect(bar.getByTestId('note-counts')).toContainText('6 words');
  // A selection's counts replace the note's while it lasts.
  await page.keyboard.press(SELECT_TO_LINE_START);
  await expect(bar.getByTestId('selection-counts')).toHaveText(
    '6 words and 27 characters selected',
  );
  await page.keyboard.press(LINE_END);
  await expect(bar.getByTestId('selection-counts')).toHaveCount(0);

  // Offline, the note is saved here and waits. A remote on this Mac needs no network (#174
  // review): git's goes too, so the push fails as it would.
  await page.context().setOffline(true);
  host.network = 'down';
  await page.keyboard.type(' seven');
  await expect(bar.getByTestId('save-status')).toHaveAttribute('data-state', 'offline', {
    timeout: 40_000,
  });
  await expect(bar.getByTestId('save-alert')).toHaveText('');
  host.network = 'up';
  await page.context().setOffline(false);
  await expect(bar.getByTestId('save-status')).toHaveAttribute('data-state', 'synced', {
    timeout: 60_000,
  });
  expect(errors.filter((e) => !/ERR_INTERNET_DISCONNECTED|WebSocket/.test(e))).toEqual([]);
});

test('the sidebar: an icon rail, remembered; a tag filter moves nothing below the list', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  const tag = `rail${RUN}`;
  await newNote(page, `Rail ${RUN}`, `A note with #${tag}`);
  const calendar = () =>
    page.locator('.sidebar .calendar').evaluate((element) => {
      const box = element.getBoundingClientRect();
      return { top: Math.round(box.top), height: Math.round(box.height) };
    });
  // The tags' section of the sidebar (T53 item 8, A983): its own box, which scrolls its list.
  const tagPane = () =>
    page
      .getByTestId('tag-pane')
      .evaluate((element) =>
        Math.round((element.closest('.sb-part') ?? element).getBoundingClientRect().top),
      );
  await expect(page.getByTestId('tag-pane').getByText(tag, { exact: true })).toBeVisible();
  // The sections in the synced order (T53 item 8), once it has arrived: measured before, a late
  // order would move them for another reason than the tag.
  const stored = await storedSetting(page, 'sidebar.sectionOrder');
  if (Array.isArray(stored)) {
    const known = ['quickAccess', 'recent', 'notebooks', 'calendar', 'tags'];
    const order = (stored as string[]).filter((id) => known.includes(id));
    await expect
      .poll(() =>
        page
          .locator('#app-sidebar .sb-part[data-section]')
          .evaluateAll((parts) => parts.map((part) => part.getAttribute('data-section'))),
      )
      .toEqual([...order, ...known.filter((id) => !order.includes(id))]);
  }
  const before = { calendar: await calendar(), tags: await tagPane() };
  // A tag opens Search on its notes (finding 9 of the #192 review): the sidebar stays put.
  await page.getByTestId('tag-pane').getByText(tag, { exact: true }).click();
  await expect(page.getByTestId('search').locator('.search-hit').first()).toBeVisible();
  expect({ calendar: await calendar(), tags: await tagPane() }).toEqual(before);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('search')).toBeHidden();
  expect({ calendar: await calendar(), tags: await tagPane() }).toEqual(before);

  // Collapsed: Search, Today, This Week, Graph and Commands (and Back and Forward, A943). Collapsed from the
  // tree, focus moves to the toggle rather than into hidden rows.
  await page
    .getByRole('tree', { name: 'Folders and notes' })
    .locator('[aria-current="page"]')
    .first()
    .focus();
  await page.keyboard.press(SIDEBAR);
  await expect(page.getByTestId('toggle-sidebar')).toBeFocused();
  const sidebar = page.getByRole('complementary', { name: 'Notes' });
  await expect(page.getByTestId('app-root')).toHaveAttribute('data-sidebar', 'collapsed');
  for (const name of [/^Search/, /^Today/, /^This Week/, /^Graph/, /^Commands/]) {
    await expect(
      sidebar.getByRole('button', { name }).or(sidebar.getByRole('link', { name })),
    ).toBeVisible();
  }
  await expect(sidebar.getByRole('tree', { name: 'Folders and notes' })).toBeHidden();
  await expect(sidebar.locator('.calendar')).toBeHidden();
  await expect(sidebar.getByTestId('tag-pane')).toBeHidden();
  expect(
    await sidebar.evaluate((element) => Math.round(element.getBoundingClientRect().width)),
  ).toBeLessThan(60);
  // The rail's buttons still work.
  await sidebar.getByRole('button', { name: /^Commands/ }).click();
  await expect(page.getByRole('dialog', { name: /Command palette/i })).toBeVisible();
  await page.keyboard.press('Escape');

  // Remembered on this device.
  await page.reload();
  await expect(page.getByTestId('app-root')).toHaveAttribute('data-sidebar', 'collapsed');
  await page.getByTestId('toggle-sidebar').click();
  await expect(page.getByTestId('app-root')).not.toHaveAttribute('data-sidebar', 'collapsed');
  await expect(sidebar.getByRole('tree', { name: 'Folders and notes' })).toBeVisible();
  // The open note's row, revealed while the tree was hidden, comes into view when it shows.
  await expect(sidebar.locator('[aria-current="page"]').first()).toBeInViewport();
  expect(errors).toEqual([]);
});

test('a picture never sits beside text, in a list item or a paragraph', async ({
  page,
  host,
  notebook,
}) => {
  test.setTimeout(90_000);
  const errors = collectErrors(page);
  const { info, remote } = seeded(notebook);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await expect(page.getByTestId('app-root')).toBeVisible();
  // A small picture, pasted into a note here, so this Mac holds its bytes. (A picture only
  // another writer added does not load on this Mac yet: its bytes are fetched from the server.)
  await newNote(page, `Scratch ${RUN}`, '');
  const png = await page.evaluate(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 120;
    canvas.height = 60;
    const context = canvas.getContext('2d')!;
    context.fillStyle = '#3a6';
    context.fillRect(0, 0, 120, 60);
    const blob = await new Promise<Blob>((resolve) =>
      canvas.toBlob((b) => resolve(b!), 'image/png'),
    );
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const transfer = new DataTransfer();
    transfer.items.add(new File([bytes], 'Picture.png', { type: 'image/png' }));
    const editor = document.querySelector<HTMLElement>('[data-testid="note-body"] .ProseMirror')!;
    editor.focus();
    editor.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }),
    );
    return [...bytes];
  });
  await expect(body(page).locator('.pm-image')).toHaveAttribute('data-state', 'ready');
  // Another writer (an agent, say) files the note with the picture as an attachment, and pushes.
  const { engine, ops } = await host.writer(info);
  const { sha256 } = await ops.keepAttachment(new Uint8Array(png), 'png');
  const markdown =
    `1. The default content width needs to be wider![|100](attachments/${sha256}.png)\n` +
    `2. The next item\n\nA paragraph ![](attachments/${sha256}.png) with text after it.\n`;
  const id = ops.createNote({ title: `Pictures ${RUN}`, markdown });
  await engine.save();
  await engine.sync();
  const listed = page.getByRole('tree', { name: 'Folders and notes' }).getByRole('treeitem', {
    name: `Pictures ${RUN}`,
  });
  // The window pulls when it is focused (A1013).
  await expect(async () => {
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(listed).toBeVisible({ timeout: 5_000 });
  }).toPass({ timeout: 60_000 });
  await page.goto(`/notes/${id}`);
  await expect(page.getByTestId('note-view')).toHaveAttribute('data-ready', 'true');
  const images = body(page).locator('.pm-image img');
  await expect(images).toHaveCount(2);
  await expect(body(page).locator('.pm-image').first()).toHaveAttribute('data-state', 'ready', {
    timeout: 30_000,
  });
  await expect(images.first()).toBeVisible();

  // Each picture's box starts below the text before it and ends above the text after it.
  const layout = await body(page).evaluate((root) =>
    [...root.querySelectorAll<HTMLElement>('.pm-image')].map((image) => {
      const box = image.getBoundingClientRect();
      const block = image.closest('p')!;
      const lines: Array<{ top: number; bottom: number; left: number; right: number }> = [];
      const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (image.contains(node) || !node.textContent?.trim()) continue;
        const range = document.createRange();
        range.selectNodeContents(node);
        for (const rect of range.getClientRects()) {
          lines.push({ top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right });
        }
      }
      return { box: { top: box.top, bottom: box.bottom }, lines };
    }),
  );
  for (const { box, lines } of layout) {
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      // Above or below the picture, never level with it.
      expect(
        line.bottom <= box.top + 1 || line.top >= box.bottom - 1,
        JSON.stringify({ box, line }),
      ).toBe(true);
    }
  }

  // The markdown in the repository is as written: the picture stays inline in its item.
  await expect
    .poll(() => remoteMarkdown(host, remote, id) ?? '')
    .toContain(`wider![|100](attachments/${sha256}.png)`);
  expect(errors).toEqual([]);
});
