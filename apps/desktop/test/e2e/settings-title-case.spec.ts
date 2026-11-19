import { expect, test, type Page } from '@playwright/test';
import { titleCaseProblem } from '@penmoss/core/title-case';
import { BUILT_IN_THEMES } from '@penmoss/ui/theme';
import { SETTINGS_PAGES } from '../../../web/src/pages/settings-index';
import {
  gitNotebook,
  go,
  holdForProof,
  launch,
  mainBounds,
  removeDataDirs,
  type Launched,
} from './support';

// PEN-137 ac42 (A938 amended) in the Mac app: every Settings section names its labels, legends,
// headings, switches, buttons, tabs and status chips in Title Case, with the Mac's own answers
// (Updates, Semantic Search, the penmoss command, GitHub) as main gives them. Each page this Mac
// lists is opened (a notebook's own page with each tab, its agents, the theme editor and
// Privacy's Advanced too), each control and heading is read by its accessible name, and each
// name is held to core's rule (`@penmoss/core/title-case`). Hints and sentences are not read.
// The web suite has the same check against its stand-in Mac (apps/web/test/e2e/
// settings-title-case.spec.ts).

const opened: Launched[] = [];

test.afterEach(async () => {
  for (const { app } of opened.splice(0)) await app.close().catch(() => undefined);
});
test.afterAll(() => removeDataDirs());

/** The roles whose names are labels; links are mostly words in a sentence, so not read. */
const ROLES = new Set([
  'heading',
  'button',
  'switch',
  'checkbox',
  'radio',
  'radiogroup',
  'tab',
  'group',
  'combobox',
  'option',
  'textbox',
  'searchbox',
  'spinbutton',
  'slider',
  'region',
  'alertdialog',
  'dialog',
]);

/** A built-in theme's card says its name, then its description (a sentence). */
const DESCRIPTIONS = BUILT_IN_THEMES.map((theme) => theme.description);

/**
 * What of a name is words to check: the data in it (a command's title, a symbol's name, a
 * width in rem, a theme's description) is taken out or checked on its own.
 */
function wordsOf(name: string): string[] {
  const shortcut =
    /^(Add Shortcut for|Change the Shortcut for|Remove the Shortcut for|Reset the Shortcut for) (.+?)(?:, [^,]*)?$/.exec(
      name,
    );
  if (shortcut) return [`${shortcut[1]} X`, shortcut[2]!];
  const symbol = /^Move .+, (Symbol \d+ of \d+)$/.exec(name);
  if (symbol) return [`Move X, ${symbol[1]}`];
  if (/^Remove [^\p{L}\p{N}\s]+ /u.test(name)) return ['Remove X'];
  let words = name.replace(/\(\d+(?:\.\d+)? rem\)/g, '(X)');
  for (const description of DESCRIPTIONS) words = words.replace(` ${description}`, '');
  return [words];
}

interface Name {
  readonly where: string;
  readonly role: string;
  readonly name: string;
}

/** Every label-like name on the page: its accessibility tree, and legends and chips. */
async function names(page: Page, where: string): Promise<Name[]> {
  const settings = page.getByTestId('settings');
  const found: Name[] = [];
  for (const line of (await settings.ariaSnapshot()).split('\n')) {
    const match = /^\s*- (\w+) "((?:[^"\\]|\\.)*)"/.exec(line);
    if (!match || !ROLES.has(match[1]!)) continue;
    found.push({ where, role: match[1]!, name: JSON.parse(`"${match[2]}"`) as string });
  }
  const texts = await settings
    .locator('legend, .lf-row-label, .lf-sub-name, summary, .chip')
    .evaluateAll((elements) =>
      elements.map((element) => {
        // A summary's hint (Privacy's Advanced) is a sentence beside its title, so not read.
        const label = element.cloneNode(true) as Element;
        for (const hint of label.querySelectorAll('.lf-sub-hint')) hint.remove();
        return [element.tagName.toLowerCase(), label.textContent ?? ''];
      }),
    );
  for (const [tag, text] of texts) {
    const name = text!.replace(/\s+/g, ' ').trim();
    if (name) found.push({ where, role: tag!, name });
  }
  return found;
}

