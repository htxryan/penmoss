import { deflateSync, crc32 } from 'node:zlib';

import { expect, test, type Page } from './fixtures';
import { COMMENT } from './keys';

// PEN-66 (A1283): a picture keeps its own line (A506), and leaves no empty line under it. The
// block a picture ends is as tall as its text and the picture, so the next line or block starts at
// its normal distance below the picture, as it would below a line of text. Measured in the page
// with getBoundingClientRect, at the default 16 px note font, to ±1 px.

const SHOTS = process.env['PENMOSS_EVIDENCE'];
const URL_A = 'https://img.example/a.png';
const URL_B = 'https://img.example/b.png';
/** A phone screenshot, taller than the page, and a wide screen's, wider than the column. */
const URL_TALL = 'https://img.example/tall.png';
const URL_WIDE = 'https://img.example/wide.png';

/** A 200×100 PNG of one colour, made here so the page needs no file. */
function png(width: number, height: number, [r, g, b]: readonly number[]): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x++) row.set([r!, g!, b!], 1 + x * 3);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const NOTES = {
  // AC1, AC5, AC6: text, then a pasted picture, ends the paragraph.
  text: 'Line above\n\nNext\n',
  // AC1 from markdown: a soft line break before the picture.
  softBreak: `Line above\n![](${URL_A})\n\nNext\n`,
  // AC2: bullet, numbered and checklist items that end with a picture.
  lists: [
    `- one\n- two ![](${URL_A})\n- after bullet`,
    `1. one\n2. two ![](${URL_A})\n3. after numbered`,
    `- [ ] one\n- [ ] two ![](${URL_A})\n- [ ] after task`,
    '',
    'Next',
    '',
  ].join('\n\n'),
  // AC3: blocks that hold only a picture.
  lone: [
    `![](${URL_A})`,
    `![|120](${URL_A})`,
    `[![](${URL_A})](https://example.com)`,
    `**![](${URL_A})**`,
    `==![](${URL_A})==`,
    `- ![](${URL_A})\n- after`,
    `> ![](${URL_A})`,
    `| Head |\n| --- |\n| ![](${URL_A}) |`,
    `# ![](${URL_A})`,
    'Next',
    '',
  ].join('\n\n'),
  // AC4: text, a picture, more text.
  between: `Before ![](${URL_A}) after\n\nSoft before\n![](${URL_A})\nsoft after\n\nNext\n`,
  // AC8: a picture whose file is missing shows its placeholder.
  missing:
    'Line above ![Lost](attachments/missing.png)\n\n![Lost](attachments/missing.png)\n\nNext\n',
  // AC9: two pictures on consecutive markdown lines.
  several: `![](${URL_A})\n![](${URL_B})\n\nNext\n`,
  // AC9 pasted, AC3 with a comment marker: filled in by the test.
  empty: '\n',
  // A1354: Ryan's note as the Mac app saved it: a narrowed screenshot, a line break, more text.
  ryan: `one\\\ntwo\n\n![|48](${URL_TALL})\\\nthree\n`,
  // A1354: a picture, then a line break: of each size, in a mark, a list item, a table cell.
  breaks: [
    `![](${URL_TALL})\\\nafter tall`,
    `![](${URL_WIDE})\\\nafter wide`,
    `![](${URL_A})\\\nafter small`,
    `**![](${URL_A})**\\\nafter bold`,
    `[![](${URL_A})](https://example.com)\\\nafter linked`,
    `==![](${URL_A})==\\\nafter highlighted`,
    `- ![](${URL_A})\\\n  after in list`,
    `| Head |\n| --- |\n| ![](${URL_A})<br>after in cell |`,
    `![](${URL_A})\\\n![](${URL_B})\\\nafter two`,
    'Next',
    '',
  ].join('\n\n'),
} as const;

test.use({
  seed: {
    name: 'Pictures',
    notes: Object.entries(NOTES).map(([title, markdown]) => ({ title, markdown })),
  },
});

const body = (page: Page) => page.getByTestId('note-body').locator('.ProseMirror');

