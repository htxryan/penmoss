import { expect, test, type Page } from './fixtures';
import { NEW_FOLDER, NEW_NOTE } from './keys';
import { noteAction } from './note-menu';
import { notebookAction } from './notebook-actions';
import { storedSetting } from './stored';

// T53: Ryan's feedback of 1 Nov 2026 ("Penmoss Feedback 2026-11-01"), in the web app (the Mac
// app runs the same page; its own suite covers what differs there). On a git notebook (T59) the
// sidebar's layout and Quick Access are the notebook's device settings (A827), stored here.

const ULID = /\/notes\/([0-9A-HJKMNP-TV-Z]{26})$/;
const RUN = `h${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(error.message));
  return errors;
}

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

const radius = (page: Page, selector: string) =>
  page
    .locator(selector)
    .first()
    .evaluate((element) => getComputedStyle(element).borderRadius);

test('1, 3: the rail starts at the top, square; Today and This Week show when their note is open', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');
  await newNote(page, `Rail ${RUN}`, 'Not a journal note.');
  const today = page.locator('.sb-shortcut[data-command="journal.today"]');
  const week = page.locator('.sb-shortcut[data-command="journal.thisWeek"]');
  await expect(today).not.toHaveAttribute('aria-current', 'page');
  await expect(week).not.toHaveAttribute('aria-current', 'page');

  await today.click();
  await expect(page.getByTestId('note-view')).toHaveAttribute('data-ready', 'true');
  await expect(today).toHaveAttribute('aria-current', 'page');
  await expect(week).not.toHaveAttribute('aria-current', 'page');
  await week.click();
  await expect(week).toHaveAttribute('aria-current', 'page');
  await expect(today).not.toHaveAttribute('aria-current', 'page');

  // The rail: its first button at the very top, every highlight square. Beside a note, Back and
  // Forward start the note's title bar, so the toggle is first (PEN-135 item 6).
  await page.getByTestId('toggle-sidebar').click();
  await expect(page.getByTestId('app-root')).toHaveAttribute('data-sidebar', 'collapsed');
  const sidebar = (await page.locator('#app-sidebar').boundingBox())!;
  const first = (await page.getByTestId('toggle-sidebar').boundingBox())!;
  expect(first.y - sidebar.y).toBeLessThan(1);
  await expect(page.locator('.note-top').getByTestId('app-back')).toBeVisible();
  await expect(week).toHaveAttribute('aria-current', 'page');
  for (const selector of [
    '.history-pair',
    '.history-pair .history-half',
    '.sb-shortcut.new-note',
    'button[data-command="journal.thisWeek"]',
    '.sb-collapse',
  ]) {
    expect(await radius(page, selector), selector).toBe('0px');
  }
  await page.getByTestId('toggle-sidebar').click();

  // Square everywhere else too: buttons, fields, menus.
  await page.getByTestId('sidebar-settings').click();
  expect(await radius(page, '.btn, button.primary, .settings-nav a')).toBe('0px');
  expect(await radius(page, 'input:is([type="text"], [type="search"], :not([type])), select')).toBe(
    '0px',
  );
  expect(errors).toEqual([]);
});

/** Shows or hides a sidebar section in Settings → Display (T62 item 11), then goes back. */
async function toggleSection(page: Page, section: string): Promise<void> {
  await page.getByTestId('sidebar-settings').click();
  await page.getByRole('navigation', { name: 'Settings sections' }).getByText('Display').click();
  await page.getByTestId(`display-section-${section}`).click();
  await page.goBack();
  await page.goBack();
  await expect(page.locator('#app-sidebar')).toBeVisible();
}

const tree = (page: Page) => page.getByRole('tree', { name: 'Folders and notes' });
const row = (page: Page, name: string) => tree(page).getByRole('treeitem', { name, exact: true });

test('4, 5, 12: New Note on a notebook and a folder; New Folder Here and New Note Here beside a note', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.goto('/');
  await expect(page.locator('button[data-command="note.new"]').first()).toBeVisible();

  // The notebook's actions are on its name's row, hidden until hovered; the dot stays last.
  const head = page.locator('#app-sidebar .sb-section-head:has(.tree-actions)').first();
  await page.mouse.move(900, 400);
  await expect(head.locator('.tree-actions')).toBeHidden();
  await head.hover();
  const actions = (await head.locator('.tree-actions').boundingBox())!;
  const dot = (await head.locator('.sync-dot').first().boundingBox())!;
  expect(dot.x).toBeGreaterThanOrEqual(actions.x + actions.width - 1);
  // Open or Close Notebooks is not in the top row: with git notebooks only there are no Penmoss
  // notebooks to open or close (A828).
  await expect(page.getByTestId('sidebar-shortcuts').getByTestId('open-notebooks')).toHaveCount(0);

  // New Folder from the notebook's row.
  const box = `Box ${RUN}`;
  await (await notebookAction(page, 'New Folder')).click();
  const input = page.getByRole('textbox', { name: 'New folder name' });
  await input.fill(box);
  await input.press('Enter');
  await expect(row(page, box)).toBeVisible();
  const boxLevel = Number(await row(page, box).getAttribute('aria-level'));

  // A folder's hover actions start with New Note: a note in it, opened.
  await row(page, box).hover();
  await row(page, box).getByTestId('folder-row-new-note').click();
  await expect(page).toHaveURL(ULID);
  await expect(page.getByTestId('note-title')).toBeFocused();
  const inside = `Inside ${RUN}`;
  await page.keyboard.type(inside);
  await expect(row(page, inside)).toHaveAttribute('aria-level', String(boxLevel + 1));

  // The folder's menu has New Folder Here after New Note Here.
  await row(page, box).click({ button: 'right' });
  const folderMenu = page.getByRole('menu');
  await expect(folderMenu.getByRole('menuitem').nth(0)).toHaveText(/New Note Here/);
  await expect(folderMenu.getByRole('menuitem').nth(1)).toHaveText(/New Folder Here/);
  await page.keyboard.press('Escape');

  // A note's menu starts with New Note Here and New Folder Here, beside it in its folder.
  await row(page, inside).click({ button: 'right' });
  await page.getByTestId('note-new-folder').click();
  const sibling = `Sibling ${RUN}`;
  await page.getByRole('textbox', { name: 'New folder name' }).fill(sibling);
  await page.getByRole('textbox', { name: 'New folder name' }).press('Enter');
  await expect(row(page, sibling)).toHaveAttribute('aria-level', String(boxLevel + 1));
  await row(page, inside).click({ button: 'right' });
  await page.getByTestId('note-new-note').click();
  await expect(page.getByTestId('note-title')).toBeFocused();
  const next = `Next to it ${RUN}`;
  await page.keyboard.type(next);
  await expect(row(page, next)).toHaveAttribute('aria-level', String(boxLevel + 1));

  // The notebook's New Note: a note at its top level.
  await (await notebookAction(page, 'New Note in This Notebook')).click();
  await expect(page.getByTestId('note-title')).toBeFocused();
  const top = `Top ${RUN}`;
  await page.keyboard.type(top);
  await expect(row(page, top)).toHaveAttribute('aria-level', String(boxLevel));
  expect(errors).toEqual([]);
});

test('8: sections hide, show and move from their titles and the ⋯ menu; Recent Notes lists the last notes', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/');
  const first = await newNote(page, `Recent one ${RUN}`, 'First.');
  const second = await newNote(page, `Recent two ${RUN}`, 'Second.');
  const recent = page.getByTestId('recent-notes');
  await expect(recent.getByTestId('recent-note').first()).toHaveAttribute(
    'href',
    `/notes/${second}`,
  );
  await expect(recent.getByTestId('recent-note').nth(1)).toHaveAttribute('href', `/notes/${first}`);
  await expect(page.getByTestId('notebooks').locator('.sb-section-name').first()).toHaveText(
    'Notebooks',
  );

  // Settings → Display shows or hides each (the sidebar's ⋯ menu moved there, T62 item 11).
  await expect(page.getByTestId('sidebar-more')).toHaveCount(0);
  await toggleSection(page, 'recent');
  await expect(page.getByTestId('sidebar-section-recent')).toHaveCount(0);
  await expect.poll(() => storedSetting(page, 'sidebar.hiddenSections')).toEqual(['recent']);
  await toggleSection(page, 'recent');
  await expect(page.getByTestId('sidebar-section-recent')).toBeVisible();

  // A title's ✕ hides its section; its handle moves it from the keyboard.
  const calendar = page.getByTestId('sidebar-section-calendar');
  await calendar.locator('.sb-section-head').first().hover();
  await calendar.getByTestId('section-hide').click();
  await expect(calendar).toHaveCount(0);
  await toggleSection(page, 'calendar');
  await expect(calendar).toBeVisible();

  const order = () =>
    page
      .locator('#app-sidebar .sb-part[data-section]')
      .evaluateAll((parts) => parts.map((part) => part.getAttribute('data-section')));
  const before = await order();
  const tags = page.getByTestId('sidebar-section-tags');
  // Shown while the title row is hovered or holds focus (Tab from the title reaches it).
  await tags.locator('.sb-section-head').first().hover();
  await tags.getByTestId('section-move').focus();
  await page.keyboard.press('ArrowUp');
  const moved = [...before];
  const at = moved.indexOf('tags');
  [moved[at - 1], moved[at]] = [moved[at]!, moved[at - 1]!];
  await expect.poll(order).toEqual(moved);
  // ↓ moves it back, and the handle keeps focus for another press.
  await page.keyboard.press('ArrowDown');
  await expect.poll(order).toEqual(before);
  await expect(tags.getByTestId('section-move')).toBeFocused();
  // Stored as it was.
  await expect.poll(() => storedSetting(page, 'sidebar.sectionOrder')).toEqual(before);
  // Hidden or collapsed, Notebooks still answers New Folder, and shows itself to name it.
  await toggleSection(page, 'notebooks');
  await expect(page.getByTestId('sidebar-section-notebooks')).toBeHidden();
  await page.keyboard.press(NEW_FOLDER);
  await expect(page.getByTestId('sidebar-section-notebooks')).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'New folder name' })).toBeFocused();
  await page.keyboard.press('Escape');
  const notebooksToggle = page.getByTestId('notebooks').locator('.sb-section-toggle').first();
  await notebooksToggle.click();
  await expect(notebooksToggle).toHaveAttribute('aria-expanded', 'false');
  await page.keyboard.press(NEW_FOLDER);
  await expect(notebooksToggle).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByRole('textbox', { name: 'New folder name' })).toBeFocused();
  await page.keyboard.press('Escape');

  // The lines between sections run edge to edge.
  const part = (await tags.boundingBox())!;
  const sidebar = (await page.locator('#app-sidebar').boundingBox())!;
  expect(Math.abs(part.x - sidebar.x)).toBeLessThan(1.5);
  await expect.poll(() => storedSetting(page, 'sidebar.hiddenSections')).toEqual([]);
  expect(errors).toEqual([]);
});

test("4–5, follow-up (A990): a folder's hover actions lie over its row, so hovering moves nothing", async ({
  page,
}) => {
  const errors = collectErrors(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/');
  const name = `Hover Folder ${RUN}`;
  await expect(tree(page)).toBeVisible();
  await page.keyboard.press(NEW_FOLDER);
  await page.getByRole('textbox', { name: 'New folder name' }).fill(name);
  await page.keyboard.press('Enter');
  const folder = row(page, name);
  await expect(folder).toBeVisible();
  const actions = folder.locator('.row-actions');
  // Made from the keyboard, the folder has focus, which shows its actions too.
  await folder.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.mouse.move(900, 450);
  await expect(actions).toBeHidden();
  const label = folder.locator('.tree-label');
  await folder.scrollIntoViewIfNeeded();
  const before = await label.boundingBox();

  await folder.hover();
  await expect(actions).toBeVisible();
  // The name keeps its box: the actions take no room in the row's flow.
  expect(await label.boundingBox()).toEqual(before);
  const box = (await actions.boundingBox())!;
  const rowBox = (await folder.boundingBox())!;
  expect(box.y).toBeGreaterThanOrEqual(rowBox.y);
  expect(box.y + box.height).toBeLessThanOrEqual(rowBox.y + rowBox.height);
  expect(box.x + box.width).toBeLessThanOrEqual(rowBox.x + rowBox.width);
  // On the row's own colour, opaque, so the name never shows through.
  const colour = await actions.evaluate((element) => getComputedStyle(element).backgroundImage);
  expect(colour).not.toBe('none');

  // Still a working control: New Note (its only button since A1120) makes a note in the folder.
  await expect(actions.getByRole('button')).toHaveCount(1);
  await folder.getByRole('button', { name: `New Note in ${name}` }).click();
  await expect(page).toHaveURL(/\/notes\/[0-9A-HJKMNP-TV-Z]{26}$/);
  await expect(page.getByTestId('note-title')).toBeFocused();
  expect(errors).toEqual([]);
});

test('10: Quick Access removes from its menu, reorders, and names the notebook when asked', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/');
  const a = await newNote(page, `Pin A ${RUN}`, 'A.');
  await noteAction(page, 'pin-quick-access');
  const b = await newNote(page, `Pin B ${RUN}`, 'B.');
  await noteAction(page, 'pin-quick-access');
  const pins = page.getByTestId('quick-access').getByTestId('quick-access-note');
  const ids = () =>
    pins.evaluateAll((links) =>
      links.map((link) => link.getAttribute('data-note-id')).filter((id) => id !== null),
    );
  await expect.poll(async () => (await ids()).slice(-2)).toEqual([a, b]);

  // Alt+↑ moves the focused pin up.
  await page.getByTestId('quick-access').locator(`[data-note-id="${b}"]`).focus();
  await page.keyboard.press('Alt+ArrowUp');
  await expect.poll(async () => (await ids()).slice(-2)).toEqual([b, a]);

  // Settings → Display: each pin's notebook under its title.
  await page.goto('/settings/display');
  await expect(page.getByTestId('quick-access-notebook')).not.toBeChecked();
  await page.getByTestId('quick-access-notebook').check();
  await expect.poll(() => storedSetting(page, 'quickAccess.showNotebook')).toBe(true);
  await page.goBack();
  // The git notebook's name.
  await expect(
    page.getByTestId('quick-access').locator(`[data-note-id="${a}"] .sb-item-notebook`),
  ).toHaveText('Notes');

  // Right-click: Remove from Quick Access, for both.
  for (const id of [a, b]) {
    await page
      .getByTestId('quick-access')
      .locator(`[data-note-id="${id}"]`)
      .click({ button: 'right' });
    await page.getByTestId('quick-access-remove').click();
    await expect(page.locator(`[data-testid="quick-access"] [data-note-id="${id}"]`)).toHaveCount(
      0,
    );
  }
  await page.goto('/settings/display');
  await expect(page.getByTestId('quick-access-notebook')).toBeChecked();
  await page.getByTestId('quick-access-notebook').uncheck();
  await expect.poll(() => storedSetting(page, 'quickAccess.showNotebook')).toBe(false);
  expect(errors).toEqual([]);
});

test('10, follow-up: Quick Access shows with no pins; a note dragged in from Notebooks or Recent Notes is pinned', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/');
  const section = page.getByTestId('quick-access');
  const pins = section.getByTestId('quick-access-note');
  const ids = () =>
    pins.evaluateAll((links) =>
      links.map((link) => link.getAttribute('data-note-id')).filter((id) => id !== null),
    );
  const unpinAll = async () => {
    // One at a time: a second Remove on a pin still showing would pin it again.
    for (let left = await pins.count(); left > 0; left -= 1) {
      await pins.first().click({ button: 'right' });
      await page.getByTestId('quick-access-remove').click();
      await expect(pins).toHaveCount(left - 1);
    }
  };
  // Recent Notes shows for the drag from it (a new notebook hides no section).
  await expect(page.getByTestId('sidebar-section-recent')).toBeVisible();
  const a = await newNote(page, `Drag Pin A ${RUN}`, 'A.');
  const b = await newNote(page, `Drag Pin B ${RUN}`, 'B.');
  // Other runs' pins may show late, as the note list comes in: only the end of the list is ours.
  const last = async (count: number) => (await ids()).slice(-count);

  // A note from Notebooks, dropped on the section's title: pinned, last.
  const treeRow = page.locator(`[role="treeitem"][data-key="note:${a}"]`);
  await treeRow.scrollIntoViewIfNeeded();
  await treeRow.dragTo(section.locator('.sb-section-head'));
  await expect.poll(() => last(1)).toEqual([a]);
  await expect
    .poll(
      async () => (((await storedSetting(page, 'quickAccess.notes')) ?? []) as string[]).slice(-1),
      { timeout: 15_000 },
    )
    .toEqual([a]);
  // Pinned, not moved: it is still in its notebook.
  await expect(treeRow).toBeVisible();

  // A note from Recent Notes, dropped on the top half of a pin: pinned before it.
  const recent = page.locator(`[data-testid="recent-note"][data-note-id="${b}"]`);
  const target = section.locator(`[data-note-id="${a}"]`);
  await recent.dragTo(target, { targetPosition: { x: 20, y: 3 } });
  await expect.poll(() => last(2)).toEqual([b, a]);

  // A pinned note dropped again moves, never twice.
  await treeRow.dragTo(section.locator(`[data-note-id="${b}"]`), {
    targetPosition: { x: 20, y: 3 },
  });
  await expect.poll(() => last(2)).toEqual([a, b]);
  expect((await ids()).filter((id) => id === a)).toHaveLength(1);

  // With nothing pinned the section still shows, quietly asking for a note.
  await unpinAll();
  await expect(section).toBeVisible();
  await expect(section.getByTestId('quick-access-empty')).toBeVisible();
  await expect
    .poll(async () => ((await storedSetting(page, 'quickAccess.notes')) ?? []) as string[], {
      timeout: 15_000,
    })
    .not.toContain(a);
  expect(errors).toEqual([]);
});

test('9: the note panel is vertical tabs, open or closed, with no tab row; Comments is off the bar', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await newNote(page, `Panel ${RUN}`, 'Some text.');
  const rail = page.getByTestId('note-rail');
  await expect(rail.getByRole('tablist')).toHaveAttribute('aria-orientation', 'vertical');
  await expect(page.getByTestId('toggle-comments')).toHaveCount(0);

  const comments = page.getByTestId('note-tab-comments');
  // A new note opens as the last one was left: closed, or open on any tab.
  if ((await page.locator('aside.note-side').count()) > 0) {
    await page.getByTestId('note-panel-close').click();
  }
  await expect(page.locator('.note-side')).toHaveCount(0);
  await comments.click();
  const side = page.locator('aside.note-side');
  await expect(side.locator('.note-side-head h2')).toHaveText('Comments');
  // No tab row inside: the strip is the only tab list.
  await expect(side.getByRole('tablist')).toHaveCount(0);
  await expect(page.getByRole('tablist')).toHaveCount(1);
  // Beside the note, not over it, on a wide window; no dialog.
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const text = (await page.locator('.note-body').boundingBox())!;
  const panel = (await side.boundingBox())!;
  expect(panel.x).toBeGreaterThanOrEqual(text.x + text.width - 1);
  // Another tab switches; the open one's icon closes it; Escape closes too.
  await page.getByTestId('note-tab-history').click();
  await expect(side.locator('.note-side-head h2')).toHaveText('History');
  await page.getByTestId('note-tab-history').click();
  await expect(side).toHaveCount(0);
  await page.getByTestId('note-tab-info').click();
  await expect(side).toBeVisible();
  await page.getByTestId('note-panel-close').focus();
  await page.keyboard.press('Escape');
  await expect(side).toHaveCount(0);
  await expect(page.getByTestId('note-tab-info')).toBeFocused();
  expect(errors).toEqual([]);
});

test('11: lists and quotes keep their place when the cursor leaves the body', async ({ page }) => {
  const errors = collectErrors(page);
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.goto('/');
  await newNote(page, `Steady text ${RUN}`, 'Intro');
  await page.keyboard.press('Enter');
  await page.keyboard.type('1. one');
  await page.keyboard.press('Enter');
  await page.keyboard.type('two');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await page.keyboard.type('> quoted');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await page.keyboard.type('end');
  const boxes = () =>
    page.locator('.note-body .ProseMirror > *').evaluateAll((blocks) =>
      blocks.map((block) => {
        const rect = block.getBoundingClientRect();
        return `${block.tagName} ${rect.top.toFixed(1)} ${rect.height.toFixed(1)}`;
      }),
    );
  const editing = await boxes();
  expect(editing.some((box) => box.startsWith('BLOCKQUOTE'))).toBe(true);
  await page.getByTestId('note-title').click();
  await expect(page.locator('.note-body .ProseMirror')).not.toHaveClass(/ProseMirror-focused/);
  expect(await boxes()).toEqual(editing);
  expect(errors).toEqual([]);
});

test('8, fidelity: every section title on the same columns and height, its tools never moving it', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.goto('/');
  await expect(page.getByTestId('sidebar-section-calendar')).toBeVisible();
  const heads = () =>
    page
      .locator('#app-sidebar .sb-part:not([hidden]) > section > .sb-section-head')
      .evaluateAll((all) =>
        all.map((head) => {
          const box = (el: Element | null) => {
            const b = el!.getBoundingClientRect();
            return [b.x, b.y, b.width, b.height].map((n) => Math.round(n * 10) / 10);
          };
          return {
            section: head.closest<HTMLElement>('.sb-part')!.dataset['section'],
            head: box(head),
            chevron: box(head.querySelector('.sb-section-toggle svg')),
            name: box(head.querySelector('.sb-section-name')),
          };
        }),
      );
  const before = await heads();
  expect(before.map((each) => each.section)).toEqual(
    expect.arrayContaining(['recent', 'notebooks', 'tags', 'calendar']),
  );
  // One column for the chevrons, one for the names, one height (A988).
  for (const key of ['chevron', 'name'] as const) {
    expect(new Set(before.map((each) => each[key][0])).size, key).toBe(1);
  }
  expect(new Set(before.map((each) => each.head[3])).size).toBe(1);
  // The rows under them start where the names do: Recent's icons, the tree's, Tags' #, the month.
  const nameX = before[0]!.name[0]!;
  const starts = await page.evaluate(() =>
    [
      '.sb-recent .sb-item svg',
      '.sb-notebooks-body .tree-row .tree-icon',
      '.tag-row .tag-hash',
      '.calendar-month',
    ].flatMap((selector) => {
      const found = document.querySelector(selector);
      return found ? [found.getBoundingClientRect().x] : [];
    }),
  );
  for (const x of starts) expect(Math.abs(x - nameX)).toBeLessThan(1);
  // Hovering a title shows its tools at the row's end, and nothing moves.
  for (const { section } of before) {
    await page.mouse.move(800, 500);
    const resting = await heads();
    await page
      .locator(`#app-sidebar .sb-part[data-section="${section}"] .sb-section-head`)
      .first()
      .hover();
    const tools = page.getByTestId(`sidebar-section-${section}`).getByTestId('section-tools');
    await expect(tools).toBeVisible();
    expect(await heads(), section).toEqual(resting);
    const right = await tools.evaluate((el) => el.getBoundingClientRect().right);
    const head = resting.find((each) => each.section === section)!.head;
    // Flush with the row's end, which is the sidebar's edge (A1097; feedback of 6 Nov 2026).
    expect(Math.abs(head[0]! + head[2]! - right), section).toBeLessThan(1);
  }
  expect(errors).toEqual([]);
});

