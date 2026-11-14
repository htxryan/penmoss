import { expect, test, type Page } from './fixtures';
import { BUILT_IN_THEMES } from '@penmoss/ui/theme';
import { storedSetting } from './stored';

// Ryan's feedback of 6 Nov 2026 ("Penmoss Feedback", Personal), in the web app (the Mac app runs
// the same page), T63: Pin to and Unpin from Quick Access in a note's sidebar menu (item 1); a
// title row's tools and a notebook's buttons flush with the row's end, as tall as it, a step
// darker on hover in a light theme (2); Token Count beside the other metadata (3); "No notes" in
// an open, empty Quick Access (4).

const SHOTS = process.env['PENMOSS_EVIDENCE'];
const ULID = /\/notes\/([0-9A-HJKMNP-TV-Z]{26})$/;

test.use({
  seed: {
    name: 'Quanta',
    folders: ['Substation'],
    notes: [{ title: 'Alpha' }, { title: 'Beta' }],
  },
});

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(error.message));
  return errors;
}

const section = (page: Page, name: string) =>
  page.getByTestId('source-section').and(page.getByRole('region', { name, exact: true }));
const tree = (page: Page, name: string) =>
  section(page, name).getByRole('tree', { name: 'Folders and notes' });

async function openNote(page: Page, title: string): Promise<void> {
  await tree(page, 'Quanta').getByRole('link', { name: title, exact: true }).click();
  await expect(page).toHaveURL(ULID);
  await expect(page.getByTestId('note-title')).toHaveValue(title);
}

type Box = { left: number; right: number; top: number; bottom: number };
const box = (page: Page, selector: string): Promise<Box> =>
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
const corner = (b: Box): Point => ({ x: b.left + 2, y: b.top + 2 });

test('1, 4: a note’s menu pins it to Quick Access and unpins it; an open, empty Quick Access says No notes', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await page.setViewportSize({ width: 1280, height: 860 });
  await page.goto('/');
  const quick = page.getByTestId('quick-access');
  // 4: open and empty, quiet words centred in its panel, not a gap.
  const none = quick.getByTestId('quick-access-none');
  await expect(none).toHaveText('No notes');
  expect(await none.evaluate((element) => getComputedStyle(element).textAlign)).toBe('center');
  const panel = await box(page, '[data-testid="quick-access"]');
  const words = await none.evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const b = range.getBoundingClientRect();
    return { left: b.left, right: b.right };
  });
  expect(Math.abs(words.left - panel.left - (panel.right - words.right))).toBeLessThan(2);
  if (SHOTS) await quick.screenshot({ path: `${SHOTS}/quick-access-empty.png` });
  // Collapsed, it is its title row alone.
  await quick.getByRole('button', { name: 'Quick Access', exact: true }).click();
  await expect(none).toHaveCount(0);
  await quick.getByRole('button', { name: 'Quick Access', exact: true }).click();

  // 1: Pin to Quick Access from the note's own menu in the tree.
  const alpha = tree(page, 'Quanta').getByRole('link', { name: 'Alpha', exact: true });
  await alpha.click({ button: 'right' });
  const pin = page.getByTestId('note-menu-quick-access');
  await expect(pin).toHaveText('Pin to Quick Access');
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/note-menu-pin.png` });
  await pin.click();
  await expect(page.getByRole('menu')).toHaveCount(0);
  await expect(quick.getByTestId('quick-access-note')).toHaveText(['Alpha']);
  await expect(none).toHaveCount(0);
  await expect
    .poll(async () => (await storedSetting(page, 'quickAccess.notes')) as unknown[])
    .toHaveLength(1);

  // Pinned, the same item unpins it.
  await alpha.click({ button: 'right' });
  await expect(pin).toHaveText('Unpin from Quick Access');
  await pin.click();
  await expect(quick.getByTestId('quick-access-note')).toHaveCount(0);
  await expect(none).toBeVisible();
  expect(errors).toEqual([]);
});

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
  const line = await box(page, notebook);
  expect(line.bottom - line.top, label).toBeGreaterThanOrEqual(28.2);
  const targets = await page
    .locator(`${notebook} :is(.tree-actions .icon-btn, .sync-dot)`)
    .evaluateAll((all) =>
      // Those shown: ⋯ only shows in a narrow row (Ryan's review of #192, finding 19).
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
  const words = await box(page, '[data-testid="quick-access-none"]');
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

test('2, 4: in every theme, light and dark, the tools and buttons sit flush and shade alike; No notes reads', async ({
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
        await page.locator('#app-sidebar .sb-part[data-section="notebooks"] .sb-part-head').hover();
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

test('3: Token Count in the Metadata tab, and pinned under the title and in the status bar', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await openNote(page, 'Alpha');
  await page.getByTestId('note-body').locator('.ProseMirror').click();
  // Two tokens in GPT-4o's encoding.
  await page.keyboard.type('hello world');
  if (!(await page.getByTestId('note-info').isVisible())) {
    await page.getByTestId('note-tab-info').click();
  }
  const details = page.getByTestId('note-details');
  await expect(details.locator('dt', { hasText: 'Token Count' })).toHaveCount(1);
  await expect(page.getByTestId('info-tokens')).toHaveText('2');
  // Not in the status bar until pinned there.
  await expect(page.getByTestId('note-counts')).not.toContainText('tokens');

  await page.goto('/settings/display');
  await page.getByTestId('metadata-title-tokens').check();
  await page.getByTestId('metadata-status-tokens').check();
  await expect.poll(() => storedSetting(page, 'metadata.underTitle')).toEqual(['tokens']);
  await expect
    .poll(() => storedSetting(page, 'metadata.statusBar'))
    .toEqual(['words', 'characters', 'reading', 'tokens']);
  await expect(page.getByTestId('metadata-status-tokens').locator('..')).toContainText(
    'Token Count',
  );

  await page.goto('/');
  await openNote(page, 'Alpha');
  await expect(page.getByTestId('pinned-metadata').locator('[data-field="tokens"]')).toHaveText(
    '2 tokens',
  );
  await expect(page.getByTestId('note-counts').locator('[data-field="tokens"]')).toHaveText(
    '2 tokens',
  );
  // It follows the text.
  await page.getByTestId('note-body').locator('.ProseMirror').click();
  await page.keyboard.press('End');
  await page.keyboard.type(' and more words here');
  await expect(page.getByTestId('note-counts').locator('[data-field="tokens"]')).toHaveText(
    '6 tokens',
  );
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/token-count.png` });
  expect(errors).toEqual([]);
});