async function serveImages(page: Page): Promise<void> {
  const images: Record<string, Buffer> = {
    'a.png': png(200, 100, [63, 125, 78]),
    'b.png': png(200, 100, [63, 78, 125]),
    'tall.png': png(1170, 2532, [125, 78, 63]),
    'wide.png': png(3024, 800, [78, 63, 125]),
  };
  await page.route('https://img.example/**', (route) =>
    route.fulfill({
      contentType: 'image/png',
      body: images[new URL(route.request().url()).pathname.slice(1)]!,
    }),
  );
}

async function openNote(page: Page, title: string): Promise<void> {
  await page.getByTestId('note-list').getByRole('link', { name: title, exact: true }).click();
  await expect(page.getByTestId('note-title')).toHaveValue(title);
  await settled(page);
}

/** Every picture has loaded or shows its placeholder. */
async function settled(page: Page): Promise<void> {
  await expect
    .poll(() =>
      body(page)
        .locator('.pm-image')
        .evaluateAll((pictures) =>
          pictures.every((picture) => {
            const state = (picture as HTMLElement).dataset['state'];
            const img = picture.querySelector('img');
            return (
              state === 'missing' || (state === 'ready' && img!.complete && img!.naturalWidth > 0)
            );
          }),
        ),
    )
    .toBe(true);
}

/** Pastes PNG files where the caret is, as a screenshot or files from Finder arrive. */
async function pastePictures(page: Page, count = 1, [width, height] = [200, 100]): Promise<void> {
  const before = await body(page).locator('.pm-image').count();
  await page.evaluate(
    async ([count, width, height]) => {
      const transfer = new DataTransfer();
      for (let i = 0; i < count; i++) {
        const canvas = document.createElement('canvas');
        canvas.width = width!;
        canvas.height = height!;
        const context = canvas.getContext('2d')!;
        context.fillStyle = i === 0 ? '#3f7d4e' : '#3f4e7d';
        context.fillRect(0, 0, width, height);
        const blob = await new Promise<Blob>((resolve) =>
          canvas.toBlob((made) => resolve(made!), 'image/png'),
        );
        transfer.items.add(new File([blob], `Shot ${i}.png`, { type: 'image/png' }));
      }
      const editor = document.querySelector<HTMLElement>('[data-testid="note-body"] .ProseMirror')!;
      editor.dispatchEvent(
        new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }),
      );
    },
    [count, width, height] as const,
  );
  await expect(body(page).locator('.pm-image')).toHaveCount(before + count);
  await settled(page);
}

interface Box {
  readonly top: number;
  readonly bottom: number;
  readonly left: number;
  readonly right: number;
}

interface Picture extends Box {
  /** The textblock holding it (a paragraph, heading or table cell). */
  readonly block: Box;
  /** Its list item, quote or table, when it is in one; else the block. */
  readonly outer: Box;
  /** The block or item after `outer`. */
  readonly next: Box | null;
  readonly blockText: string;
}

/**
 * Each picture's own rectangle (its image or placeholder), and the blocks around it. Measured with
 * the editor focused, two frames on: until then a block off screen, or one just changed, can still
 * have the height it was last drawn at (content-visibility, T31).
 */
