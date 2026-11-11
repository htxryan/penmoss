import { expect, test, type BrowserContext, type Page } from './fixtures';
import { DOC_END, NEW_NOTE, NOTE_WINDOW } from './keys';
import { noteAction } from './note-menu';

// T45 (#108, D37, A710, A711): a note in a window of its own. Every entry point opens one;
// links navigate inside it with Back and Forward; ⌥-click opens another; edits show live in
// every window, through the windows' shared storage (A711), online and offline alike. The page
// runs as the Mac app's (T59), with the Mac's window rules (A712: a note window has no opener,
// any other page goes to the main window). The browser's blocked-popup toast went with the
// browser app (the Mac makes its windows itself). The Mac app's suite covers its own windows
// (apps/desktop/test/e2e/note-window.spec.ts).

const ULID = /\/notes\/([0-9A-HJKMNP-TV-Z]{26})$/;
const WINDOW = /\/window\/notes\/([0-9A-HJKMNP-TV-Z]{26})(\?.*)?$/;
const RUN = `w${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;

function collectErrors(page: Page, offline = false): string[] {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    if (offline && /ERR_INTERNET_DISCONNECTED|WebSocket|Failed to fetch|net::/.test(message.text()))
      return;
    errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(error.message));
  return errors;
}

const body = (page: Page) => page.getByTestId('note-body').locator('.ProseMirror');

async function newNote(page: Page, title: string, text: string): Promise<string> {
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

/** Runs `open` and returns the note window it opened, once its note shows. */
async function windowFrom(
  context: BrowserContext,
  open: () => Promise<unknown>,
  title: string,
): Promise<Page> {
  const [popup] = await Promise.all([context.waitForEvent('page'), open()]);
  await expect(popup).toHaveURL(WINDOW);
  await expect(popup.getByTestId('note-window')).toBeVisible();
  await expect(popup.getByTestId('note-title')).toHaveValue(title);
  await expect(popup.getByTestId('note-view')).toHaveAttribute('data-ready', 'true');
  // A note window (720 px) has no room for the panel beside the text: open, as by default, it
  // lies over the text (T53 item 9, A985). Closed here, so the tests reach the text.
  const columns = popup.locator('.note-columns');
  if ((await columns.getAttribute('data-panel')) === 'open') {
    await expect(columns).toHaveAttribute('data-over', '');
    await popup.getByTestId('note-panel-close').click();
    await expect(columns).toHaveAttribute('data-panel', 'closed');
  }
  return popup;
}

/** A note window: the note, Back and Forward, the ⋯ menu, Info and the status bar; no sidebar. */
async function expectNoteWindow(popup: Page, title: string) {
  await expect(popup.getByTestId('note-title')).toHaveValue(title);
  await expect(popup).toHaveTitle(`${title} – Penmoss`);
  await expect(popup.locator('#app-sidebar')).toHaveCount(0);
  await expect(popup.getByRole('navigation', { name: 'Breadcrumb' })).toHaveCount(0);
  await expect(popup.getByTestId('window-back')).toBeVisible();
  await expect(popup.getByTestId('window-forward')).toBeVisible();
  await expect(popup.getByTestId('note-menu')).toBeVisible();
  await expect(popup.getByTestId('status-bar')).toBeVisible();
  // A note window (720 px) is too narrow for the side panel beside the text: the tabs' icons run
  // down the note's edge, and the open tab lies over the text (T53 item 9, A985).
  await expect(popup.getByTestId('note-rail')).toBeVisible();
  const tab = popup.getByTestId('note-tab-info');
  if ((await tab.getAttribute('aria-selected')) !== 'true') await tab.click();
  const info = popup.getByRole('complementary', { name: 'Metadata' });
  await expect(info.getByTestId('note-info')).toBeVisible();
  await expect(popup.locator('.note-columns')).toHaveAttribute('data-over', '');
  await popup.getByTestId('note-panel-close').click();
  await expect(info).toHaveCount(0);
  await expect(popup.locator('.note-columns')).toHaveAttribute('data-panel', 'closed');
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 860 });
});

test('every entry point opens a note window: the note, its menu, Info and status bar, no sidebar', async ({
  page,
  context,
}) => {
  const errors = collectErrors(page);
  await page.goto('/');
  const title = `Window entry ${RUN}`;
  const id = await newNote(page, title, 'Seen in a window of its own.');
  const opened: Page[] = [];

  // The note's ⋯ menu.
  opened.push(await windowFrom(context, () => noteAction(page, 'open-in-window'), title));
  await expectNoteWindow(opened[0]!, title);
  expect(new URL(opened[0]!.url()).pathname).toBe(`/window/notes/${id}`);

  // Its shortcut, from the note.
  await body(page).click();
  opened.push(await windowFrom(context, () => page.keyboard.press(NOTE_WINDOW), title));

  // The palette.
  await body(page).click();
  opened.push(
    await windowFrom(
      context,
      async () => {
        await page.keyboard.press('ControlOrMeta+KeyK');
        const palette = page.getByRole('dialog', { name: 'Command Palette' });
        await palette.getByRole('combobox', { name: 'Command Palette' }).fill('open in new window');
        await expect(palette.getByRole('option').first()).toContainText('Open in New Window');
        await page.keyboard.press('Enter');
      },
      title,
    ),
  );

  // The sidebar's context menu, on one note.
  const row = page.getByTestId('note-list').getByRole('treeitem', { name: title, exact: true });
  opened.push(
    await windowFrom(
      context,
      async () => {
        await row.click({ button: 'right' });
        const menu = page.getByRole('menu', { name: `“${title}”` });
        // New Note Here and New Folder Here lead it (T53 item 12), then Open in New Window.
        await expect(menu.getByRole('menuitem').nth(2)).toHaveText('Open in New Window');
        await menu.getByRole('menuitem', { name: 'Open in New Window' }).click();
      },
      title,
    ),
  );

  // ⌥-click (Alt-click) on the sidebar row: a window, never a download.
  const downloads: string[] = [];
  page.on('download', (download) => downloads.push(download.url()));
  opened.push(
    await windowFrom(
      context,
      () =>
        page
          .getByTestId('note-list')
          .getByRole('link', { name: title, exact: true })
          .click({ modifiers: ['Alt'] }),
      title,
    ),
  );
  // Several windows on one note are allowed: each entry point opened a new one.
  expect(new Set(opened).size).toBe(5);
  for (const popup of opened) await expect(popup).toHaveURL(new RegExp(`/window/notes/${id}$`));
  expect(downloads).toEqual([]);
  // The main window stayed where it was.
  await expect(page).toHaveURL(new RegExp(`/notes/${id}$`));
  for (const popup of opened) await popup.close();
  expect(errors).toEqual([]);
});

test('links navigate inside the window, with Back and Forward; ⌥-click opens another window', async ({
  page,
  context,
}) => {
  const errors = collectErrors(page);
  await page.goto('/');
  const target = `Window target ${RUN}`;
  const source = `Window source ${RUN}`;
  const targetId = await newNote(page, target, 'The note a link leads to.');
  await newNote(page, source, 'See ');
  await page.keyboard.type(`[[${target}]]`);
  await page.keyboard.type(' for more.');
  await expect(body(page).locator('a.pm-wikilink')).toHaveText([target]);

  const popup = await windowFrom(context, () => noteAction(page, 'open-in-window'), source);
  const popupErrors = collectErrors(popup);
  const back = popup.getByTestId('window-back');
  const forward = popup.getByTestId('window-forward');
  await expect(back).toBeDisabled();
  await expect(forward).toBeDisabled();

  // A link opens its note in this window.
  await body(popup).locator('a.pm-wikilink', { hasText: target }).click();
  await expect(popup).toHaveURL(new RegExp(`/window/notes/${targetId}$`));
  await expect(popup.getByTestId('note-title')).toHaveValue(target);
  await expect(popup).toHaveTitle(`${target} – Penmoss`);
  await expect(popup.locator('#app-sidebar')).toHaveCount(0);
  await expect(back).toBeEnabled();
  await expect(forward).toBeDisabled();

  // Back and Forward, the window's own buttons.
  await back.click();
  await expect(popup.getByTestId('note-title')).toHaveValue(source);
  await expect(forward).toBeEnabled();
  await forward.click();
  await expect(popup.getByTestId('note-title')).toHaveValue(target);
  // And the browser's own.
  await popup.goBack();
  await expect(popup.getByTestId('note-title')).toHaveValue(source);
  await popup.goForward();
  await expect(popup.getByTestId('note-title')).toHaveValue(target);
  await popup.goBack();
  await expect(popup.getByTestId('note-title')).toHaveValue(source);
  await expect(popup.getByTestId('note-view')).toHaveAttribute('data-ready', 'true');

  // ⌥-click on the link: another window, on the linked note, and no download. (A click in the
  // text first: ProseMirror takes a second click at the same place within 500 ms for a double
  // click, and the plain click on the link was a moment ago.) The click lands at the line's right
  // end, past the text: `getByText` finds the whole paragraph, and its middle can fall on the link
  // where the fonts are wider (Linux CI), which would follow it.
  const line = body(popup).getByText('for more.');
  const box = (await line.boundingBox())!;
  await line.click({ position: { x: box.width - 4, y: box.height / 2 } });
  await expect(popup.getByTestId('note-title')).toHaveValue(source);
  const downloads: string[] = [];
  popup.on('download', (download) => downloads.push(download.url()));
  const second = await windowFrom(
    context,
    () =>
      body(popup)
        .locator('a.pm-wikilink', { hasText: target })
        .click({ modifiers: ['Alt'] }),
    target,
  );
  await expect(popup.getByTestId('note-title')).toHaveValue(source);
  await expectNoteWindow(second, target);
  expect(downloads).toEqual([]);

  // A page a note window does not show (Settings) opens in the window that opened it.
  await popup.keyboard.press('ControlOrMeta+Comma');
  await expect(page).toHaveURL(/\/settings(\/appearance)?$/);
  await expect(popup).toHaveURL(WINDOW);
  await second.close();
  await popup.close();
  expect(errors).toEqual([]);
  expect(popupErrors).toEqual([]);
});

test('two windows on one note: typing in one shows in the other, online and offline', async ({
  page,
  context,
  host,
}) => {
  const errors = collectErrors(page, true);
  await page.goto('/');
  const title = `Window live ${RUN}`;
  await newNote(page, title, 'Typed in the main window.');
  await expect(page.getByTestId('section-sync')).toHaveAttribute('data-state', 'synced', {
    timeout: 40_000,
  });
  const popup = await windowFrom(context, () => noteAction(page, 'open-in-window'), title);
  const popupErrors = collectErrors(popup, true);
  await expect(body(popup)).toContainText('Typed in the main window.');

  // Online: between the windows, within a second.
  await body(popup).click();
  await popup.keyboard.press(DOC_END);
  await popup.keyboard.type(' Typed in the note window.');
  await expect(body(page)).toContainText('Typed in the note window.', { timeout: 1000 });
  await body(page).click();
  await page.keyboard.press(DOC_END);
  await page.keyboard.type(' Back in the main window.');
  await expect(body(popup)).toContainText('Back in the main window.', { timeout: 1000 });

  // Offline: between the windows, through this browser's storage (A711).
  host.network = 'down';
  await context.setOffline(true);
  try {
    await body(popup).click();
    await popup.keyboard.press(DOC_END);
    await popup.keyboard.type(' Offline in the note window.');
    await expect(body(page)).toContainText('Offline in the note window.', { timeout: 1000 });
    await page.keyboard.press(DOC_END);
    await page.keyboard.type(' Offline in the main window.');
    await expect(body(popup)).toContainText('Offline in the main window.', { timeout: 1000 });
    // A rename shows in the window's title and the main window's sidebar.
    await popup.getByTestId('note-title').fill(`${title} renamed`);
    await expect(
      page.getByTestId('note-list').getByRole('link', { name: `${title} renamed`, exact: true }),
    ).toBeVisible({ timeout: 1000 });
  } finally {
    host.network = 'up';
    await context.setOffline(false);
  }
  // Each edit once, in both.
  for (const view of [page, popup]) {
    await expect(body(view)).toHaveText(
      'Typed in the main window. Typed in the note window. Back in the main window. Offline in the note window. Offline in the main window.',
    );
  }
  await popup.close();
  expect(errors).toEqual([]);
  expect(popupErrors).toEqual([]);
});

test('Move to Trash in a window keeps it, with Undo; the Mac shows no blocked-window toast', async ({
  page,
  context,
}) => {
  const errors = collectErrors(page);
  await page.goto('/');
  const title = `Window undo ${RUN}`;
  await newNote(page, title, 'Moved to Trash from its window.');

  const popup = await windowFrom(context, () => noteAction(page, 'open-in-window'), title);
  // The main window shows its home; the note window moves the note to Trash.
  await page.goto('/');
  await noteAction(popup, 'delete-note');
  await expect(popup.getByTestId('note-window-trashed')).toBeVisible();
  await expect(popup.getByTestId('trashed-toast')).toContainText('Moved');
  // The main window's sidebar lost it too.
  await expect(
    page.getByTestId('note-list').getByRole('link', { name: title, exact: true }),
  ).toHaveCount(0);
  await popup.getByTestId('trashed-undo').click();
  await expect(popup.getByTestId('note-title')).toHaveValue(title);
  await expect(body(popup)).toContainText('Moved to Trash from its window.');
  await expect(
    page.getByTestId('note-list').getByRole('link', { name: title, exact: true }),
  ).toBeVisible();
  // The Mac's main process made the window, so the page never offers a tab instead (A712).
  await expect(page.getByTestId('window-blocked')).toHaveCount(0);
  await popup.close();
  expect(errors).toEqual([]);
});
