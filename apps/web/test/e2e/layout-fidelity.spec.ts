// Pixel geometry: rows, titles and buttons that sit flush and keep their columns.
import { BUILT_IN_THEMES } from '@penmoss/ui/theme';
import { expect, type Page, test } from './fixtures';
import { collectErrors, newNote, ULID } from './support/app';

const RUN = `h${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
// T53, items 8, fidelity.
test('every section title on the same columns and height, its tools never moving it', async ({
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
// T53, items 8, fidelity.
test('Settings, menus, Trash and search keep their columns, and choosing moves nothing', async ({
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
  // Settings → Sidebar: every row's label in one type, and each group as far under its
  // subhead (A988, in PEN-146's rows).
  await page.goto('/settings/sidebar');
  const labels = page.locator('.settings-content .lf-row-label');
  await expect(labels.first()).toBeVisible();
  const type = await labels.evaluateAll((all) =>
    all.map((el) => {
      const style = getComputedStyle(el);
      return `${style.fontSize} ${style.fontWeight}`;
    }),
  );
  expect(type.length).toBeGreaterThan(2);
  expect(new Set(type).size).toBe(1);
  const above = await page.locator('.settings-content .lf-sub + .lf-group').evaluateAll((all) =>
    all.map((el) => {
      const prev = el.previousElementSibling!.getBoundingClientRect();
      return Math.round(el.getBoundingClientRect().top - prev.bottom);
    }),
  );
  expect(above.length).toBe(2);
  expect(new Set(above).size).toBe(1);
  // A section's actions are one height. (Settings → Notebooks, whose link drawn as a button this
  // measured, went with the server's notebooks, A912: the git notebook's page has the actions,
  // Sync Now in its header and its Overview's, PEN-146.)
  await page.goto('/settings/git-notebooks');
  await page.getByTestId('git-notebook-row').first().click();
  await expect(page.getByTestId('git-sync-now')).toBeVisible();
  const buttons = await box('[data-testid="git-notebook"] .btn');
  expect(buttons.length).toBeGreaterThan(1);
  expect(new Set(buttons.map((each) => each[3])).size).toBe(1);
  // Note → Note Panel (this device's own): choosing a segment moves none of them.
  await page.goto('/settings/note');
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

const SHOTS = process.env['PENMOSS_EVIDENCE'];
test.describe('in Quanta, with two notes', () => {
  test.use({
    seed: { name: 'Quanta', notes: [{ title: 'Current' }, { title: 'Penmoss Feedback' }] },
  });

  // Ryan’s feedback of 5 Nov 2026 (Quanta), items 1, 2.
  test('sidebar rows run edge to edge, and each section’s title row is boxed', async ({ page }) => {
    const errors = collectErrors(page);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto('/');
    const sidebar = page.locator('#app-sidebar');
    const row = sidebar
      .locator('.sb-notebooks-body .tree-row')
      .filter({ hasText: 'Penmoss Feedback' });
    await expect(row).toBeVisible({ timeout: 30_000 });
    await row.click();
    const edges = await page.evaluate(() => {
      const side = document.querySelector('#app-sidebar')!;
      const inner = side.getBoundingClientRect();
      const border = parseFloat(getComputedStyle(side).borderRightWidth);
      const box = (selector: string) => {
        const b = document.querySelector(selector)!.getBoundingClientRect();
        return [b.left - inner.left, inner.right - border - b.right];
      };
      return {
        tree: box(
          '.sb-notebooks-body .tree-row[aria-selected="true"], .sb-notebooks-body .tree-row',
        ),
        recent: box('.sb-recent .sb-item'),
        head: box('.sb-part:not([hidden]) .sb-part-head'),
      };
    });
    // No margin either side: the rows and the title rows touch the sidebar's edges.
    for (const [where, [left, right]] of Object.entries(edges)) {
      expect(Math.abs(left!), `${where} left`).toBeLessThan(1);
      expect(Math.abs(right!), `${where} right`).toBeLessThan(1);
    }
    // Each section's title row has a line above and below it.
    const borders = await sidebar
      .locator('.sb-part:not([hidden]) .sb-part-head')
      .evaluateAll((heads) =>
        heads.map((head) => {
          const style = getComputedStyle(head);
          return [style.borderTopWidth, style.borderBottomWidth, style.borderTopStyle];
        }),
      );
    expect(borders.length).toBeGreaterThanOrEqual(3);
    for (const each of borders) expect(each).toEqual(['1px', '1px', 'solid']);
    // A notebook's own title row is not one of them.
    await expect(sidebar.locator('.sb-section .sb-notebook-name').first()).toBeVisible();
    expect(
      await sidebar
        .locator('.sb-notebooks-body .sb-section-head')
        .first()
        .evaluate((head) => getComputedStyle(head).borderBottomWidth),
    ).toBe('0px');
    if (SHOTS) await sidebar.screenshot({ path: `${SHOTS}/sidebar.png` });
    expect(errors).toEqual([]);
  });
});

const sidebar = (page: Page) => page.locator('#app-sidebar');

const section = (page: Page, name: string) =>
  page.getByTestId('source-section').and(page.getByRole('region', { name, exact: true }));

const tree = (page: Page, name: string) =>
  section(page, name).getByRole('tree', { name: 'Folders and notes' });

const background = (page: Page, selector: string) =>
  page
    .locator(selector)
    .first()
    .evaluate((element) => getComputedStyle(element).backgroundColor);

async function openNote(page: Page, notebook: string, title: string): Promise<string> {
  await tree(page, notebook).getByRole('link', { name: title, exact: true }).click();
  await expect(page).toHaveURL(ULID);
  await expect(page.getByTestId('note-title')).toHaveValue(title);
  return ULID.exec(new URL(page.url()).pathname)![1]!;
}
test.describe('in Quanta, with two folders and two notes', () => {
  test.use({
    seed: {
      name: 'Quanta',
      folders: ['Substation', 'Geotech'],
      notes: [{ title: 'Alpha' }, { title: 'Penmoss Feedback' }],
    },
  });

  // Ryan’s feedback of 5 Nov 2026 (Personal), items 2, 3, 8, 7.
  test('title rows shaded, a notebook’s row shading whole, no gap between notebooks, Feedback’s own icon', async ({
    page,
    host,
  }) => {
    test.setTimeout(120_000);
    const errors = collectErrors(page);
    await host.seed({ name: 'Personal', notes: [{ title: 'Test' }] });
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto('/');
    await expect(tree(page, 'Personal').getByRole('treeitem', { name: 'Test' })).toBeVisible({
      timeout: 30_000,
    });

    // 2: Notebooks' title row is shaded; a notebook's own row is not.
    const head = await background(page, '[data-section="notebooks"] .sb-part-head');
    const notebookHead = await background(page, '.sb-source > .sb-section-head');
    expect(head).not.toBe('rgba(0, 0, 0, 0)');
    expect(notebookHead).toBe('rgba(0, 0, 0, 0)');

    // 3: the pointer on a notebook's row shades the whole row, buttons and dot included, and a
    // button under the pointer stands out from it.
    const row = section(page, 'Quanta').locator('.sb-section-head').first();
    await row.locator('.sb-notebook-name').hover();
    const rowBox = (await row.boundingBox())!;
    const shaded = await row.evaluate((element) => getComputedStyle(element).backgroundColor);
    expect(shaded).not.toBe('rgba(0, 0, 0, 0)');
    const sideBox = (await sidebar(page).boundingBox())!;
    expect(rowBox.x + rowBox.width).toBeGreaterThan(sideBox.x + sideBox.width - 2);
    const button = row.locator('.tree-actions .icon-btn').first();
    await button.hover();
    const buttonShade = await button.evaluate(
      (element) => getComputedStyle(element).backgroundColor,
    );
    expect(buttonShade).not.toBe('rgba(0, 0, 0, 0)');
    expect(buttonShade).not.toBe(shaded);
    if (SHOTS) await sidebar(page).screenshot({ path: `${SHOTS}/sidebar.png` });

    // 8: the next notebook's row follows the last row closely.
    const last = (await tree(page, 'Quanta').getByRole('treeitem').last().boundingBox())!;
    const next = (await section(page, 'Personal').locator('.sb-section-head').boundingBox())!;
    expect(next.y - (last.y + last.height)).toBeLessThan(20);

    // 7: Send Feedback's icon is not the comments' bubble.
    await openNote(page, 'Quanta', 'Alpha');
    const feedback = await page
      .getByTestId('sidebar-feedback')
      .locator('svg')
      .evaluate((svg) => svg.innerHTML);
    const comments = await page
      .getByTestId('note-tab-comments')
      .locator('svg')
      .evaluate((svg) => svg.innerHTML);
    expect(feedback).not.toBe(comments);
    expect(errors).toEqual([]);
  });
});

type Edges = { left: number; right: number; top: number; bottom: number };

const edges = (page: Page, selector: string): Promise<Edges> =>
  page
    .locator(selector)
    .first()
    .evaluate((element) => {
      const b = element.getBoundingClientRect();
      return { left: b.left, right: b.right, top: b.top, bottom: b.bottom };
    });

type Point = { readonly x: number; readonly y: number };

type Rgb = readonly [number, number, number];

/**
 * The colours at `points` as drawn on screen: read from a screenshot, so translucent layers
 * (`--pm-hover` and `--pm-active` are) are composited as a person sees them.
 */
async function pixels(page: Page, points: readonly Point[]): Promise<Rgb[]> {
  const png = [...(await page.screenshot())];
  return page.evaluate(
    async ({ png, points }) => {
      const bitmap = await createImageBitmap(
        new Blob([new Uint8Array(png)], { type: 'image/png' }),
      );
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const context = canvas.getContext('2d')!;
      context.drawImage(bitmap, 0, 0);
      const scale = bitmap.width / innerWidth;
      return points.map(({ x, y }) => {
        const [r, g, b] = context.getImageData(
          Math.round(x * scale),
          Math.round(y * scale),
          1,
          1,
        ).data;
        return [r!, g!, b!] as const;
      });
    },
    { png, points },
  );
}

/** WCAG relative luminance, 0 to 1. */
function luminance([r, g, b]: Rgb): number {
  const channel = (value: number) => {
    const c = value / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

const contrast = (a: Rgb, b: Rgb) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
};

const same = (a: Rgb, b: Rgb) => a.every((value, index) => Math.abs(value - b[index]!) <= 1);

/** A point 2 px inside a box's top-left corner: its background, clear of its icon. */
const corner = (b: Edges): Point => ({ x: b.left + 2, y: b.top + 2 });

/**
 * A title row's tools and a notebook's buttons (item 2) and an empty Quick Access's words
 * (item 4), in one theme and mode: where they sit, and their colours as drawn.
 */
async function checkSidebar(page: Page, label: string, dark: boolean): Promise<void> {
  const head = '#app-sidebar .sb-part[data-section="notebooks"] .sb-part-head';
  const tools = page.getByTestId('sidebar-section-notebooks').getByTestId('section-tools');
  // The tools show once the pointer is on the row (hidden until then, so not hoverable).
  await page.locator(head).hover();
  await tools.getByTestId('section-move').hover();
  await expect(tools, label).toBeVisible();
  const row = await page.locator(head).evaluate((element) => {
    const b = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return {
      left: b.left,
      right: b.right - parseFloat(style.borderRightWidth),
      top: b.top + parseFloat(style.borderTopWidth),
      bottom: b.bottom - parseFloat(style.borderBottomWidth),
    };
  });
  const buttons = await tools.locator('.icon-btn').evaluateAll((all) =>
    all.map((element) => {
      const b = element.getBoundingClientRect();
      return { left: b.left, right: b.right, top: b.top, bottom: b.bottom };
    }),
  );
  expect(buttons, label).toHaveLength(2);
  // Flush with the row's end, its full height, square, touching.
  expect(Math.abs(buttons.at(-1)!.right - row.right), label).toBeLessThan(0.6);
  for (const button of buttons) {
    expect(Math.abs(button.top - row.top), label).toBeLessThan(0.6);
    expect(Math.abs(button.bottom - row.bottom), label).toBeLessThan(0.6);
    expect(Math.abs(button.right - button.left - (button.bottom - button.top)), label).toBeLessThan(
      0.6,
    );
  }
  expect(Math.abs(buttons[1]!.left - buttons[0]!.right), label).toBeLessThan(0.6);
  // As drawn: the ✕ not under the pointer is the row's own shade, not a strip of its own; the
  // handle under it is a step towards the text colour (darker in light, lighter in dark).
  const middle = (row.top + row.bottom) / 2;
  await expect
    .poll(async () => {
      const [shade, close, hovered] = await pixels(page, [
        { x: row.left + 3, y: middle },
        corner(buttons[1]!),
        corner(buttons[0]!),
      ]);
      return (
        same(shade!, close!) &&
        (dark
          ? luminance(hovered!) > luminance(shade!)
          : luminance(hovered!) < luminance(shade!)) &&
        contrast(hovered!, shade!) > 1.08
      );
    }, label)
    .toBe(true);

  // A notebook's row: its buttons and sync dot flush at the end and its full height.
  const notebook = '#app-sidebar .sb-source > .sb-section-head';
  const dot = section(page, 'Quanta').getByTestId('section-sync');
  await dot.hover();
  await expect(section(page, 'Quanta').getByTestId('tree-actions'), label).toBeVisible();
  const line = await edges(page, notebook);
  expect(line.bottom - line.top, label).toBeGreaterThanOrEqual(28.2);
  const targets = await page
    .locator(`${notebook} :is(.tree-actions .icon-btn, .sync-dot)`)
    .evaluateAll((all) =>
      // Those shown: New Note, New Folder and ⋯ at any width (R2-21), then the dot.
      all
        .filter((element) => element.getClientRects().length > 0)
        .map((element) => {
          const b = element.getBoundingClientRect();
          return { left: b.left, right: b.right, top: b.top, bottom: b.bottom };
        }),
    );
  expect(targets.length, label).toBeGreaterThan(2);
  expect(Math.abs(targets.at(-1)!.right - line.right), label).toBeLessThan(0.6);
  for (const target of targets) {
    expect(Math.abs(target.top - line.top), label).toBeLessThan(0.6);
    expect(Math.abs(target.bottom - line.bottom), label).toBeLessThan(0.6);
  }
  await expect
    .poll(async () => {
      const [shade, other, hovered] = await pixels(page, [
        { x: line.left + 3, y: (line.top + line.bottom) / 2 },
        corner(targets[0]!),
        corner(targets.at(-1)!),
      ]);
      return (
        same(shade!, other!) &&
        (dark
          ? luminance(hovered!) > luminance(shade!)
          : luminance(hovered!) < luminance(shade!)) &&
        contrast(hovered!, shade!) > 1.08
      );
    }, label)
    .toBe(true);

  // An open, empty Quick Access: "No notes", readable on the sidebar (4.5:1).
  const none = page.getByTestId('quick-access-none');
  await expect(none, label).toHaveText('No notes');
  const words = await edges(page, '[data-testid="quick-access-none"]');
  const text = await none.evaluate((element) => {
    const probe = document.createElement('canvas').getContext('2d')!;
    probe.fillStyle = getComputedStyle(element).color;
    probe.fillRect(0, 0, 1, 1);
    const [r, g, b] = probe.getImageData(0, 0, 1, 1).data;
    return [r!, g!, b!] as const;
  });
  await page.mouse.move(800, 500);
  const [panel] = await pixels(page, [{ x: words.left + 3, y: words.top + 3 }]);
  expect(contrast(text, panel!), label).toBeGreaterThanOrEqual(4.5);
}
test.describe('in Quanta, with a folder and two notes', () => {
  test.use({
    seed: {
      name: 'Quanta',
      folders: ['Substation'],
      notes: [{ title: 'Alpha' }, { title: 'Beta' }],
    },
  });

  // Ryan’s feedback of 6 Nov 2026 (Personal), items 2, 4.
  test('in every theme, light and dark, the tools and buttons sit flush and shade alike; No notes reads', async ({
    page,
  }) => {
    test.setTimeout(240_000);
    const errors = collectErrors(page);
    await page.setViewportSize({ width: 1280, height: 860 });
    for (const theme of BUILT_IN_THEMES) {
      for (const mode of ['Light', 'Dark'] as const) {
        const label = `${theme.id} ${mode.toLowerCase()}`;
        await page.goto('/settings/appearance');
        const settings = page.getByTestId('appearance-settings');
        await settings.locator(`label.theme-card[data-theme-id="${theme.id}"]`).click();
        await settings.getByTestId('theme-mode').getByText(mode).click();
        await expect(page.locator('html')).toHaveAttribute('data-theme', theme.id);
        await expect(page.locator('html')).toHaveAttribute('data-mode', mode.toLowerCase());
        await page.goto('/');
        // Synced before measuring: on a slower machine the sync ended mid-check, and the row
        // redrawn then lost its hover (its tools hid) and its dot's shade.
        await expect(section(page, 'Quanta').getByTestId('section-sync')).toHaveAttribute(
          'data-state',
          'synced',
          { timeout: 40_000 },
        );
        await checkSidebar(page, label, mode === 'Dark');
        if (SHOTS) {
          // The title row's handle, then a notebook's sync dot, under the pointer.
          await page
            .locator('#app-sidebar .sb-part[data-section="notebooks"] .sb-part-head')
            .hover();
          await page.getByTestId('sidebar-section-notebooks').getByTestId('section-move').hover();
          await page.screenshot({
            path: `${SHOTS}/themes/${theme.id}-${mode.toLowerCase()}-a.png`,
            clip: { x: 0, y: 90, width: 272, height: 230 },
          });
          await section(page, 'Quanta').getByTestId('section-sync').hover();
          await page.screenshot({
            path: `${SHOTS}/themes/${theme.id}-${mode.toLowerCase()}-b.png`,
            clip: { x: 0, y: 90, width: 272, height: 230 },
          });
        }
      }
    }
    expect(errors).toEqual([]);
  });
});

const LONG = Array.from({ length: 80 }, (_, n) => `Line ${n + 1} of a long note.`).join('\n\n');

async function openNoteIn(page: Page, title: string, notebook = 'Quanta'): Promise<void> {
  await section(page, notebook)
    .getByRole('tree', { name: 'Folders and notes' })
    .getByRole('link', { name: title, exact: true })
    .click();
  await expect(page).toHaveURL(ULID);
  await expect(page.getByTestId('note-title')).toHaveValue(title);
}

const box = async (page: Page, selector: string) => {
  const found = await page.locator(selector).first().boundingBox();
  if (!found) throw new Error(`${selector} has no box`);
  return found;
};
test.describe('in Quanta, with a folder, a long note and a source', () => {
  test.use({
    seed: {
      name: 'Quanta',
      folders: ['Miscellaneous'],
      notes: [
        { title: 'Penmoss Roadmap', markdown: 'Plans for Penmoss.\n' },
        { title: 'Long', markdown: `${LONG}\n` },
        { title: 'Source', markdown: '## Plan\n\nFirst line.\n' },
      ],
    },
  });

  // T66, items 8, 11.
  test('the sidebar’s rows and the note’s buttons are flush; the caret is centred', async ({
    page,
  }) => {
    const errors = collectErrors(page);
    await page.setViewportSize({ width: 1400, height: 800 });
    await page.goto('/');
    await openNoteIn(page, 'Source');
    // The Mac app's compact title bar, as mac-window.ts sets it.
    await page.evaluate(() => (document.documentElement.dataset['titlebar'] = 'compact'));
    const sidebar = await box(page, '.sidebar');
    const sbHead = await box(page, '.sb-head');
    const pair = await box(page, '.sb-head .history-pair');
    const collapse = await box(page, '.sb-head .sb-collapse');
    // Back and Forward and Collapse as tall as the row, Collapse at its end.
    for (const button of [pair, collapse]) {
      expect(button.y).toBe(sbHead.y);
      expect(Math.round(button.height)).toBe(Math.round(sbHead.height) - 1);
    }
    expect(Math.round(collapse.x + collapse.width)).toBe(Math.round(sidebar.x + sidebar.width) - 1);
    // A hairline after the lights: Back's left border.
    expect(
      await page
        .locator('.sb-head .history-pair')
        .evaluate((element) => getComputedStyle(element).borderLeftWidth),
    ).toBe('1px');
    // The shortcuts from edge to edge, no gap above or between them.
    const shortcuts = page.locator('.sb-shortcuts .sb-shortcut');
    const first = (await shortcuts.first().boundingBox())!;
    const last = (await shortcuts.last().boundingBox())!;
    expect(Math.round(first.x)).toBe(Math.round(sidebar.x));
    expect(Math.round(first.y)).toBe(Math.round(sbHead.y + sbHead.height));
    expect(Math.round(last.x + last.width)).toBe(Math.round(sidebar.x + sidebar.width) - 1);
    // The note's title bar: its buttons as tall as the bar, the last at the window's edge.
    const top = await box(page, '.note-top');
    const menu = await box(page, '.note-top [data-testid="note-menu"]');
    expect(Math.round(menu.x + menu.width)).toBe(Math.round(top.x + top.width));
    expect(Math.round(menu.height)).toBe(Math.round(top.height) - 1);
    // The panel's tabs: from the top of their strip, no gap between them.
    const rail = page.locator('.note-rail-icons .note-rail-btn');
    const tab0 = (await rail.nth(0).boundingBox())!;
    const tab1 = (await rail.nth(1).boundingBox())!;
    expect(Math.round(tab1.y)).toBe(Math.round(tab0.y + tab0.height));
    expect(Math.round(tab0.y)).toBe(Math.round((await box(page, '.note-rail-icons')).y));
    if (SHOTS) {
      await page.screenshot({
        path: `${SHOTS}/flush.png`,
        clip: { x: 0, y: 0, width: 1400, height: 160 },
      });
    }

    // Item 11: a section's caret halfway between the window's edge and its title's text.
    await page.evaluate(() => delete document.documentElement.dataset['titlebar']);
    // Every section title's caret, and a folder's, on one column.
    const head = page.locator('.sb-part-head').first();
    const caret = (await head.locator('.sb-section-toggle svg').first().boundingBox())!;
    const name = (await head.locator('.sb-section-name').first().boundingBox())!;
    const before = caret.x - sidebar.x;
    const after = name.x - (caret.x + caret.width);
    const folderCaret = (await page
      .locator('.sidebar .tree-row')
      .filter({ hasText: 'Miscellaneous' })
      .first()
      .locator('.twisty svg')
      .boundingBox())!;
    expect(Math.round(folderCaret.x)).toBe(Math.round(caret.x));
    expect(Math.abs(before - after)).toBeLessThanOrEqual(2);
    expect(errors).toEqual([]);
  });
});