async function pictures(page: Page): Promise<Picture[]> {
  await body(page).evaluate(async (editor) => {
    if (!editor.contains(document.activeElement)) (editor as HTMLElement).focus();
    for (let i = 0; i < 2; i++) await new Promise(requestAnimationFrame);
  });
  return body(page)
    .locator('.pm-image')
    .evaluateAll((all) => {
      const box = (element: Element): Box => {
        const { top, bottom, left, right } = element.getBoundingClientRect();
        return { top, bottom, left, right };
      };
      /** Inside its padding and border: a table cell's text starts there. */
      const content = (element: Element): Box => {
        const style = getComputedStyle(element);
        const edge = (side: string) =>
          parseFloat(style.getPropertyValue(`padding-${side}`)) +
          parseFloat(style.getPropertyValue(`border-${side}-width`));
        const { top, bottom, left, right } = box(element);
        return {
          top: top + edge('top'),
          bottom: bottom - edge('bottom'),
          left: left + edge('left'),
          right: right - edge('right'),
        };
      };
      const after = (element: Element): Element | null => {
        for (let at: Element | null = element; at; at = at.parentElement) {
          if (at.classList.contains('ProseMirror')) return null;
          let next = at.nextElementSibling;
          while (next && !(next instanceof HTMLElement && next.offsetHeight > 0))
            next = next.nextElementSibling;
          if (next) return next;
        }
        return null;
      };
      return all.map((picture) => {
        const shown =
          (picture as HTMLElement).dataset['state'] === 'ready'
            ? picture.querySelector('img')!
            : picture.querySelector('.pm-image-fallback')!;
        const block = picture.closest('p, td, th, h1, h2, h3, h4, h5, h6')!;
        const outer = picture.closest('li, blockquote, .pm-table') ?? block;
        const next = after(outer);
        return {
          ...box(shown),
          block: content(block),
          outer: box(outer),
          next: next ? box(next) : null,
          blockText: [...block.childNodes]
            .filter(
              (node) => node.nodeType === Node.TEXT_NODE || !(node as Element).matches('.pm-image'),
            )
            .map((node) => node.textContent)
            .join(''),
        };
      });
    });
}

/** ±1 px, with room for sub-pixel rounding (a collapsed table border is half a pixel). */
const PX = 1.05;
/** 0.85 em between top-level blocks at the 16 px note font. */
const BLOCK_GAP = 13.6;
/** 0.15 em between list items. */
const LIST_GAP = 2.4;
/** A line of text at the 16 px note font (line-height 1.7). */
const LINE = 27.2;
/** From the top of a block whose text comes first to its picture: a line, then 0.4 em. */
const TEXT_ABOVE = LINE + 6.4;

function expectNoLineUnder(picture: Picture): void {
  // The block ends where the picture ends: no empty line under it.
  expect(Math.abs(picture.block.bottom - picture.bottom)).toBeLessThanOrEqual(PX);
}

function expectGapBelow(picture: Picture, gap: number): void {
  expect(picture.next).not.toBeNull();
  expect(Math.abs(picture.next!.top - picture.bottom - gap)).toBeLessThanOrEqual(PX);
}

function expectAsTallAsPicture(picture: Picture, which = 'the picture'): void {
  expect(Math.abs(picture.block.top - picture.top), `above ${which}`).toBeLessThanOrEqual(PX);
  expect(Math.abs(picture.block.bottom - picture.bottom), `under ${which}`).toBeLessThanOrEqual(PX);
}

/** Text, then the picture on the next line: 0.4 em under the text's line, as in the mockups. */
function expectTextLineAbove(picture: Picture): void {
  expect(Math.abs(picture.top - picture.block.top - TEXT_ABOVE)).toBeLessThanOrEqual(PX);
}

/**
 * The caret after a picture is drawn on the picture's line, at its right edge: not at the far edge
 * of the column, and not on an empty line under it. Chromium draws a caret beside an inline picture
 * as tall as the picture (A1283), so it spans the picture's line down to the picture's bottom.
 */
function expectCaretAfter(caret: Box, picture: Picture): void {
  expect(Math.abs(caret.bottom - picture.bottom), 'at the picture’s bottom').toBeLessThanOrEqual(2);
  expect(caret.top, 'on the picture’s line').toBeGreaterThanOrEqual(picture.top - 2);
  expect(caret.left, 'right of the picture').toBeGreaterThanOrEqual(picture.right);
  expect(caret.left, 'beside the picture').toBeLessThanOrEqual(picture.right + 4);
}

/**
 * Where the caret is drawn, from the screen itself: the editor's caret turned pure red for a moment,
 * the pixels of that colour over a few screenshots (it blinks). A collapsed selection between two
 * elements, as after a picture that ends its block, has no rectangle of its own in Chromium
 * (getClientRects() is empty there), so only the drawn caret shows where it is.
 */
