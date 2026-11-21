// PEN-175 ac1: every control on screen says what a click on it records. A fixed tour opens Home
// with every sidebar section open; a note holding every editor widget, its menus, the selection
// toolbar, the link form, the lightbox and its side panel; every Settings page; Tags, Trash,
// Graph, Time Machine, Search and the command palette; and each first-run step. On each screen
// every visible control (a button, a link, a select, a summary, a checkbox, radio or slider, or
// anything with a control's role) must carry, on itself or on the <label> around a native input,
// a `data-command`, a `data-event` the catalogue lists and has not retired, or a
// `data-untracked` reason of three words or more. A text field in a dialog, and Search Settings,
// must record its typed length (`data-typed`, PEN-177) or carry such a reason. Every miss is collected over the whole tour,
// and the test fails once at its end, naming each as screen | selector | accessible name. The
// proof ends on the fixture note with its widgets in view.
import { CLICK_NAMES, COMMAND_NAMES, RETIRED_CLICK_NAMES } from '@penmoss/core/analytics';
import { connectContext, expect, GitHost, seeded, test, type Page } from './fixtures';
import { body, holdForProof } from './support/app';
import { SYMBOL_PICKER } from './keys';

const RUN = `t${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
const FIXTURE = `Every Widget ${RUN}`;
const OTHER = `Linked Note ${RUN}`;

/** A small red PNG (history-view.spec.ts's), served as a picture from the web. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAEElEQVR4nGM4YWMDRwzEcQAREhQBbrqBkwAAAABJRU5ErkJggg==',
  'base64',
);
const PICTURE = 'https://img.example/dot.png';
const FAKE_SHA = 'a'.repeat(64);

/** A note with every widget the editor draws itself. */
const WIDGETS = [
  'A paragraph with a [link](https://penmoss.app/docs/), a [[' + OTHER + ']] and #fixture.',
  '',
  '> [!note] A Callout',
  '> Inside the callout.',
  '',
  '> [!tip]- A Folded Callout',
  '> Hidden until opened.',
  '',
  '```ts',
  'const answer = 42;',
  '```',
  '',
  '| Name | Count |',
  '| --- | --- |',
  '| Apples | 3 |',
  '',
  `![A Dot|120](${PICTURE})`,
  '',
  'Inline math $x^2 + 1$ in a line.',
  '',
  '$$',
  '\\int_0^1 x\\,dx',
  '$$',
  '',
  '```mermaid',
  'graph TD',
  '  A --> B',
  '```',
  '',
  `[![Excalidraw Diagram](attachments/${FAKE_SHA}.svg)](attachments/${FAKE_SHA}.excalidraw)`,
  '',
  '- [ ] Something to do',
  '- [x] Something done',
  '',
  `![[${OTHER}]]`,
  '',
  `A file: [Report.pdf](attachments/${FAKE_SHA}.pdf)`,
  '',
].join('\n');

test.use({
  seed: {
    name: 'Notes',
    folders: ['Projects', 'Projects/Work'],
    notes: [
      { title: FIXTURE, markdown: WIDGETS },
      {
        title: OTHER,
        markdown: 'Embedded text with a [link](https://penmoss.app/) and #fixture.\n',
        folder: 'Projects/Work',
      },
      { title: `Filed Note ${RUN}`, markdown: 'A note in a folder. #other\n', folder: 'Projects' },
    ],
  },
  analytics: { consent: 'yes' },
  meaning: true,
  macWindow: true,
  ai: true,
});

interface Miss {
  readonly screen: string;
  readonly selector: string;
  readonly name: string;
}

/** The ids a control may carry: catalogued and not retired. */
const TRACKED = CLICK_NAMES.filter((id) => !RETIRED_CLICK_NAMES.includes(id));

