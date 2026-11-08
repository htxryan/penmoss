import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  anotherMac,
  expect,
  GitHost,
  macContext,
  PREVIEW,
  test,
  type Browser,
  type BrowserContext,
  type Page,
} from './fixtures';
import { BUILT_IN_THEMES, NORD, PENMOSS, themeVariables } from '@penmoss/ui/theme';

// T28: every built-in theme in light and dark (a screenshot of each), switched from the
// palette's "Switch theme…" and "Toggle dark mode"; a custom theme duplicated, edited and
// seen on a second device. On a git notebook (T59) themes are the notebook's device settings
// (A827), which reach another Mac through its remote. The serial suites share one page, on a
// stand-in Mac of their own (one notebook) made in beforeAll.

const ULID = /\/notes\/([0-9A-HJKMNP-TV-Z]{26})$/;
const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
/** Where screenshots go: docs/evidence/t28 when EVIDENCE_DIR names it, else the test's output. */
const EVIDENCE_DIR = process.env['EVIDENCE_DIR'];

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(error.message));
  return errors;
}

const body = (page: Page) => page.getByTestId('note-body').locator('.ProseMirror');
const html = (page: Page) => page.locator('html');

/** `#rrggbb` as getComputedStyle reports it. */
function rgb(hex: string): string {
  const [r, g, b] = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16));
  return `rgb(${r}, ${g}, ${b})`;
}

/** A note with each thing a theme colours: text, a link, a highlight, code, a callout, math, a diagram. */
async function sampleNote(page: Page): Promise<string> {
  await page.goto('/');
  await expect(page.getByTestId('app-root')).toBeVisible();
  await page
    .getByTestId('sidebar-shortcuts')
    .getByRole('button', { name: 'New Note', exact: true })
    .click();
  await expect(page).toHaveURL(ULID);
  await page.keyboard.type(`Garden plan ${RUN}`);
  await page.keyboard.press('Enter');
  await expect(body(page)).toBeFocused();
  // The diagram first (as blocks.spec does), then text after it.
  await page.keyboard.type('```mermaid');
  await page.keyboard.press('Enter');
  await page.keyboard.type('graph LR\n  A[Seed] --> B{Sprout?}\n  B -->|yes| C[Plant]');
  const diagram = body(page).locator('.pm-code-block[data-language="mermaid"]');
  await expect(diagram.locator('.pm-diagram-output svg')).toBeVisible({ timeout: 15_000 });
  await diagram.getByRole('button', { name: 'Preview Diagram' }).click();
  await expect(diagram).toHaveAttribute('data-mode', 'preview');
  await body(page).locator('p').last().click();
  await page.keyboard.type('Raised beds by the fence, with ==tomatoes== and `basil`. #garden');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Area: $\\pi r^2$ per bed.');
  await page.keyboard.press('Enter');
  await page.keyboard.type('> [!tip] Water in the morning.');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await page.keyboard.type('```ts');
  await page.keyboard.press('Enter');
  await page.keyboard.type("const beds: number = 4; // by the fence\nplant('tomato');");
  await expect(body(page).locator('.hljs-keyword').first()).toBeVisible();
  await expect(body(page).locator('.pm-math-inline .katex')).toBeVisible();
  await expect(page.getByTestId('note-view')).toHaveAttribute('data-ready', 'true');
  // The tests reload the app: leave only once the notebook has the note, pushed.
  const dot = page.getByTestId('section-sync');
  await expect(dot).toHaveAttribute('data-state', 'synced', { timeout: 40_000 });
  await expect(dot).toHaveAttribute('data-pending', '0', { timeout: 40_000 });
  return ULID.exec(new URL(page.url()).pathname)![1]!;
}

/** Runs a palette command by its title. */
async function runCommand(page: Page, title: string) {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('ControlOrMeta+KeyK');
  const palette = page.getByRole('dialog', { name: 'Command Palette' });
  await expect(palette).toBeVisible();
  await palette.getByRole('combobox').fill(title);
  await expect(palette.getByRole('option').first()).toContainText(title);
  await page.keyboard.press('Enter');
  await expect(palette).toBeHidden();
}

/** A stand-in Mac with one notebook, and a window of it, for a serial suite's shared page. */
async function suiteMac(browser: Browser) {
  const host = new GitHost();
  const notebook = await host.seed();
  const context = await macContext(browser, host);
  return { host, remote: notebook.remote, context, page: await context.newPage() };
}

async function resetAppearance(page: Page) {
  await page.goto('/settings/appearance');
  const settings = page.getByTestId('appearance-settings');
  await settings.locator('label.theme-card[data-theme-id="penmoss"]').click();
  await settings.getByTestId('theme-mode').getByText('System').click();
  await expect(html(page)).toHaveAttribute('data-theme', 'penmoss');
}

