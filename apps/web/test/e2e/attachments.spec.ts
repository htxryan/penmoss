import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { expect, macContext, PREVIEW, seeded, test, type Page } from './fixtures';
import { DOC_END, LINE_END } from './keys';
import { remoteFiles, remoteMarkdown } from './support/remote';
import { remoteBytes } from './support/sync';

// T13: files attached through the slash menu (a PDF with a preview, any other file to
// download) go into the git notebook's repository (T59, A828: `attachments/<sha256>.<ext>`);
// ![[Note#Heading]] embeds
// render the section read-only, follow edits made elsewhere, show a cycle as a link,
// stay searchable only in their source note, and survive copy and paste between notes.

const ULID = /\/notes\/([0-9A-HJKMNP-TV-Z]{26})$/;
const TAG = `e${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const SOURCE = `Garden ${TAG}`;
const HOST = `Weekly ${TAG}`;
const TARGET = `Pasted ${TAG}`;
const WORD = `marigold${TAG}`;

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error' && !/WebSocket|net::/.test(message.text())) {
      errors.push(message.text());
    }
  });
  page.on('pageerror', (error) => errors.push(error.message));
  return errors;
}

const body = (page: Page) => page.getByTestId('note-body').locator('.ProseMirror');
const menu = (page: Page) => page.getByTestId('link-menu');
const notice = (page: Page) => page.getByTestId('note-notice');

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

/** Types `prefix + query`, waits for `option` to lead the menu, and picks it. */
async function complete(page: Page, typed: string, option: string) {
  await page.keyboard.type(typed);
  await expect(menu(page)).toBeVisible();
  await expect(menu(page).getByRole('option').first()).toContainText(option);
  await page.keyboard.press('Enter');
  await expect(menu(page)).toBeHidden();
}

/** Picks "File" in the slash menu and hands the chooser `files`. */
async function attach(
  page: Page,
  files: Parameters<import('@playwright/test').FileChooser['setFiles']>[0],
) {
  const chooser = page.waitForEvent('filechooser');
  await page.keyboard.type('/file');
  const slash = page.getByTestId('slash-menu');
  await expect(slash.getByRole('option', { selected: true })).toContainText('File');
  await page.keyboard.press('Enter');
  await (await chooser).setFiles(files);
}

const PDF = Buffer.from(
  `%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 144]>>endobj\ntrailer<</Root 1 0 R>>\n%${TAG}\n%%EOF\n`,
);
const CSV = Buffer.from(`plant,month\nmarigold,May\n${TAG},June\n`);
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

test('T13: attach files, embed a live section, cycles as links, copy and paste', async ({
  page,
  context,
  host: mac,
  notebook,
}) => {
  test.setTimeout(150_000);
  const errors = collectErrors(page);
  await page.goto('/');

  // The source: a section to embed.
  const source = await createNote(page, SOURCE);
  await page.keyboard.type('Intro line.');
  await page.keyboard.press('Enter');
  await page.keyboard.type('## Plan');
  await page.keyboard.press('Enter');
  await page.keyboard.type(`Dig the beds in March and sow ${WORD}s.`);
  await page.keyboard.press('Enter');
  await page.keyboard.type('## Later');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Harvest in August.');

  // The host embeds it through ![[ completion, heading included.
  const host = await createNote(page, HOST);
  await page.keyboard.type('Before the embed.');
  await page.keyboard.press('Enter');
  await complete(page, `![[${SOURCE}#Pl`, 'Plan');
  const embed = body(page).getByTestId('embed');
  await expect(embed).toHaveAttribute('data-state', 'ready');
  await expect(embed.locator('.pm-embed-title')).toHaveText(`${SOURCE} › Plan`);
  await expect(embed).toContainText(`Dig the beds in March and sow ${WORD}s.`);
  await expect(embed).not.toContainText('Harvest in August.');

  // Edited in another tab: the embed follows, live.
  const other = await context.newPage();
  const otherErrors = collectErrors(other);
  await other.goto(`/notes/${source}`);
  await body(other).getByText(`Dig the beds in March`).click();
  await other.keyboard.press(LINE_END);
  await other.keyboard.type(' Bring compost.');
  await expect(embed).toContainText('Bring compost.', { timeout: 20_000 });

  // The source embeds the host inside its Plan section: a cycle, shown as a link.
  await other.keyboard.press('Enter');
  await complete(other, `![[${HOST}`, HOST);
  const nested = embed.locator('.pm-embed-nested');
  await expect(nested).toHaveAttribute('data-state', 'cycle', { timeout: 20_000 });
  await expect(nested.locator('.pm-embed-notice a.pm-wikilink')).toHaveText(HOST);
  // The source's own view shows the host, whose embed of the source is the cycle.
  await expect(body(other).getByTestId('embed').locator('.pm-embed-nested')).toHaveAttribute(
    'data-state',
    'cycle',
  );
  await other.close();

  // Attach a PDF and a spreadsheet from the slash menu.
  await body(page).locator(':scope > p').last().click();
  await attach(page, [
    { name: 'Field guide.pdf', mimeType: 'application/pdf', buffer: PDF },
    { name: 'plants.csv', mimeType: 'text/csv', buffer: CSV },
  ]);
  const chips = body(page).getByTestId('attachment');
  await expect(chips).toHaveCount(2);
  const [pdfChip, csvChip] = [chips.nth(0), chips.nth(1)];
  await expect(pdfChip.locator('.pm-attachment-name')).toHaveText('Field guide.pdf');
  await expect(pdfChip.locator('.pm-attachment-badge')).toHaveText('PDF');
  await expect(pdfChip.locator('.pm-attachment-size')).toHaveText(`${PDF.byteLength} B`);
  await expect(csvChip.locator('.pm-attachment-badge')).toHaveText('CSV');
  await expect(csvChip.getByRole('button', { name: /Preview/ })).toBeHidden();

  // Download under the file's own name; preview the PDF in the page.
  const download = page.waitForEvent('download');
  await csvChip.getByRole('button', { name: 'Download plants.csv' }).click();
  const saved = await download;
  expect(saved.suggestedFilename()).toBe('plants.csv');
  expect(readFileSync(await saved.path())).toEqual(CSV);
  await pdfChip.getByRole('button', { name: 'Preview Field guide.pdf' }).click();
  await expect(pdfChip.getByTestId('attachment-preview')).toHaveAttribute('src', /^blob:/);
  await pdfChip.getByRole('button', { name: 'Close the Preview of Field guide.pdf' }).click();
  await expect(pdfChip.getByTestId('attachment-preview')).toHaveCount(0);

  // Pushed into the repository beside the notes, byte for byte (A828).
  const { remote } = seeded(notebook);
  const pdfPath = `attachments/${sha(PDF)}.pdf`;
  const csvPath = `attachments/${sha(CSV)}.csv`;
  await expect
    .poll(() => remoteFiles(mac, remote), { timeout: 60_000, intervals: [2_000] })
    .toEqual(expect.arrayContaining([pdfPath, csvPath]));
  expect(remoteBytes(mac, remote, pdfPath)).toEqual(PDF);
  expect(remoteBytes(mac, remote, csvPath)).toEqual(CSV);

  // Over 50 MB: refused with a clear message, nothing inserted.
  const huge = test.info().outputPath('huge.bin');
  writeFileSync(huge, Buffer.alloc(50 * 1024 * 1024 + 1, 1));
  // The caret at the end of the note (keyboard, clear of the chips' buttons).
  await body(page).getByText('Before the embed.').click();
  await page.keyboard.press(DOC_END);
  await attach(page, huge);
  await expect(notice(page)).toHaveText(
    '“huge.bin” is over 50 MB, the largest file Penmoss stores',
  );
  await expect(chips).toHaveCount(2);

  // The host's markdown in the repository holds the reference and the file's link, never the
  // embedded text; search finds that text only in the source.
  const embedRef = `![[${SOURCE}#Plan]]`;
  const pdfLink = `[Field guide.pdf](${pdfPath})`;
  await expect
    .poll(
      () => {
        const text = remoteMarkdown(mac, remote, host) ?? '';
        return { embed: text.includes(embedRef), pdf: text.includes(pdfLink) };
      },
      { timeout: 60_000, intervals: [2_000] },
    )
    .toEqual({ embed: true, pdf: true });
  expect(remoteMarkdown(mac, remote, host)).not.toContain(WORD);
  await page.keyboard.press('ControlOrMeta+Shift+KeyF');
  const search = page.getByTestId('search');
  await search.getByRole('combobox', { name: 'Search notes' }).fill(`${WORD}s`);
  const results = search.getByRole('listbox', { name: 'Search results' }).getByRole('option');
  await expect(results).toHaveCount(1);
  await expect(results.first()).toContainText(SOURCE);
  await page.keyboard.press('Escape');
  await expect(search).toBeHidden();

  // Copy everything in the host and paste it into another note: embed and files come along.
  await body(page).click();
  await page.keyboard.press('ControlOrMeta+a');
  const clipboard = await page.evaluate(() => {
    const transfer = new DataTransfer();
    document
      .querySelector<HTMLElement>('[data-testid="note-body"] .ProseMirror')!
      .dispatchEvent(
        new ClipboardEvent('copy', { clipboardData: transfer, bubbles: true, cancelable: true }),
      );
    return { html: transfer.getData('text/html'), text: transfer.getData('text/plain') };
  });
  expect(clipboard.html).toContain('data-embed');
  await createNote(page, TARGET);
  await page.evaluate((data) => {
    const transfer = new DataTransfer();
    transfer.setData('text/html', data.html);
    transfer.setData('text/plain', data.text);
    const editor = document.querySelector<HTMLElement>('[data-testid="note-body"] .ProseMirror')!;
    editor.focus();
    editor.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }),
    );
  }, clipboard);
  const pasted = body(page).getByTestId('embed');
  await expect(pasted).toHaveAttribute('data-state', 'ready');
  await expect(pasted).toContainText('Bring compost.');
  await expect(body(page).getByTestId('attachment')).toHaveCount(2);
  await expect(body(page).getByTestId('attachment').first()).toContainText('Field guide.pdf');

  expect(errors).toEqual([]);
  expect(otherErrors).toEqual([]);
});

test('T13: the production build previews an attached PDF under the app CSP', async ({
  browser,
  host,
}) => {
  test.setTimeout(90_000);
  const context = await macContext(browser, host, { baseURL: PREVIEW });
  try {
    const page = await context.newPage();
    await page.addInitScript(() => {
      const seen: string[] = [];
      Object.assign(window, { cspViolations: seen });
      document.addEventListener('securitypolicyviolation', (event) =>
        seen.push(`${event.violatedDirective} ${event.blockedURI}`),
      );
    });
    const response = await page.goto('/');
    expect(response?.headers()['content-security-policy']).toContain("frame-src 'self' blob:");
    await createNote(page, `CSP ${TAG}`);
    await attach(page, [{ name: 'Preview.pdf', mimeType: 'application/pdf', buffer: PDF }]);
    const chip = body(page).getByTestId('attachment');
    await chip.getByRole('button', { name: 'Preview Preview.pdf' }).click();
    await expect(chip.getByTestId('attachment-preview')).toHaveAttribute('src', /^blob:/);
    await page.waitForTimeout(500);
    expect(
      await page.evaluate(() => (window as unknown as { cspViolations: string[] }).cspViolations),
    ).toEqual([]);
  } finally {
    await context.close();
  }
});