function problems(found: readonly Name[]): string[] {
  return found.flatMap(({ where, role, name }) =>
    wordsOf(name).flatMap((words) => {
      const problem = titleCaseProblem(words);
      return problem ? [`${where} · ${role}: ${problem}`] : [];
    }),
  );
}

/** A page of Settings, once its title is there and main's answers have come. */
async function open(page: Page, path: string): Promise<void> {
  await go(page, path);
  await expect(page).toHaveURL(new RegExp(`${path.replaceAll('/', '\\/')}$`));
  await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
  // The Mac's answers (the CLI's state, the model, the agent copies, updates) arrive a moment
  // later: a check of what is shown, not of something happening.
  await page.waitForTimeout(750);
}

test('every Settings section on the Mac names its controls in Title Case (ac42)', async () => {
  test.setTimeout(240_000);
  const launched = await launch({ macWindow: true });
  opened.push(launched);
  const { app, page } = launched;
  await mainBounds(app, { x: 0, y: 0, width: 1280, height: 720 });
  await gitNotebook(launched);

  const found: Name[] = [];
  // Every section this Mac shows, as its nav lists them.
  await open(page, '/settings/appearance');
  const paths = await page
    .getByRole('navigation', { name: 'Settings Sections' })
    .getByRole('link')
    .evaluateAll((links) =>
      links
        .map((link) => link.getAttribute('href') ?? '')
        .filter((href) => /^\/settings\/[a-z-]+$/.test(href)),
    );
  expect(paths.length).toBeGreaterThanOrEqual(13);
  expect(paths).toContain('/settings/privacy');
  for (const path of paths) {
    await open(page, path);
    found.push(...(await names(page, path.slice('/settings/'.length))));
  }
  // Privacy's Advanced, opened.
  await open(page, '/settings/privacy');
  await page.getByTestId('privacy-advanced-summary').click();
  await expect(page.getByTestId('privacy-advanced')).toHaveAttribute('open', '');
  found.push(...(await names(page, 'privacy › advanced')));
  // A notebook's own page, each of its tabs, and its agents.
  await open(page, '/settings/git-notebooks');
  await page.getByTestId('git-notebook-row').filter({ hasText: 'Notes' }).click();
  await expect(page).toHaveURL(/\/settings\/git-notebooks\/[0-9A-HJKMNP-TV-Z]{26}$/);
  const id = /\/settings\/git-notebooks\/([0-9A-HJKMNP-TV-Z]{26})$/.exec(page.url())![1]!;
  await page.waitForTimeout(750);
  const tabs = page.getByRole('tablist').first().getByRole('tab');
  for (let tab = 0; tab < (await tabs.count()); tab++) {
    await tabs.nth(tab).click();
    found.push(...(await names(page, `notebook tab ${tab + 1}`)));
  }
  await open(page, `/settings/agents/${id}`);
  found.push(...(await names(page, 'a notebook’s agents')));
  // The theme editor, on a copy of the theme.
  await open(page, '/settings/appearance');
  await page.getByRole('button', { name: /^Customize / }).click();
  await expect(page.getByTestId('custom-theme-editor')).toBeVisible();
  found.push(...(await names(page, 'theme editor')));

  // Enough was read: every page's title, Privacy's rows and limits, and labels this change cased.
  const all = new Set(found.map((each) => each.name));
  for (const name of [
    ...SETTINGS_PAGES.filter((each) => paths.includes(`/settings/${each.id}`)).map(
      (each) => each.label,
    ),
    'Share Usage Data',
    'Reset My Analytics ID',
    'Delete My Shared Data',
    'Show Log File',
    'Keep Events For',
    'Attach Logs from the Last',
    'Shortcut from Any App',
    'Search Shortcuts',
    'Variant to Edit',
    'Accent and States',
  ]) {
    expect(all, name).toContain(name);
  }
  expect(problems(found)).toEqual([]);

  // The proof: Privacy, with Advanced open.
  await open(page, '/settings/privacy');
  await page.getByTestId('privacy-advanced-summary').click();
  const usage = page.getByTestId('privacy-limits-usage');
  await usage.scrollIntoViewIfNeeded();
  await expect(usage).toBeInViewport();
  await holdForProof(page);
});
