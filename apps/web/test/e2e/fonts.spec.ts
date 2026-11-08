import { FONT_PRESET_STACKS } from '@penmoss/core/fonts';
import { expect, seeded, test, type GitHost, type Page } from './fixtures';
import { NEW_NOTE } from './keys';
import { storedSetting } from './stored';
import { readRemote } from './support/remote';

// T51 item 16 (A944): Settings → Appearance → Fonts. The Interface Font, the Note Font and the
// Note Font Size are synced settings laid over the theme's fonts: the interface takes the
// first, a note's title, headings and text the second and third, code keeps the theme's mono
// font, and the page starts in them after a reload. On a git notebook (T59) they are the
// notebook's device settings (A827), stored here and pushed to its remote; Reset clears them.

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
const variable = (page: Page, name: string) =>
  page.evaluate((each) => getComputedStyle(document.documentElement).getPropertyValue(each), name);

/** Settings → Appearance once the settings have arrived (a change before then could be lost). */
async function openFonts(page: Page) {
  // The sync dot is the sidebar's (A933): wait on the notes page, then open Settings in-app.
  await page.goto('/');
  await expect(page.getByTestId('section-sync')).toHaveAttribute('data-state', 'synced', {
    timeout: 40_000,
  });
  await page.getByTestId('sidebar-settings').click();
  await page.getByRole('link', { name: 'Appearance' }).click();
  await expect(page).toHaveURL(/\/settings\/appearance$/);
  const fonts = page.getByTestId('font-settings');
  await expect(fonts).toBeVisible();
  await expect(fonts.getByLabel('Interface Font', { exact: true })).toBeEnabled();
  return fonts;
}

const FONT_KEYS = ['font.interface', 'font.note', 'font.noteSize'] as const;

/** The fonts as the notebook's remote holds them. */
async function pushedFonts(host: GitHost, remote: string) {
  const read = await readRemote(host, remote);
  return Object.fromEntries(FONT_KEYS.map((key) => [key, read.setting(key)]));
}

async function resetFonts(page: Page, host: GitHost, remote: string) {
  const fonts = await openFonts(page);
  await fonts.getByLabel('Interface Font', { exact: true }).selectOption('theme');
  await fonts.getByLabel('Note Font', { exact: true }).selectOption('theme');
  await fonts.getByRole('button', { name: 'Reset' }).click();
  await expect(fonts.getByTestId('note-size-value')).toHaveText('16 px');
  // Stored here, and gone from the remote too once pushed.
  for (const key of FONT_KEYS) {
    await expect.poll(() => storedSetting(page, key), { timeout: 10_000 }).toBeUndefined();
  }
  await expect
    .poll(() => pushedFonts(host, remote), { timeout: 90_000 })
    .toEqual({ 'font.interface': undefined, 'font.note': undefined, 'font.noteSize': undefined });
}

test('the interface font, the note font and the note size apply over the theme’s', async ({
  page,
  host,
  notebook,
}) => {
  test.setTimeout(240_000);
  const errors = collectErrors(page);
  const { remote } = seeded(notebook);
  const fonts = await openFonts(page);
  // Each preset offered in its own letters, Custom… last.
  const interfaceFont = fonts.getByLabel('Interface Font', { exact: true });
  await expect(interfaceFont.locator('option')).toHaveText([
    'Theme Default',
    'System',
    'Serif',
    'Rounded',
    'Humanist',
    'Monospace',
    'Custom…',
  ]);
  await expect(interfaceFont).toHaveClass(/pm-select/);

  await interfaceFont.selectOption('serif');
  await expect.poll(() => variable(page, '--pm-font')).toBe(FONT_PRESET_STACKS.serif);
  await expect(page.locator('.settings-nav')).toHaveCSS('font-family', /ui-serif/);

  await fonts.getByLabel('Note Font', { exact: true }).selectOption('mono');
  for (let step = 0; step < 4; step++) {
    await fonts.getByRole('button', { name: 'Larger' }).click();
  }
  await expect(fonts.getByTestId('note-size-value')).toHaveText('20 px');
  await expect.poll(() => variable(page, '--pm-note-size')).toBe('20px');

  // A custom family: refused until it is a name, then over the system's stack.
  await interfaceFont.selectOption('custom');
  const custom = fonts.getByTestId('interface-font-custom');
  await custom.fill('Avenir; Next');
  await custom.press('Enter');
  await expect(fonts.getByRole('alert')).toContainText('Font name may hold only');
  await custom.fill('Avenir Next');
  await custom.press('Enter');
  await expect
    .poll(() => variable(page, '--pm-font'))
    .toBe(`'Avenir Next', ${FONT_PRESET_STACKS.system}`);

  // A note: its title, headings and text in the note font at the note size; code in mono.
  await page.goto('/');
  await expect(page.locator('button[data-command="note.new"]').first()).toBeVisible();
  await page.keyboard.press(NEW_NOTE);
  await expect(page).toHaveURL(ULID);
  await expect(page.getByTestId('note-title')).toBeFocused();
  await page.keyboard.type(`Fonts ${RUN}`);
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('note-view')).toHaveAttribute('data-ready', 'true');
  await page.keyboard.type('# A heading');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Some text');
  await expect(body(page)).toHaveCSS('font-size', '20px');
  await expect(body(page)).toHaveCSS('font-family', /ui-monospace/);
  await expect(body(page).locator('h1')).toHaveCSS('font-size', '32px');
  await expect(page.getByTestId('note-title')).toHaveCSS('font-size', '38px');

  // A reload starts in them, before the workspace is read.
  await page.reload();
  await expect.poll(() => variable(page, '--pm-note-size')).toBe('20px');
  expect(await variable(page, '--pm-font')).toBe(`'Avenir Next', ${FONT_PRESET_STACKS.system}`);

  // The notebook keeps them, and pushes them to its remote.
  expect(await storedSetting(page, 'font.note')).toBe('mono');
  await expect
    .poll(() => pushedFonts(host, remote), { timeout: 90_000 })
    .toMatchObject({ 'font.note': 'mono', 'font.noteSize': 20 });
  await resetFonts(page, host, remote);
  expect(errors).toEqual([]);
});
