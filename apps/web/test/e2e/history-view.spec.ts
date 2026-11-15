import AxeBuilder from '@axe-core/playwright';
import { createHash } from 'node:crypto';
import { crc32, deflateSync } from 'node:zlib';
import { expect, type Page, seeded, test } from './fixtures';
import { LINE_END, VERSION_HISTORY } from './keys';
import { asAgent, syncNow } from './support/sync';
import { body, collectErrors } from './support/app';

// View This Version (A1572; Ryan's pick, design C "Side by Side with Now"): the version picked in
// History beside the note as it is now, in a modal over the window but the panel, what differs
// tinted on each side; the list picks what it shows; Restore from it; Esc goes back to View.

const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
/** Where to save the light and dark screenshots, when a run asks for them. */
const SHOTS = process.env['PENMOSS_HISTORY_VIEW_SHOTS'];

const panel = (page: Page) => page.getByTestId('history-panel');
const view = (page: Page) => page.getByRole('dialog', { name: /^Version of / });
const side = (page: Page, which: 'left' | 'right') => page.getByTestId(`history-view-${which}`);

/** Puts the caret at the end of the line holding `text`. */
async function endOf(page: Page, text: string) {
  await body(page).getByText(text, { exact: true }).click();
  await page.keyboard.press(LINE_END);
}

/**
 * The sides' text against what is behind it, tints included: axe's colour contrast (AA, 4.5:1),
 * as the HTML of each element it passed, failed, or could not decide.
 */
async function sidesContrast(page: Page) {
  const results = await new AxeBuilder({ page })
    .include('[data-testid="history-view-scroll"]')
    .withRules(['color-contrast'])
    .analyze();
  const html = (list: typeof results.passes) =>
    list.flatMap((rule) => rule.nodes.map((node) => node.html));
  return {
    passed: html(results.passes),
    failed: html(results.violations),
    unsure: html(results.incomplete),
  };
}

// Two versions made elsewhere, so this Mac's own pushes (on a timer) never split them: the
// note as seeded, then an agent's line added.
test.use({
  seed: {
    name: 'Notes',
    notes: [{ title: 'Roadmap', markdown: 'Tags page\n\nHistory by day\n\nWidget\n' }],
  },
});