async function caretBox(page: Page): Promise<Box> {
  await body(page).evaluate((editor) =>
    (editor as HTMLElement).style.setProperty('caret-color', '#ff0000', 'important'),
  );
  try {
    for (let attempt = 0; attempt < 8; attempt++) {
      const shot = (await page.screenshot({ caret: 'initial' })).toString('base64');
      const found = await page.evaluate(async (png) => {
        const image = new Image();
        image.src = `data:image/png;base64,${png}`;
        await image.decode();
        const canvas = document.createElement('canvas');
        canvas.width = image.width;
        canvas.height = image.height;
        const context = canvas.getContext('2d')!;
        context.drawImage(image, 0, 0);
        const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
        const scale = image.width / innerWidth;
        let top = Infinity,
          bottom = -Infinity,
          left = Infinity,
          right = -Infinity;
        for (let i = 0; i < data.length; i += 4) {
          if (data[i]! < 240 || data[i + 1]! > 20 || data[i + 2]! > 20) continue;
          const x = (i / 4) % canvas.width;
          const y = Math.floor(i / 4 / canvas.width);
          top = Math.min(top, y);
          bottom = Math.max(bottom, y + 1);
          left = Math.min(left, x);
          right = Math.max(right, x + 1);
        }
        if (top === Infinity) return null;
        return {
          top: top / scale,
          bottom: bottom / scale,
          left: left / scale,
          right: right / scale,
        };
      }, shot);
      if (found) return found;
      await page.waitForTimeout(150);
    }
    throw new Error('No caret drawn');
  } finally {
    await body(page).evaluate((editor) =>
      (editor as HTMLElement).style.removeProperty('caret-color'),
    );
  }
}

test.beforeEach(async ({ page }) => {
  await serveImages(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/');
});

test('AC1, AC5: a picture after text sits on its own line, the next block a normal gap below, and the caret after it on its line', async ({
  page,
}) => {
  // From markdown: text, a soft line break, the picture.
  await openNote(page, 'softBreak');
  let [picture] = await pictures(page);
  expect(picture!.top).toBeGreaterThan(picture!.block.top + 20); // Below the text, not beside it.
  expectTextLineAbove(picture!);
  expectNoLineUnder(picture!);
  expectGapBelow(picture!, BLOCK_GAP);

  // Pasted after the text, in the same paragraph.
  await openNote(page, 'text');
  await body(page).getByText('Line above', { exact: true }).click();
  await page.keyboard.press('End');
  await pastePictures(page);
  [picture] = await pictures(page);
  expect(picture!.blockText).toBe('Line above');
  expect(picture!.top).toBeGreaterThan(picture!.block.top + 20);
  expectNoLineUnder(picture!);
  expectGapBelow(picture!, BLOCK_GAP);
  expectTextLineAbove(picture!);

  // AC5: End puts the caret on the picture's line, at its bottom right; Enter starts a block below.
  await page.keyboard.press('End');
  let caret = await caretBox(page);
  expectCaretAfter(caret, picture!);
  await page.keyboard.press('Enter');
  await page.keyboard.type('Typed below');
  const typed = body(page).getByText('Typed below', { exact: true });
  const typedTop = await typed.evaluate((element) => element.getBoundingClientRect().top);
  expect(Math.abs(typedTop - picture!.bottom - BLOCK_GAP)).toBeLessThanOrEqual(PX);
  const lines = await body(page)
    .locator(':scope > p')
    .evaluateAll((paragraphs) =>
      paragraphs.map((p) =>
        [...p.childNodes]
          .map((node) =>
            (node as Element).matches?.('.pm-image') ? '[picture]' : node.textContent,
          )
          .join(''),
      ),
    );
  expect(lines).toEqual(['Line above[picture]', 'Typed below', 'Next']);

  // From the line of text above, End twice: past the text's end, then past the picture.
  await openNote(page, 'softBreak');
  [picture] = await pictures(page);
  await body(page).getByText('Line above').click();
  await page.keyboard.press('End');
  await page.keyboard.press('End');
  expectCaretAfter(await caretBox(page), picture!);

  // A click in the empty part of the picture's line, right of it, puts the caret there too.
  await page.mouse.click((picture!.right + picture!.block.right) / 2, picture!.bottom - 10);
  await expect(body(page).locator('.pm-image.ProseMirror-selectednode')).toHaveCount(0);
  caret = await caretBox(page);
  expectCaretAfter(caret, picture!);
  await page.keyboard.press('Enter');
  await page.keyboard.type('Clicked below');
  const clicked = body(page).getByText('Clicked below', { exact: true });
  await expect(body(page).locator(':scope > p').nth(1)).toHaveText('Clicked below');
  const clickedTop = await clicked.evaluate((element) => element.getBoundingClientRect().top);
  expect(Math.abs(clickedTop - picture!.bottom - BLOCK_GAP)).toBeLessThanOrEqual(PX);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/pen-66-ac1-ac5.png` });
});

test('AC2: a bulleted, numbered or checklist item that ends with a picture keeps the list’s gap below it', async ({
  page,
}) => {
  await openNote(page, 'lists');
  const all = await pictures(page);
  expect(all).toHaveLength(3);
  for (const picture of all) {
    expect(picture.blockText.trim()).toBe('two');
    expectTextLineAbove(picture);
    expectNoLineUnder(picture);
  }
  // The gap from item one to item two, a line of text, in each list.
  const gaps = await body(page)
    .locator(':scope > :is(ul, ol)')
    .evaluateAll((lists) =>
      lists.map((list) => {
        // From item one's line of text (its paragraph) to item two.
        const [one, two] = list.querySelectorAll(':scope > li');
        return (
          two!.getBoundingClientRect().top - one!.querySelector('p')!.getBoundingClientRect().bottom
        );
      }),
    );
  expect(gaps).toHaveLength(3);
  all.forEach((picture, i) => {
    // The next item is the list's gap below the picture, as below a line of text.
    expectGapBelow(picture, gaps[i]!);
  });
  await body(page).locator('.pm-image').nth(1).scrollIntoViewIfNeeded();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/pen-66-ac2.png` });
});

