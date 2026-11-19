import { titleCaseProblem } from '@penmoss/core/title-case';
import { BUILT_IN_THEMES } from '@penmoss/ui/theme';
import { SETTINGS_PAGES } from '../../src/pages/settings-index';
import { expect, seeded, test, type Page } from './fixtures';

// PEN-137 ac42 (A938 amended): every Settings section names its labels, legends, headings,
// switches, buttons, tabs and status chips in Title Case. Each page is opened (a notebook's own
// page, its agents and the theme editor too), every control and heading is read by its
// accessible name, and each name is held to the core rule (`@penmoss/core/title-case`). Hints
// and sentences are not read. The proof ends on Agents, at Receive Comments Sent to Claude Code
// Sessions.

// The stand-in Mac with every section: Semantic Search and the compact title bar too.
test.use({ meaning: true, macWindow: true });

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
  // "Change the Shortcut for Bold, ⌘B": the action, and the command's title (its own row label).
  const shortcut =
    /^(Add Shortcut for|Change the Shortcut for|Remove the Shortcut for|Reset the Shortcut for) (.+?)(?:, [^,]*)?$/.exec(
      name,
    );
  if (shortcut) return [`${shortcut[1]} X`, shortcut[2]!];
  // A symbol's grip and remove name it as the person did ("! Follow-up").
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
      elements.map((element) => [element.tagName.toLowerCase(), element.textContent ?? '']),
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

/** A page of Settings, once its title is there and its rows have settled. */
async function open(page: Page, path: string): Promise<void> {
  await page.goto(path);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  // The Mac's answers (the CLI's state, the model, the agent copies) arrive a moment later.
  await page.waitForLoadState('networkidle');
}

test('every Settings section names its controls in Title Case', async ({ page, notebook }) => {
  test.setTimeout(180_000);
  const found: Name[] = [];
  // Every section this Mac shows, as its nav lists them.
  await open(page, '/settings');
  const paths = await page
    .getByRole('navigation', { name: 'Settings Sections' })
    .getByRole('link')
    .evaluateAll((links) =>
      links
        .map((link) => link.getAttribute('href') ?? '')
        .filter((href) => /^\/settings\/[a-z-]+$/.test(href)),
    );
  expect(paths.length).toBeGreaterThanOrEqual(13);
  for (const path of paths) {
    await open(page, path);
    found.push(...(await names(page, path.slice('/settings/'.length))));
  }
  // A notebook's own page, each of its tabs, and its agents unfolded.
  const id = seeded(notebook).info.notebookId;
  await open(page, `/settings/git-notebooks/${id}`);
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

  // Enough was read: every page's title, and the labels this change cased.
  const all = new Set(found.map((each) => each.name));
  for (const name of [
    ...SETTINGS_PAGES.filter((each) => paths.includes(`/settings/${each.id}`)).map(
      (each) => each.label,
    ),
    'Receive Comments Sent to Claude Code Sessions',
    'Shortcut from Any App',
    'Search Shortcuts',
    'Page Background, Hex',
    'Variant to Edit',
    'Accent and States',
  ]) {
    expect(all, name).toContain(name);
  }
  expect(problems(found)).toEqual([]);

  // The proof: Agents, at the switch whose name was the longest to case.
  await open(page, '/settings/agents');
  const channel = page.getByRole('switch', {
    name: 'Receive Comments Sent to Claude Code Sessions',
  });
  await channel.scrollIntoViewIfNeeded();
  await expect(channel).toBeInViewport();
  await page.waitForTimeout(2000);
});