test('View shows a version beside the note as it is now, and restores it', async ({
  page,
  host,
  notebook,
}) => {
  test.setTimeout(150_000);
  const errors = collectErrors(page);
  const { remote, noteIds } = seeded(notebook);
  const id = noteIds[0]!;
  await asAgent(host, remote, `Claude ${RUN}`, (local) => {
    local.edit(id, { op: 'append', markdown: 'Banner when sync stops' }, null);
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/notes/${id}`);
  await expect(async () => {
    await syncNow(page);
    await expect(body(page)).toContainText('Banner when sync stops', { timeout: 2_000 });
  }).toPass({ timeout: 40_000 });

  // Now: the first line changed here (a push may make it a version too; it is never picked).
  await endOf(page, 'Tags page');
  await page.keyboard.type(': compact rows');

  await page.keyboard.press(VERSION_HISTORY);
  const rows = panel(page).getByRole('list', { name: 'Versions' }).locator('.history-entry');
  // The agent's version, and the one before it: the note as seeded, the oldest.
  const second = rows.and(panel(page).getByRole('button', { name: new RegExp(`Claude ${RUN}`) }));
  const first = rows.last();
  await expect(second).toBeVisible({ timeout: 15_000 });
  await second.click();
  const open = panel(page).getByRole('button', { name: 'View This Version' });
  // First of the preview's actions: an icon and "View".
  await expect(panel(page).locator('.history-actions > button').first()).toHaveText('View');
  await open.click();

  // A modal; the panel stays beside it, its preview folded away.
  await expect(view(page)).toBeVisible();
  await expect(panel(page)).toBeVisible();
  await expect(panel(page).getByTestId('history-viewing')).toBeVisible();
  await expect(panel(page).getByRole('button', { name: 'Restore This Version' })).toHaveCount(0);
  // Focus is on the version in the list, where ↑ and ↓ move.
  await expect(second).toBeFocused();
  await expect(side(page, 'right')).toHaveAccessibleName('Now');
  const latest = await view(page).locator('.history-view-when').textContent();
  await expect(side(page, 'left')).toHaveAccessibleName(latest!);
  // Rendered as the note is; the line changed since is tinted on both sides, the rest not.
  await expect(side(page, 'left').locator('h1')).toHaveText('Roadmap');
  await expect(side(page, 'left').locator('[data-change="removed"]')).toHaveText(
    'Not in now: Tags page',
  );
  await expect(side(page, 'right').locator('[data-change="added"]')).toHaveText(
    'Added since: Tags page: compact rows',
  );
  await expect(
    side(page, 'right').locator('p', { hasText: 'Banner when sync stops' }),
  ).not.toHaveAttribute('data-change');
  // The top actions: short names, full ones as their names; Revert on every version (A1575).
  // Wrap Lines first, on; then the switch from Diff, the default, to Full File (A1572).
  const actions = view(page).locator('.history-view-head > button');
  await expect(actions).toHaveText(
    ['Wrap Lines', 'Show Full File', 'Restore', 'Revert', 'Copy', ''],
    {
      useInnerText: true,
    },
  );
  // Close is the app's × for a dialog, its name and tooltip in words.
  const close = view(page).getByRole('button', { name: 'Close', exact: true });
  await expect(close.locator('svg[data-icon="close"]')).toBeVisible();
  await expect(close).toHaveAttribute('data-tip', 'Close (Esc)');
  await expect(view(page).getByRole('button', { name: 'Restore This Version' })).toBeVisible();
  await expect(view(page).getByRole('button', { name: 'Revert This Edit' })).toBeVisible();
  await expect(view(page).getByRole('button', { name: 'Copy Text' })).toBeVisible();

  const violations = await new AxeBuilder({ page })
    .include('[data-testid="history-view"]')
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
    .analyze();
  expect(
    violations.violations
      .filter((violation) => violation.impact === 'serious' || violation.impact === 'critical')
      .map(
        (violation) =>
          `${violation.id}: ${violation.nodes.map((node) => node.target.join(' ')).join(', ')}`,
      ),
  ).toEqual([]);

  // ↓ in the list: the version before, on the left only; now's added line has a gap beside it.
  await page.keyboard.press('ArrowDown');
  await expect(first).toBeFocused();
  await expect(side(page, 'left').locator('[data-change="removed"]')).toHaveText([
    'Not in now: Tags page',
  ]);
  await expect(side(page, 'right').locator('[data-change="added"]')).toHaveText([
    'Added since: Tags page: compact rows',
    'Added since: Banner when sync stops',
  ]);
  await expect(side(page, 'left').locator('.history-view-gap')).toHaveCount(1);
  // The gap holds the row open: the two sides stay level.
  const leftLast = await side(page, 'left').locator('.history-view-gap').boundingBox();
  const rightLast = await side(page, 'right')
    .locator('p', { hasText: 'Banner when sync stops' })
    .boundingBox();
  expect(Math.abs(leftLast!.y - rightLast!.y)).toBeLessThan(1);
  // A click in the list picks too.
  await second.click();
  await expect(side(page, 'left').locator('.history-view-gap')).toHaveCount(0);
  await first.click();
  await expect(side(page, 'left').locator('.history-view-gap')).toHaveCount(1);

  // Light and dark: the tints read clearly, and the text on them keeps AA contrast.
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await expect(page.locator('html')).toHaveAttribute('data-mode', scheme);
    await page.mouse.move(0, 0);
    // The colours' transitions end before they are measured.
    await page.evaluate(() => Promise.all(document.getAnimations().map((each) => each.finished)));
    const contrast = await sidesContrast(page);
    expect(contrast.failed).toEqual([]);
    expect(contrast.unsure).toEqual([]);
    // The blocks, not the key over each side, which is in the scroll too.
    const blocks = (change: string) =>
      contrast.passed.filter(
        (html) => html.includes(`data-change="${change}"`) && !html.includes('history-view-key'),
      );
    expect(blocks('removed')).toHaveLength(1);
    expect(blocks('added')).toHaveLength(2);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/history-view-${scheme}.png` });
  }
  await page.emulateMedia({ colorScheme: 'light' });

  // Esc closes it, and focus goes back to View.
  await page.keyboard.press('Escape');
  await expect(view(page)).toHaveCount(0);
  await expect(panel(page)).toBeVisible();
  await expect(open).toBeFocused();

  // Restore from it: the version comes back in the note, and the modal closes.
  await open.click();
  await expect(view(page)).toBeVisible();
  await view(page).getByRole('button', { name: 'Restore This Version' }).click();
  await expect(view(page)).toHaveCount(0);
  await expect(panel(page).getByTestId('history-status')).toContainText('as a new change');
  await expect(body(page)).toContainText('Widget');
  await expect(body(page)).not.toContainText('Banner when sync stops');
  await expect(body(page)).not.toContainText('compact rows');
  await expect(open).toBeFocused();
  expect(errors).toEqual([]);
});