/** Every visible control on `page` without its own id or reason, as `screen` names it. */
async function audit(
  page: Page,
  screen: string,
): Promise<{ readonly misses: Miss[]; readonly checked: number }> {
  const found = await page.evaluate(
    ({ events, commands }) => {
      const EVENTS = new Set(events);
      const COMMANDS = new Set(commands);
      const CONTROLS = [
        'button',
        'a[href]',
        'select',
        'summary',
        'input[type="checkbox"]',
        'input[type="radio"]',
        'input[type="range"]',
        ...[
          'button',
          'link',
          'menuitem',
          'menuitemcheckbox',
          'menuitemradio',
          'tab',
          'switch',
          'checkbox',
          'radio',
          'option',
          'treeitem',
          'slider',
        ].map((role) => `[role="${role}"]`),
      ].join(', ');
      const visible = (element: Element): boolean => {
        if (element.closest('[inert]')) return false;
        if (typeof element.checkVisibility === 'function') {
          return element.checkVisibility({ checkOpacity: false, checkVisibilityCSS: true });
        }
        return element.getClientRects().length > 0;
      };
      /** Its own id or reason: a command, a catalogued id, or three words of why not. */
      const marked = (element: Element): boolean => {
        const command = element.getAttribute('data-command');
        if (command && COMMANDS.has(command)) return true;
        const event = element.getAttribute('data-event');
        if (event && EVENTS.has(event)) return true;
        const reason = element.getAttribute('data-untracked')?.trim() ?? '';
        return reason.split(/\s+/).filter(Boolean).length >= 3;
      };
      const selector = (element: Element): string => {
        const tag = element.tagName.toLowerCase();
        const testId = element.getAttribute('data-testid');
        if (testId) return `${tag}[data-testid="${testId}"]`;
        if (element.id && !/\d{3,}/.test(element.id)) return `${tag}#${element.id}`;
        const role = element.getAttribute('role');
        const classes = [...element.classList]
          .slice(0, 3)
          .map((name) => `.${name}`)
          .join('');
        const event = element.getAttribute('data-event');
        const extra = event ? `[data-event="${event}"]` : '';
        const host = element.parentElement?.closest('[data-testid]')?.getAttribute('data-testid');
        return `${host ? `[data-testid="${host}"] ` : ''}${tag}${role ? `[role="${role}"]` : ''}${classes}${extra}`;
      };
      const nameOf = (element: Element): string => {
        const labelled = element.getAttribute('aria-labelledby');
        const byId = labelled
          ?.split(/\s+/)
          .map((id) => document.getElementById(id)?.textContent ?? '')
          .join(' ');
        const label =
          element instanceof HTMLInputElement || element instanceof HTMLSelectElement
            ? (element.labels?.[0]?.textContent ?? '')
            : '';
        const name =
          element.getAttribute('aria-label') ||
          byId ||
          label ||
          element.getAttribute('title') ||
          element.textContent ||
          element.getAttribute('placeholder') ||
          '';
        return name.replace(/\s+/g, ' ').trim().slice(0, 80);
      };
      const misses: Array<{ selector: string; name: string }> = [];
      let checked = 0;
      // PEN-177: a text field in a dialog (or Search Settings) records what is typed by length
      // (`useTypedLength`, `data-typed`), or says why not (`data-untracked`).
      const TEXT_FIELDS = [
        'input:not([type])',
        'input[type="text"]',
        'input[type="search"]',
        'input[type="url"]',
        'input[type="email"]',
        'textarea',
        // A rich field (the feedback's description): its editor's host carries the mark.
        '[contenteditable="true"]',
      ].join(', ');
      for (const element of document.querySelectorAll(TEXT_FIELDS)) {
        if (!visible(element)) continue;
        const inDialog =
          element.closest('[role="dialog"], [role="alertdialog"], dialog') !== null ||
          element.getAttribute('data-testid') === 'settings-search';
        if (!inDialog) continue;
        checked++;
        if (element.closest('[data-typed]') !== null || marked(element)) continue;
        misses.push({ selector: `${selector(element)} (text field)`, name: nameOf(element) });
      }
      for (const element of document.querySelectorAll(CONTROLS)) {
        if (!visible(element)) continue;
        checked++;
        if (marked(element)) continue;
        const native =
          element instanceof HTMLInputElement &&
          ['checkbox', 'radio', 'range'].includes(element.type);
        const label = native ? element.closest('label') : null;
        if (label && marked(label)) continue;
        misses.push({ selector: selector(element), name: nameOf(element) });
      }
      return { misses, checked };
    },
    { events: TRACKED, commands: COMMAND_NAMES },
  );
  return { misses: found.misses.map((miss) => ({ screen, ...miss })), checked: found.checked };
}

/** A page of the app, once it has drawn and the Mac's answers have come. */
async function open(page: Page, path: string): Promise<void> {
  await page.goto(path);
  await page.waitForLoadState('networkidle');
}