const LONE = [
  'plain',
  'sized',
  'linked',
  'bold',
  'highlighted',
  'list item',
  'quote',
  'table cell',
  'heading',
];

test('AC3: a block that holds only a picture is exactly as tall as the picture', async ({
  page,
}) => {
  await openNote(page, 'lone');
  const all = await pictures(page);
  // Plain, sized, linked, bold, highlighted, in a list item, a quote, a table cell, a heading.
  expect(all).toHaveLength(9);
  expect(Math.round(all[1]!.right - all[1]!.left)).toBe(120);
  all.forEach((picture, i) => expectAsTallAsPicture(picture, LONE[i]));
  // The top-level ones keep the normal gap to the block after them.
  for (const i of [0, 1, 2, 3, 4]) expectGapBelow(all[i]!, BLOCK_GAP);
  // The list item's is the list's own gap, as after a line of text.
  expectGapBelow(all[5]!, LIST_GAP);
  // The quote and the table end a normal gap below their picture's block's own edge.
  for (const i of [6, 7]) expectNoLineUnder(all[i]!);
  // The highlight is the picture's own size: no strip of colour across the rest of its line. (Only
  // the 3 px after a picture that ends its block, where the caret stands clear of it, A1283.)
  const CARET_ROOM = 3;
  const highlight = await body(page)
    .locator('mark', { has: page.locator('.pm-image') })
    .evaluate((mark) => [...mark.getClientRects()].map(({ left, right }) => ({ left, right })));
  expect(highlight.length).toBeGreaterThan(0);
  for (const rect of highlight) {
    expect(rect.left).toBeGreaterThanOrEqual(all[4]!.left - PX);
    expect(rect.right).toBeLessThanOrEqual(all[4]!.right + CARET_ROOM + PX);
  }
  await body(page).locator('.pm-image').nth(4).scrollIntoViewIfNeeded();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/pen-66-ac3-lone.png` });

  // A point comment at the picture adds no line of its own.
  await openNote(page, 'empty');
  await body(page).click();
  await pastePictures(page);
  await page.keyboard.press('End');
  await page.keyboard.press(COMMENT);
  await page.getByTestId('comment-new').fill('About this picture');
  await page.keyboard.press('ControlOrMeta+Enter');
  await expect(body(page).locator('.pm-comment-marker')).toHaveCount(1);
  let [commented] = await pictures(page);
  expectAsTallAsPicture(commented!, 'the picture with a comment after it');
  // Its marker beside the picture, at its bottom right, not at the far end of the line.
  const marker = await body(page)
    .locator('.pm-comment-marker')
    .evaluate((element) => {
      const { top, bottom, left, right } = element.getBoundingClientRect();
      return { top, bottom, left, right };
    });
  expect(marker.left).toBeGreaterThanOrEqual(commented!.right - PX);
  expect(marker.left).toBeLessThanOrEqual(commented!.right + 8);
  expect(marker.bottom).toBeLessThanOrEqual(commented!.bottom + PX);
  expect(marker.top).toBeGreaterThanOrEqual(commented!.top - PX);
  // And one before it.
  await body(page).locator('.pm-image img').click();
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press(COMMENT);
  await page.getByTestId('comment-new').fill('Before this picture');
  await page.keyboard.press('ControlOrMeta+Enter');
  await expect(body(page).locator('.pm-comment-marker')).toHaveCount(2);
  [commented] = await pictures(page);
  expectAsTallAsPicture(commented!, 'the picture with comments before and after it');
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/pen-66-ac3.png` });
});