/** Two small pictures: the one the note had, and the one an agent put in its place. */
const RED = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAEElEQVR4nGM4YWMDRwzEcQAREhQBbrqBkwAAAABJRU5ErkJggg==',
  'base64',
);
const BLUE = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAEElEQVR4nGOwiToBRwzEcQAwUhXhDEmnwQAAAABJRU5ErkJggg==',
  'base64',
);
/** A PNG of one colour, `width` × `height`, made here so the test needs no file. */
function png(width: number, height: number, [r, g, b]: readonly number[]): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const named = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(named));
    return Buffer.concat([length, named, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x++) row.set([r!, g!, b!], 1 + x * 3);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.concat(Array.from({ length: height }, () => row)))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
/** A screenshot wider than a side, at no size of its own: the side's width draws it. */
const WIDE = png(1600, 40, [40, 120, 60]);
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

test.describe('images', () => {
  test.use({
    seed: {
      name: 'Notes',
      images: [new Uint8Array(RED), new Uint8Array(BLUE), new Uint8Array(WIDE)],
      notes: [
        {
          title: 'Diagram',
          markdown: `The plan:\n\n![Plan|120](attachments/${sha(RED)}.png)\n\n![Wide](attachments/${sha(WIDE)}.png)\n`,
        },
        // The notebook keeps a picture a note shows: this one keeps the blue one.
        { title: 'Palette', markdown: `![Blue](attachments/${sha(BLUE)}.png)\n` },
      ],
    },
  });

  test('View shows each side’s images, a version’s as it had them', async ({
    page,
    host,
    notebook,
  }) => {
    test.setTimeout(120_000);
    const errors = collectErrors(page);
    const { remote, noteIds } = seeded(notebook);
    const id = noteIds[0]!;
    // An agent puts the blue picture in the red one's place.
    await asAgent(host, remote, `Claude ${RUN}`, (local) => {
      local.edit(
        id,
        {
          op: 'replace',
          find: `attachments/${sha(RED)}.png`,
          replace: `attachments/${sha(BLUE)}.png`,
          all: false,
          scope: 'markdown',
        },
        null,
      );
    });
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/notes/${id}`);
    await expect(page.getByTestId('note-view')).toHaveAttribute('data-ready', 'true');
    await page.getByTestId('note-tab-history').click();
    const rows = panel(page).getByRole('list', { name: 'Versions' }).locator('.history-entry');
    await expect(async () => {
      await syncNow(page);
      await expect(rows).toHaveCount(2, { timeout: 2_000 });
    }).toPass({ timeout: 40_000 });

    // The note as seeded, beside now: the red picture on the left, the blue one on the right.
    await rows.last().click();
    await panel(page).getByRole('button', { name: 'View This Version' }).click();
    await expect(view(page)).toBeVisible();
    const picture = (which: 'left' | 'right') => side(page, which).locator('img').first();
    const wide = (which: 'left' | 'right') =>
      side(page, which).locator(`img[data-src="attachments/${sha(WIDE)}.png"]`);
    await expect(picture('left')).toHaveAttribute('data-src', `attachments/${sha(RED)}.png`);
    await expect(picture('right')).toHaveAttribute('data-src', `attachments/${sha(BLUE)}.png`);
    // Each loaded, as the editor loads them (this device's attachments), and drawn.
    for (const which of ['left', 'right'] as const) {
      await expect
        .poll(() =>
          picture(which).evaluate((img: HTMLImageElement) => (img.complete ? img.naturalWidth : 0)),
        )
        .toBe(4);
      await expect(picture(which)).toHaveJSProperty('width', 120);
    }
    // Each in its side's tinted block: the picture is what changed.
    await expect(side(page, 'left').locator('[data-change="removed"] img')).toHaveCount(1);
    await expect(side(page, 'right').locator('[data-change="added"] img')).toHaveCount(1);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/history-view-images.png` });
    // Wrap Lines off: the pictures keep their size, the wide one its side's width, not its own.
    const widths = () =>
      Promise.all(
        (['left', 'right'] as const).flatMap((which) =>
          [picture(which), wide(which)].map((img) =>
            img.evaluate((element) => Math.round(element.getBoundingClientRect().width)),
          ),
        ),
      );
    await expect
      .poll(() => wide('right').evaluate((img: HTMLImageElement) => img.naturalWidth))
      .toBe(1600);
    const wrapped = await widths();
    expect(wrapped[3]).toBeGreaterThan(200);
    expect(wrapped[3]).toBeLessThan(800);
    await view(page).getByTestId('history-view-wrap').click();
    await expect(view(page).getByTestId('history-view-wrap')).toHaveAttribute(
      'aria-pressed',
      'false',
    );
    expect(await widths()).toEqual(wrapped);
    expect(errors).toEqual([]);
  });
});