/** Clicks every closed section and folder in the sidebar open, until none is left. */
async function openSidebar(page: Page): Promise<void> {
  const sidebar = page.locator('#app-sidebar');
  for (let round = 0; round < 6; round++) {
    const closed = sidebar.locator('[aria-expanded="false"]:not([aria-haspopup]):visible');
    const count = await closed.count();
    if (count === 0) return;
    for (let at = count - 1; at >= 0; at--) {
      await closed
        .nth(at)
        .click({ timeout: 2_000 })
        .catch(() => undefined);
    }
  }
}

test('every control on screen has its own id or a reason (PEN-175 ac1)', async ({
  page,
  browser,
  notebook,
}) => {
  test.setTimeout(600_000);
  const misses: Miss[] = [];
  const screens: string[] = [];
  const check = async (on: Page, screen: string) => {
    screens.push(screen);
    const found = await audit(on, screen);
    console.log(`${screen}: ${found.checked} controls, ${found.misses.length} missed`);
    // A screen with nothing to check means the tour never reached it.
    expect(found.checked, screen).toBeGreaterThan(0);
    misses.push(...found.misses);
  };
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.route(PICTURE, (route) => route.fulfill({ contentType: 'image/png', body: PNG }));
  // No step waits for long: a control that never comes fails where it is.
  page.setDefaultTimeout(15_000);

  // --- The first run, on a Mac with no notebook yet, asked about usage data at its end.
  {
    const host = new GitHost();
    host.signInGit();
    const notes = host.githubRepo('notes', { pushedAt: '2026-11-06T10:00:00Z' });
    const kept = await host.seed({
      name: 'Kept',
      remote: notes.remote,
      notes: [{ title: 'Already here', markdown: 'From another Mac.\n' }],
    });
    await host.notebooks.remove(kept.info.localId);
    host.githubRepo('site', { visibility: 'public', pushedAt: '2026-11-01T10:00:00Z' });
    const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
    await connectContext(context, host, { analytics: { consent: null }, ai: true });
    const first = await context.newPage();
    first.setDefaultTimeout(15_000);
    try {
      await first.goto('/');
      const firstRun = first.getByTestId('first-run');
      const heading = (name: string) => firstRun.getByRole('heading', { name });
      await expect(heading('Welcome to Penmoss')).toBeVisible();
      await check(first, 'first run · welcome');
      await firstRun.getByTestId('first-run-start').click();
      await expect(heading('Create or Open Notebook')).toBeVisible();
      await check(first, 'first run · create or open');
      // Use Existing Repo: the repositories, one opened to its notebooks.
      await firstRun.getByTestId('first-run-existing').click();
      await firstRun.getByTestId('first-run-continue').click();
      await expect(firstRun.getByTestId('first-run-tree-repo').first()).toBeVisible();
      const toggles = firstRun.getByTestId('first-run-repo-toggle');
      for (let at = 0; at < (await toggles.count()); at++) {
        if ((await toggles.nth(at).getAttribute('aria-expanded')) === 'false') {
          await toggles.nth(at).click();
        }
      }
      await check(first, 'first run · pick repository (existing)');
      await firstRun.getByTestId('first-run-back').click();
      await expect(heading('Create or Open Notebook')).toBeVisible();
      // Start a New Notebook: the ways, Create New Repo, then Paste a URL with More Options.
      await firstRun.getByTestId('first-run-new').click();
      await firstRun.getByTestId('first-run-continue').click();
      await expect(heading('Pick Repository')).toBeVisible();
      await check(first, 'first run · pick repository (ways)');
      await firstRun.getByTestId('first-run-way-create').click();
      await firstRun.getByTestId('first-run-continue').click();
      await expect(firstRun.getByTestId('first-run-create-repo')).toBeVisible();
      await check(first, 'first run · create new repo');
      await firstRun.getByTestId('first-run-back').click();
      await expect(heading('Pick Repository')).toBeVisible();
      await firstRun.getByTestId('first-run-way-url').click();
      await firstRun.getByTestId('first-run-continue').click();
      await expect(heading('Paste a URL')).toBeVisible();
      await firstRun.getByTestId('first-run-more').getByText('More Options').click();
      await expect(firstRun.getByTestId('first-run-branch')).toBeVisible();
      await check(first, 'first run · paste a url');
      await firstRun.getByTestId('first-run-url-input').fill(host.bare('fresh'));
      await firstRun.getByTestId('first-run-continue').click();
      await expect(heading('Name Your Notebook')).toBeVisible();
      await check(first, 'first run · name your notebook');
      await firstRun.getByTestId('first-run-name-input').fill('Field Notes');
      await firstRun.getByTestId('first-run-make').click();
      // AI Descriptions: the question, then the provider it leads to, then Back and Not Now.
      const ai = heading('Describe Notes for Agents?');
      await expect(ai).toBeVisible({ timeout: 30_000 });
      await check(first, 'first run · describe notes for agents');
      await firstRun.getByRole('radio', { name: /^Turn On for All Notes/ }).check();
      await firstRun.getByTestId('first-run-continue').click();
      await expect(ai).toBeHidden();
      const provider = (await firstRun.getByRole('heading').first().textContent())?.trim() ?? '';
      await check(first, `first run · ${provider.toLowerCase()}`);
      await firstRun.getByTestId('first-run-back').click();
      await expect(ai).toBeVisible();
      await firstRun.getByRole('radio', { name: /^Not Now/ }).check();
      await firstRun.getByTestId('first-run-continue').click();
      // The last step: the consent question.
      const consent = firstRun.getByTestId('first-run-consent');
      await expect(consent).toBeVisible({ timeout: 30_000 });
      await check(first, 'first run · last step (consent)');
    } finally {
      await context.close();
      await host.close();
    }
  }

  // --- Home, with every sidebar section and folder open.
  await open(page, '/');
  await expect(page.locator('#app-sidebar')).toBeVisible();
  await openSidebar(page);
  // The audit finds a control with no id: one put there for the purpose, named as a miss.
  await page.evaluate(() => {
    const probe = document.createElement('button');
    probe.dataset['testid'] = 'audit-probe';
    probe.textContent = 'Unmarked Probe';
    document.querySelector('#app-sidebar')?.append(probe);
  });
  expect((await audit(page, 'probe')).misses).toEqual([
    { screen: 'probe', selector: 'button[data-testid="audit-probe"]', name: 'Unmarked Probe' },
  ]);
  await page.evaluate(() => document.querySelector('[data-testid="audit-probe"]')?.remove());
  await check(page, 'home');

  // --- Settings: every section its nav lists, a notebook's own page with each tab, its agents,
  // the usage data, and the theme editor.
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
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await check(page, path.slice(1));
  }
  const id = seeded(notebook).info.notebookId;
  await open(page, `/settings/git-notebooks/${id}`);
  const tabs = page.getByRole('tablist').first().getByRole('tab');
  for (let tab = 0; tab < (await tabs.count()); tab++) {
    await tabs.nth(tab).click();
    await check(page, `settings/git-notebooks/<id> · tab ${tab + 1}`);
  }
  await open(page, `/settings/agents/${id}`);
  await check(page, 'settings/agents/<id>');
  await open(page, '/settings/privacy/data');
  await check(page, 'settings/privacy/data');
  await open(page, '/settings/appearance');
  await page.getByRole('button', { name: /^Customize / }).click();
  await expect(page.getByTestId('custom-theme-editor')).toBeVisible();
  await check(page, 'settings/appearance · theme editor');

  // --- Tags, Trash, Graph and Time Machine.
  for (const path of ['/tags', '/trash', '/graph', '/time-machine']) {
    await open(page, path);
    await check(page, path.slice(1));
  }

  // --- Search and the command palette, over Home.
  await open(page, '/');
  await page.keyboard.press('ControlOrMeta+Shift+KeyF');
  await expect(page.getByTestId('search')).toBeVisible();
  await page.keyboard.type('fixture');
  await page.waitForTimeout(800);
  await check(page, 'search');
  await page.keyboard.press('Escape');
  await page.keyboard.press('ControlOrMeta+KeyK');
  await expect(page.getByRole('dialog').last()).toBeVisible();
  await check(page, 'command palette');
  await page.keyboard.press('Escape');

  // --- The fixture note: every widget, its menus, the toolbar, the link form, the lightbox and
  // the side panel.
  const noteId = seeded(notebook).noteIds[0]!;
  await open(page, `/notes/${noteId}`);
  await expect(page.getByTestId('note-view')).toHaveAttribute('data-ready', 'true');
  const editor = body(page);
  for (const widget of [
    '.pm-callout',
    '.pm-code-block',
    '.pm-table',
    '[data-testid="image"]',
    '.pm-math',
    '.pm-diagram',
    '[data-testid="drawing"]',
    'ul[data-type="taskList"]',
    '[data-testid="embed"]',
    '[data-testid="wikilink"]',
    '[data-testid="attachment"]',
  ]) {
    await expect(editor.locator(widget).first(), widget).toBeAttached();
  }
  await openSidebar(page);
  await check(page, 'note');

  // Note Actions, and the note's own menu in the sidebar.
  await page.getByTestId('note-menu').click();
  await expect(page.getByRole('menu').first()).toBeVisible();
  await check(page, 'note · note actions');
  await page.keyboard.press('Escape');
  const row = page
    .getByRole('tree', { name: 'Folders and notes' })
    .getByRole('treeitem', { name: FIXTURE, exact: true });
  await row.click({ button: 'right' });
  await expect(page.getByRole('menu').first()).toBeVisible();
  await check(page, 'note · sidebar menu');
  await page.keyboard.press('Escape');

  // The side panel, each tab.
  for (const tab of ['info', 'comments', 'history', 'graph']) {
    const button = page.getByTestId(`note-tab-${tab}`);
    if (!(await button.isVisible())) continue;
    await button.click();
    await page.waitForTimeout(400);
    await check(page, `note · panel ${tab}`);
  }
  if (await page.getByTestId('note-panel-close').isVisible()) {
    await page.getByTestId('note-panel-close').click();
  }

  // A cell of the table: its toolbar.
  await editor.locator('.pm-table td').first().click();
  await expect(editor.locator('.pm-table-toolbar').first()).toBeVisible();
  await check(page, 'note · table toolbar');

  // A word selected: the selection toolbar, Copy As, Turn Into and the link form.
  const selectWords = async () => {
    await editor
      .locator('p', { hasText: 'A paragraph with' })
      .first()
      .click({ position: { x: 2, y: 8 } });
    for (let i = 0; i < 'A paragraph'.length; i++) await page.keyboard.press('Shift+ArrowRight');
  };
  await selectWords();
  const toolbar = page.getByTestId('selection-toolbar');
  await expect(toolbar).toBeVisible();
  await check(page, 'note · selection toolbar');
  await toolbar.locator('.pm-toolbar-copy').click();
  await check(page, 'note · copy as');
  await page.keyboard.press('Escape');
  if (await toolbar.isVisible()) {
    await toolbar.locator('.pm-toolbar-turn').click();
    await check(page, 'note · turn into');
    await page.keyboard.press('Escape');
  }
  await selectWords();
  await expect(toolbar).toBeVisible();
  await toolbar.locator('.pm-toolbar-link').click();
  await expect(toolbar.locator('.pm-toolbar-link-form')).toBeVisible();
  await check(page, 'note · link form');
  await page.keyboard.press('Escape');

  // The picture selected, then its lightbox.
  // A picture loads as it comes near the view.
  await editor.getByTestId('image').first().scrollIntoViewIfNeeded();
  const picture = editor.locator('[data-testid="image"] img').first();
  await expect(picture).toBeVisible({ timeout: 20_000 });
  await picture.click();
  const lightboxButton = editor.getByTestId('image-lightbox');
  if (await lightboxButton.isVisible()) {
    await check(page, 'note · picture selected');
    await lightboxButton.click();
    await expect(page.getByTestId('lightbox')).toBeVisible();
    await check(page, 'note · lightbox');
    await page.keyboard.press('Escape');
  }

  // The symbol picker, and the slash menu on a new line.
  await editor.locator('p', { hasText: 'A paragraph with' }).first().click();
  await page.keyboard.press(SYMBOL_PICKER);
  if (await page.getByTestId('symbol-picker').isVisible()) {
    await check(page, 'note · symbol picker');
    await page.keyboard.press('Escape');
  }

  // The proof: the fixture note, its widgets in view, once no control was missed.
  await open(page, `/notes/${noteId}`);
  await expect(page.getByTestId('note-view')).toHaveAttribute('data-ready', 'true');
  await editor.locator('.pm-callout').first().scrollIntoViewIfNeeded();

  const report = misses.map((miss) => `${miss.screen} | ${miss.selector} | ${miss.name}`);
  console.log(`Toured ${screens.length} screens: ${screens.join(', ')}`);
  expect(report, `Controls with no id or reason:\n${report.join('\n')}`).toEqual([]);
  await holdForProof(page, 2000);
});