test.describe.serial('T28: every built-in theme in light and dark, from the palette', () => {
  // One page and one note for the 16 switches: each switch is its own test.
  let mac: GitHost;
  let context: BrowserContext;
  let page: Page;
  let errors: string[];
  let dir: string;

  test.beforeAll(async ({ browser }, info) => {
    ({ host: mac, context, page } = await suiteMac(browser));
    errors = collectErrors(page);
    dir = EVIDENCE_DIR ?? info.outputPath('themes');
    mkdirSync(dir, { recursive: true });
    const id = await sampleNote(page);
    // Light first, from Settings → Appearance; the dark pass uses the palette's toggle.
    await page.goto('/settings/appearance');
    await page.getByTestId('theme-mode').getByText('Light').click();
    await expect(html(page)).toHaveAttribute('data-mode', 'light');
    await page.goto(`/notes/${id}`);
    await expect(page.getByTestId('note-view')).toHaveAttribute('data-ready', 'true');
    await expect(body(page).locator('.pm-diagram-output svg')).toBeVisible({ timeout: 15_000 });
  });

  test.afterAll(async () => {
    await resetAppearance(page);
    await context.close();
    await mac.close();
  });

  for (const variant of ['light', 'dark'] as const) {
    for (const theme of BUILT_IN_THEMES) {
      test(`${theme.name}, ${variant}`, async () => {
        if (variant === 'dark' && theme === BUILT_IN_THEMES[0]) {
          await runCommand(page, 'Toggle Dark Mode');
          await expect(html(page)).toHaveAttribute('data-mode', 'dark');
        }
        const svg = body(page).locator('.pm-diagram-output svg');
        const drawn = await svg.innerHTML();
        await runCommand(page, 'Switch Theme…');
        const picker = page.getByRole('dialog', { name: 'Switch Theme' });
        await expect(picker).toBeVisible();
        await picker.locator(`[role="option"][data-theme-id="${theme.id}"]`).click();
        await expect(picker).toBeHidden();
        await expect(html(page)).toHaveAttribute('data-theme', theme.id);
        await expect(html(page)).toHaveAttribute('data-mode', variant);

        // The page, the code palette, the formula and the diagram all follow the theme.
        const colours = theme[variant];
        await expect(page.locator('body')).toHaveCSS('background-color', rgb(colours.bg));
        await expect(body(page).locator('.hljs-keyword').first()).toHaveCSS(
          'color',
          rgb(colours.codeKeyword),
        );
        await expect(body(page).locator('.pm-math-inline .katex').first()).toHaveCSS(
          'color',
          rgb(colours.fg),
        );
        if (theme.id !== 'penmoss' || variant !== 'light') {
          await expect.poll(() => svg.innerHTML(), { timeout: 10_000 }).not.toBe(drawn);
        }
        await page.mouse.move(0, 0);
        // Controls fade between colours (120 ms): capture the settled theme.
        await page.waitForFunction(() =>
          document.getAnimations().every((animation) => !(animation instanceof CSSTransition)),
        );
        await page.screenshot({ path: join(dir, `${theme.id}-${variant}.png`) });
        expect(errors).toEqual([]);
      });
    }
  }
});