test('AC4: text, a picture, then more text: the text after starts on the next line', async ({
  page,
}) => {
  await openNote(page, 'between');
  const all = await pictures(page);
  expect(all).toHaveLength(2);
  for (const [picture, before, after] of [
    [all[0]!, 'Before', 'after'],
    [all[1]!, 'Soft before', 'soft after'],
  ] as const) {
    const [beforeBox, afterBox] = await body(page)
      .locator('p', { has: page.locator('.pm-image') })
      .filter({ hasText: new RegExp(`^${before}`) })
      .evaluate(
        (p, [before, after]) => {
          const range = document.createRange();
          const rect = (word: string) => {
            const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
            for (let node = walker.nextNode(); node; node = walker.nextNode()) {
              const at = node.textContent!.indexOf(word);
              if (at < 0) continue;
              range.setStart(node, at);
              range.setEnd(node, at + word.length);
              const { top, bottom } = range.getBoundingClientRect();
              return { top, bottom };
            }
            throw new Error(word);
          };
          return [rect(before), rect(after)];
        },
        [before, after] as const,
      );
    // The text before is above the picture, the text after on the line right below it.
    expect(beforeBox.bottom).toBeLessThanOrEqual(picture.top + PX);
    expect(afterBox.top).toBeGreaterThanOrEqual(picture.bottom - PX);
    // No empty line between: the line after starts at the picture's bottom (its text inside it).
    expect(afterBox.top - picture.bottom).toBeLessThan(0.5 * 16);
    expect(Math.abs(picture.block.bottom - picture.bottom - 1.7 * 16)).toBeLessThanOrEqual(PX);
  }
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/pen-66-ac4.png` });
});

test('AC8: a missing picture’s placeholder is spaced as a picture is', async ({ page }) => {
  await openNote(page, 'missing');
  const all = await pictures(page);
  expect(all).toHaveLength(2);
  await expect(body(page).locator('.pm-image[data-state="missing"]')).toHaveCount(2);
  expect(all[0]!.top).toBeGreaterThan(all[0]!.block.top + 20);
  expectNoLineUnder(all[0]!);
  expectGapBelow(all[0]!, BLOCK_GAP);
  expectAsTallAsPicture(all[1]!);
  expectGapBelow(all[1]!, BLOCK_GAP);
});

test('AC9: several pictures in one paragraph stack with no empty line between or after them', async ({
  page,
}) => {
  await openNote(page, 'several');
  let all = await pictures(page);
  expect(all).toHaveLength(2);
  // Each on a line of its own, the second right under the first.
  expect(Math.abs(all[1]!.top - all[0]!.bottom), 'touching').toBeLessThanOrEqual(PX);
  expect(Math.abs(all[0]!.block.top - all[0]!.top)).toBeLessThanOrEqual(PX);
  expectNoLineUnder(all[1]!);
  expectGapBelow(all[1]!, BLOCK_GAP);

  // Two files pasted together.
  await openNote(page, 'empty');
  await body(page).click();
  await pastePictures(page, 2);
  all = await pictures(page);
  expect(all).toHaveLength(2);
  expect(all[0]!.block).toEqual(all[1]!.block);
  expect(Math.abs(all[1]!.top - all[0]!.bottom), 'touching').toBeLessThanOrEqual(PX);
  expect(Math.abs(all[0]!.block.top - all[0]!.top)).toBeLessThanOrEqual(PX);
  expectNoLineUnder(all[1]!);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/pen-66-ac9.png` });
});