test('8, fidelity: Settings, menus, Trash and search keep their columns, and choosing moves nothing', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await page.setViewportSize({ width: 1280, height: 860 });
  const box = (selector: string) =>
    page.locator(selector).evaluateAll((all) =>
      all.map((el) => {
        const b = el.getBoundingClientRect();
        return [b.x, b.y, b.width, b.height].map((n) => Math.round(n * 10) / 10);
      }),
    );
  // Settings → Display: a group's label and a field's label in one type, as far over their
  // controls, each group as far under what is above it (A988).
  await page.goto('/settings/display');
  const labels = page.locator(
    '.settings-content :is(.display-toggles > legend, .settings-field > span:first-child)',
  );
  await expect(labels.first()).toBeVisible();
  const type = await labels.evaluateAll((all) =>
    all.map((el) => {
      const style = getComputedStyle(el);
      return `${style.fontSize} ${style.fontWeight}`;
    }),
  );
  expect(type.length).toBeGreaterThan(2);
  expect(new Set(type).size).toBe(1);
  const above = await page
    .locator('.settings-content .settings-section > :is(.display-toggles, .settings-field)')
    .evaluateAll((all) =>
      all.map((el) => {
        const prev = el.previousElementSibling!.getBoundingClientRect();
        return Math.round(el.getBoundingClientRect().top - prev.bottom);
      }),
    );
  expect(new Set(above).size).toBe(1);
  // A section's actions are one height. (Settings → Notebooks, whose link drawn as a button this
  // measured, went with the server's notebooks, A912: the git notebook's card has the actions.)
  await page.goto('/settings/git-notebooks');
  await page.getByTestId('git-notebook-row').first().click();
  await expect(page.getByTestId('git-sync-now')).toBeVisible();
  const buttons = await box('[data-testid="git-notebook"] .settings-actions .btn');
  expect(buttons.length).toBeGreaterThan(1);
  expect(new Set(buttons.map((each) => each[3])).size).toBe(1);
  // Appearance → Note Panel (this device's own): choosing a segment moves none of them.
  await page.goto('/settings/appearance');
  const panel = page.getByTestId('note-panel-setting');
  await expect(panel).toBeVisible();
  const options = '[data-testid="note-panel-setting"] .seg-option';
  // In view first: a click on it would scroll the page, moving every box.
  await panel.scrollIntoViewIfNeeded();
  const resting = await box(options);
  const was = await panel.locator('input:checked').getAttribute('value');
  await panel.locator('.seg-option:not(:has(input:checked))').first().click();
  await expect(panel.locator(`input[value="${was}"]`)).not.toBeChecked();
  expect(await box(options)).toEqual(resting);
  await panel.locator(`.seg-option:has(input[value="${was}"])`).click();
  await expect(panel.locator(`input[value="${was}"]`)).toBeChecked();

  // The note's ⋯ menu: every item's keys end on one column, On or not.
  await page.goto('/');
  await newNote(page, `Columns ${RUN}`, `Lined up ${RUN}.`);
  await page.getByTestId('note-menu').click();
  if ((await page.locator('.menu [aria-checked="true"]').count()) === 0) {
    await page.getByTestId('toggle-markdown').click();
    await page.getByTestId('note-menu').click();
  }
  await expect(page.locator('.menu [aria-checked="true"]').first()).toBeVisible();
  const keys = await page
    .locator('.menu .menu-keys')
    .evaluateAll((all) => all.map((el) => Math.round(el.getBoundingClientRect().right)));
  expect(keys.length).toBeGreaterThan(2);
  expect(new Set(keys).size).toBe(1);
  await page.keyboard.press('Escape');

  // Search: the filters, the status line and the hits on the dialog's text edge.
  await page.keyboard.press('ControlOrMeta+Shift+KeyF');
  const search = page.getByTestId('search');
  await search.getByRole('combobox', { name: 'Search notes' }).fill(`Columns ${RUN}`);
  await expect(search.locator('.search-hit').first()).toBeVisible();
  const edges = await page.evaluate(() => {
    const x = (selector: string) => document.querySelector(selector)!.getBoundingClientRect().x;
    return [x('.search-icon'), x('.search-filter'), x('.search-hit-title')];
  });
  expect(Math.max(...edges) - Math.min(...edges)).toBeLessThan(1.5);
  await page.keyboard.press('Escape');

  // Trash: a note's title and line on one edge with every other row's, its icon in a column.
  await page.getByTestId('note-menu').click();
  await page.getByTestId('delete-note').click();
  await page.goto('/trash');
  await expect(page.locator('.trash-item').first()).toBeVisible();
  const columns = await page.evaluate(() =>
    ['.trash-info > .i', '.trash-title', '.trash-info > .muted'].map(
      (selector) =>
        new Set(
          [...document.querySelectorAll(selector)].map((el) =>
            Math.round(el.getBoundingClientRect().x),
          ),
        ).size,
    ),
  );
  expect(columns).toEqual([1, 1, 1]);
  expect(errors).toEqual([]);
});