test.describe.serial('T28: a custom theme', () => {
  let mac: GitHost;
  let remote: string;
  let context: BrowserContext;
  let page: Page;
  let errors: string[];
  let customId: string;
  let dir: string;
  const name = `Fjord ${RUN}`;

  test.beforeAll(async ({ browser }, info) => {
    ({ host: mac, remote, context, page } = await suiteMac(browser));
    errors = collectErrors(page);
    dir = EVIDENCE_DIR ?? info.outputPath('appearance');
    mkdirSync(dir, { recursive: true });
  });

  test.afterAll(async () => {
    await resetAppearance(page);
    await context.close();
    await mac.close();
  });

  test('is duplicated from a built-in and edited live', async () => {
    await page.goto('/settings/appearance');
    const settings = page.getByTestId('appearance-settings');
    await expect(settings).toBeVisible();
    await settings.getByTestId('theme-mode').getByText('Light').click();
    await settings.locator('label.theme-card[data-theme-id="nord"]').click();
    await expect(html(page)).toHaveAttribute('data-theme', 'nord');

    // Built-ins are read-only: duplicate Nord, and the copy is chosen and editable.
    await settings.getByRole('button', { name: 'Duplicate Nord' }).click();
    const editor = page.getByTestId('custom-theme-editor');
    await expect(editor).toBeVisible();
    await expect(html(page)).toHaveAttribute('data-theme', /^custom-/);
    customId = (await html(page).getAttribute('data-theme'))!;
    await editor.getByLabel('Name', { exact: true }).fill(name);

    // A colour edit shows on the whole app at once, and in the preview.
    await editor.getByLabel('Accent, hex', { exact: true }).fill('#7a3e9d');
    await expect
      .poll(() =>
        page.evaluate(() => document.documentElement.style.getPropertyValue('--pm-accent')),
      )
      .toBe('#7a3e9d');
    await expect(page.getByTestId('theme-preview').locator('.tp-button')).toHaveCSS(
      'background-color',
      rgb('#7a3e9d'),
    );
    const report = editor.getByTestId('theme-contrast');
    await expect(report).toContainText('passes WCAG AA');

    // A poor choice is called out with the pairs it breaks.
    const muted = editor.getByLabel('Secondary text and icons, hex', { exact: true });
    await muted.fill('#c8ccd4');
    await expect(report).toContainText('below WCAG AA');
    await muted.fill(NORD.light.muted);
    await expect(report).toContainText('passes WCAG AA');

    // The theme is a card like the built-ins.
    await expect(settings.locator(`label.theme-card[data-theme-id="${customId}"]`)).toContainText(
      name,
    );
    await page.mouse.move(0, 0);
    // On a desktop only Settings' content scrolls (T51, A942).
    await page.evaluate(() => document.querySelector('.settings-content')?.scrollTo(0, 0));
    await page.screenshot({ path: join(dir, 'appearance-desktop.png') });
    await editor.screenshot({ path: join(dir, 'theme-editor-desktop.png') });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: join(dir, 'appearance-phone.png') });
    await page.getByTestId('theme-preview').scrollIntoViewIfNeeded();
    await page.screenshot({ path: join(dir, 'theme-editor-phone.png') });
    await page.setViewportSize({ width: 1280, height: 720 });
    expect(errors).toEqual([]);
  });

  test('syncs to another device', async ({ browser }) => {
    test.setTimeout(120_000);
    // Another Mac on the notebook's remote: the theme reaches it once pushed.
    const other = await anotherMac(browser, { remote });
    const device = other.page;
    try {
      await device.goto('/settings/appearance');
      await expect(device.locator('html')).toHaveAttribute('data-theme', customId, {
        timeout: 90_000,
      });
      await expect(device.locator('html')).toHaveAttribute('data-mode', 'light');
      await expect
        .poll(() =>
          device.evaluate(() => document.documentElement.style.getPropertyValue('--pm-accent')),
        )
        .toBe('#7a3e9d');
      await expect(
        device.getByTestId('custom-theme-editor').getByLabel('Name', { exact: true }),
      ).toHaveValue(name);
    } finally {
      await other.context.close();
    }
  });

  test('is remembered across a reload, and deleting it goes back to its base', async () => {
    // Shown before the workspace is read: this device remembers the last theme.
    await page.reload();
    await expect(html(page)).toHaveAttribute('data-theme', customId);
    await page.getByRole('button', { name: 'Delete This Theme' }).click();
    await page.getByRole('button', { name: 'Delete Theme' }).click();
    await expect(html(page)).toHaveAttribute('data-theme', 'nord');
    await expect(page.locator(`label.theme-card[data-theme-id="${customId}"]`)).toHaveCount(0);
    expect(errors).toEqual([]);
  });
});

test.describe('T28: the first paint, before the app’s bundle has loaded', () => {
  /** The production build, with no service worker and the app's bundle never arriving. */
  async function withoutBundle(browser: Browser, host: GitHost, colorScheme: 'light' | 'dark') {
    const context = await macContext(browser, host, {
      baseURL: PREVIEW,
      serviceWorkers: 'block',
      colorScheme,
    });
    const page = await context.newPage();
    await page.route(/\/assets\/main-[^/]*\.js$/, (route) => route.abort());
    return { context, page };
  }

  test('is already in the remembered theme', async ({ browser, host }) => {
    const { context, page } = await withoutBundle(browser, host, 'light');
    try {
      await context.addInitScript(
        (cache) => localStorage.setItem('penmoss.theme', cache),
        JSON.stringify({
          mode: 'dark',
          id: 'nord',
          vars: { light: themeVariables(NORD, 'light'), dark: themeVariables(NORD, 'dark') },
        }),
      );
      await page.goto('/', { waitUntil: 'domcontentloaded' });
      await expect(page.locator('html')).toHaveAttribute('data-mode', 'dark');
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'nord');
      await expect(page.locator('body')).toHaveCSS('background-color', rgb(NORD.dark.bg));
      // The app never started: this is the page as the browser first painted it.
      await expect(page.getByTestId('app-root')).toHaveCount(0);
    } finally {
      await context.close();
    }
  });

  test('is Penmoss in the system’s scheme on a first visit', async ({ browser, host }) => {
    const { context, page } = await withoutBundle(browser, host, 'dark');
    try {
      await page.goto('/', { waitUntil: 'domcontentloaded' });
      await expect(page.locator('body')).toHaveCSS('background-color', rgb(PENMOSS.dark.bg));
      await expect(page.locator('body')).toHaveCSS('color', rgb(PENMOSS.dark.fg));
    } finally {
      await context.close();
    }
  });
});