test('AC6: on a phone-sized page, a paragraph and a list item that end with a picture keep their gaps', async ({
  page,
}) => {
  await openNote(page, 'softBreak');
  await page.setViewportSize({ width: 412, height: 915 });
  const [picture] = await pictures(page);
  expectTextLineAbove(picture!);
  expectNoLineUnder(picture!);
  expectGapBelow(picture!, BLOCK_GAP);

  await page.setViewportSize({ width: 1280, height: 900 });
  await openNote(page, 'lists');
  await page.setViewportSize({ width: 412, height: 915 });
  const [item] = await pictures(page);
  // The item's text, then the same 0.4 em gap above its picture as in a paragraph.
  expectTextLineAbove(item!);
  expectNoLineUnder(item!);
  const gap = await body(page)
    .locator(':scope > ul')
    .first()
    .evaluate((list) => {
      const [one, two] = list.querySelectorAll(':scope > li');
      return (
        two!.getBoundingClientRect().top - one!.querySelector('p')!.getBoundingClientRect().bottom
      );
    });
  expectGapBelow(item!, gap);

  // As the Mac and Android proofs make it: a bulleted item typed, then a picture pasted after its
  // text, at the phone's width.
  await page.setViewportSize({ width: 1280, height: 900 });
  await openNote(page, 'empty');
  await body(page).click();
  await page.keyboard.type('- Item with a picture');
  await pastePictures(page);
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Item two');
  await page.setViewportSize({ width: 412, height: 915 });
  const [pasted] = await pictures(page);
  expect(pasted!.blockText).toBe('Item with a picture');
  expectTextLineAbove(pasted!);
  expectNoLineUnder(pasted!);
  expectGapBelow(pasted!, LIST_GAP);
  await body(page).locator('.pm-image').first().scrollIntoViewIfNeeded();
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/pen-66-ac6.png` });
});

/**
 * From a picture's bottom to the top of the text after it (the glyphs' box: the line's own
 * half-leading below the line's top).
 */
async function textAfter(page: Page, nth: number, text: string): Promise<number> {
  const picture = body(page).locator('.pm-image').nth(nth);
  await picture.scrollIntoViewIfNeeded();
  return picture.evaluate(async (element, text) => {
    for (let i = 0; i < 2; i++) await new Promise(requestAnimationFrame);
    const block = element.closest('p, td, th')!;
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const at = node.textContent!.indexOf(text);
      if (at < 0) continue;
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + text.length);
      const picture = element.querySelector('img')!.getBoundingClientRect();
      return range.getBoundingClientRect().top - picture.bottom;
    }
    throw new Error(`No “${text}” in the picture’s block`);
  }, text);
}

/** A click just right of the end of some text in the note. */
async function clickAfterText(page: Page, text: string): Promise<void> {
  const { x, y } = await body(page).evaluate((editor, text) => {
    const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const at = node.textContent!.indexOf(text);
      if (at < 0) continue;
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + text.length);
      const { right, top, bottom } = range.getBoundingClientRect();
      return { x: right + 10, y: (top + bottom) / 2 };
    }
    throw new Error(`No “${text}” in the note`);
  }, text);
  await page.mouse.click(x, y);
}

/**
 * The line after a picture starts at the picture's bottom: its text there, under half a line
 * below (as in AC4), not a whole empty line (27 px) further down.
 */
function expectNextLine(gap: number, which: string): void {
  expect(gap, `the line after ${which} below it`).toBeGreaterThanOrEqual(-PX);
  expect(gap, `no empty line after ${which}`).toBeLessThan(0.5 * 16);
}

test('A1354: a line break after a picture puts the next line right under it, at any size', async ({
  page,
}) => {
  // Ryan's note: a tall screenshot narrowed to 48 px, a line break, then “three”.
  await openNote(page, 'ryan');
  const [narrowed] = await pictures(page);
  expect(Math.round(narrowed!.right - narrowed!.left)).toBe(48);
  expect(Math.abs(narrowed!.top - narrowed!.block.top), 'first in its block').toBeLessThanOrEqual(
    PX,
  );
  expectNextLine(await textAfter(page, 0, 'three'), 'the narrowed screenshot');
  expect(Math.abs(narrowed!.block.bottom - narrowed!.bottom - LINE)).toBeLessThanOrEqual(PX);
  // The caret after the picture, before the line break, on the picture's line at its right edge.
  await clickAfterText(page, 'three');
  for (let i = 0; i <= 'three'.length; i++) await page.keyboard.press('ArrowLeft');
  const [scrolled] = await pictures(page);
  expectCaretAfter(await caretBox(page), scrolled!);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/pen-80-note.png` });

  // Tall, wide and small, in a mark, a link, a list item and a table cell, and two in a row.
  await openNote(page, 'breaks');
  const all = await pictures(page);
  expect(all).toHaveLength(10);
  // The tall and wide ones as wide as the column, not cut off.
  for (const i of [0, 1]) {
    expect(all[i]!.right - all[i]!.left).toBeGreaterThan(400);
    expect(all[i]!.right).toBeLessThanOrEqual(all[i]!.block.right + PX);
  }
  const after = ['tall', 'wide', 'small', 'bold', 'linked', 'highlighted', 'in list', 'in cell'];
  for (const [i, which] of after.entries())
    expectNextLine(await textAfter(page, i, `after ${which}`), `the ${which} picture`);
  // Two pictures, each before a line break: the second right under the first, the text under it.
  expect(Math.abs(all[9]!.top - all[8]!.bottom), 'touching').toBeLessThanOrEqual(PX);
  expectNextLine(await textAfter(page, 9, 'after two'), 'the second picture');
});