test('9, fidelity: the note panel keeps one set of columns, rows and gaps on every tab', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');
  await newNote(page, `Fidelity ${RUN}`, 'The garden plan for spring.');
  const box = (selector: string) =>
    page
      .locator(selector)
      .first()
      .evaluate((el) => {
        const b = el.getBoundingClientRect();
        return { x: b.x, y: b.y, width: b.width, height: b.height, bottom: b.bottom };
      });
  const round = (n: number) => Math.round(n * 10) / 10;

  // A thread, for the count on the Comments tab's icon. Its composer's Cancel and Comment are
  // centred on one line, though one is a quiet button and shorter (A988).
  await page.getByTestId('note-body').locator('.ProseMirror p').first().click();
  await page.keyboard.press('Home');
  await page.keyboard.press('Shift+End');
  await page.getByTestId('selection-toolbar').getByRole('button', { name: 'Comment' }).click();
  await expect(page.getByTestId('comment-new')).toBeFocused();
  const centres = await page
    .getByTestId('comment-popover')
    .locator('.comment-composer-actions .btn')
    .evaluateAll((all) =>
      all.map((el) => {
        const b = el.getBoundingClientRect();
        return Math.round(b.y + b.height / 2);
      }),
    );
  expect(centres.length).toBeGreaterThan(1);
  expect(new Set(centres).size).toBe(1);
  await page.getByTestId('comment-new').fill('Tomatoes too?');
  await page.getByTestId('comment-new-send').click();
  await expect(page.getByTestId('comment-popover')).toHaveCount(0);
  await expect(page.getByTestId('comments-count')).toHaveText('1');
  // Pushed, so the Metadata tab's sync line does not change while it is measured.
  await expect(page.getByTestId('section-sync')).toHaveAttribute('data-state', 'synced', {
    timeout: 40_000,
  });
  await expect(page.getByTestId('section-sync')).toHaveAttribute('data-pending', '0', {
    timeout: 40_000,
  });

  // One digit's count is square, not wider than it is tall.
  const count = await box('[data-testid="comments-count"]');
  expect(count.width).toBeLessThanOrEqual(count.height + 0.5);

  // The bar's last action sits over the strip's icons, on one column.
  const rail = await page
    .locator('.note-rail-btn')
    .evaluateAll((all) =>
      all.map((el) => el.getBoundingClientRect()).map((b) => Math.round(b.x + b.width / 2)),
    );
  expect(new Set(rail).size).toBe(1);
  const last = await page
    .locator('.note-top .note-actions button')
    .last()
    .evaluate((el) => el.getBoundingClientRect().x + el.getBoundingClientRect().width / 2);
  expect(Math.abs(last - rail[0]!)).toBeLessThan(1);

  // Every tab's content starts the same distance under the head, in the same text size.
  const first = {
    info: '.note-side .info-list',
    comments: '.note-side .comments-filter',
    history: '.note-side .history-scroll',
    graph: '.note-side .note-graph-bar',
  } as const;
  const starts: number[] = [];
  const sizes: string[] = [];
  for (const [tab, selector] of Object.entries(first)) {
    const button = page.getByTestId(`note-tab-${tab}`);
    if ((await button.getAttribute('aria-selected')) !== 'true') await button.click();
    await expect(page.locator(selector)).toBeVisible();
    // A git notebook's backlinks are found on this device, and its versions read from git, a
    // moment after the tab opens.
    await expect(page.locator('.note-side').getByText('Looking for links…')).toHaveCount(0);
    if (tab === 'history') {
      await expect(
        page.locator('.note-side').getByRole('list', { name: 'Versions' }),
      ).toBeVisible();
    }
    const head = await box('.note-side-head');
    starts.push(round((await box(selector)).y - head.bottom));
    sizes.push(
      await page
        .locator('.note-tabpanel > *')
        .first()
        .evaluate((el) => getComputedStyle(el).fontSize),
    );
    // Hovering the strip's icons and Close moves nothing in the panel (the graph's own drawing,
    // which settles as it runs, aside).
    const boxes = () =>
      page
        .locator('.note-side *:not(.note-graph-canvas, .note-graph-canvas *), .note-rail *')
        .evaluateAll((all) =>
          all.map((el) => {
            const b = el.getBoundingClientRect();
            return [b.x, b.y, b.width, b.height].join();
          }),
        );
    await page.mouse.move(640, 700);
    // Settled first: a git notebook's tab reads from this device and git as it opens (a version's
    // changes come a moment after its list).
    await expect
      .poll(async () => {
        const before = JSON.stringify(await boxes());
        await page.waitForTimeout(300);
        return JSON.stringify(await boxes()) === before;
      })
      .toBe(true);
    const resting = await boxes();
    for (const target of ['note-tab-info', 'note-tab-graph', 'note-panel-close']) {
      await page.getByTestId(target).hover();
      expect(await boxes(), `${tab}: ${target}`).toEqual(resting);
    }
  }
  expect(new Set(starts).size, JSON.stringify(starts)).toBe(1);
  expect(new Set(sizes).size, JSON.stringify(sizes)).toBe(1);

  // Metadata: its rows one height, the details' and the frontmatter's values on one column, and
  // Backlinks as far under the frontmatter as Tags and Frontmatter are under what precedes them.
  await page.getByTestId('note-tab-info').click();
  await expect(page.locator('.note-side .bl-heading')).toBeVisible();
  // Settled first, as each tab is above: its frontmatter is read a moment after the tab opens,
  // and its names' column is as wide as their monospace text, once that font has loaded.
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  const measure = () =>
    page.locator('.note-side .note-info').evaluate((panel) => {
      const rect = (el: Element) => el.getBoundingClientRect();
      const r = (n: number) => Math.round(n * 10) / 10;
      const heads = [...panel.querySelectorAll('.info-subheading, .bl-heading')].map((head) => {
        const block = head.classList.contains('bl-heading') ? head.closest('.backlinks')! : head;
        return r(rect(head).top - rect(block.previousElementSibling!).bottom);
      });
      return {
        heights: [...panel.querySelectorAll('.info-list dt, .info-list dd')].map((el) =>
          r(rect(el).height),
        ),
        values: [...panel.querySelectorAll('.info-list dd, .info-frontmatter dd')].map((el) =>
          r(rect(el).x),
        ),
        heads,
      };
    });
  await expect
    .poll(async () => {
      const before = JSON.stringify(await measure());
      await page.waitForTimeout(300);
      return JSON.stringify(await measure()) === before;
    })
    .toBe(true);
  const info = await measure();
  expect(new Set(info.heights).size, JSON.stringify(info.heights)).toBe(1);
  expect(new Set(info.values).size, JSON.stringify(info.values)).toBe(1);
  expect(info.heads.length).toBe(3);
  expect(new Set(info.heads).size, JSON.stringify(info.heads)).toBe(1);
  expect(errors).toEqual([]);
});