test('A1354: a screenshot pasted, then Shift-Enter and typing: the typed line right under it', async ({
  page,
}) => {
  await openNote(page, 'empty');
  await body(page).click();
  await page.keyboard.type('one');
  await page.keyboard.press('Shift+Enter');
  await page.keyboard.type('two');
  await page.keyboard.press('Enter');
  // A phone screenshot, taller than the page.
  await pastePictures(page, 1, [1170, 2532]);
  await page.keyboard.press('Shift+Enter');
  await page.keyboard.type('three');
  const [picture] = await pictures(page);
  expect(picture!.blockText).toBe('three');
  expect(picture!.right - picture!.left).toBeGreaterThan(400);
  expectNextLine(await textAfter(page, 0, 'three'), 'the pasted screenshot');
  // The paragraph is the picture and the typed line: nothing between them.
  expect(Math.abs(picture!.block.bottom - picture!.bottom - LINE)).toBeLessThanOrEqual(PX);
  // Back before the line break: the caret on the picture's line, at its right edge.
  for (let i = 0; i <= 'three'.length; i++) await page.keyboard.press('ArrowLeft');
  // The picture is taller than the page: its bottom, where the caret ends, mid-page.
  await body(page)
    .locator('.pm-image img')
    .evaluate((img) => {
      let scroller = img.parentElement;
      while (scroller && scroller.scrollHeight <= scroller.clientHeight)
        scroller = scroller.parentElement;
      scroller!.scrollBy(0, img.getBoundingClientRect().bottom - innerHeight / 2);
    });
  const [shown] = await pictures(page);
  expectCaretAfter(await caretBox(page), shown!);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/pen-80-pasted.png` });
});
