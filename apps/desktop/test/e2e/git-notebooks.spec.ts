import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { httpHost } from '../../../../packages/git-notebook/test/support/git';
import { FakeGitHubBrowse } from '../../../../packages/git-notebook/test/support/fake-github-browse';
import {
  answerChecks,
  body,
  capturePage,
  checksAsked,
  dataDir,
  firstRunName,
  firstRunPasteUrl,
  gitNotebook,
  launch,
  mainBounds,
  removeDataDirs,
  runInMainPage,
  ULID,
  type Launched,
} from './support';

// T50 G3–G6 (#151–#154; A850–A869) in the Mac app: git notebooks, synced by this Mac's own git
// through the main process (T59: the only kind). Bare repositories on this machine stand in for
// GitHub, over `file://` and over HTTP as a host serves them (`git http-backend`). GitHub cannot
// be asked about them, so they sync without a check and nobody is asked (D51). The CLI is the
// other device. Nothing of a git notebook
// leaves the app's windows: every request and socket frame they send outside `app://` is checked
// for its ids and words.

const RUN = `g${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
const WINDOW = /^app:\/\/penmoss\/window\/notes\/[0-9A-HJKMNP-TV-Z]{26}$/;
const mac = process.platform === 'darwin';
const NEW_NOTE = mac ? 'Meta+Alt+KeyN' : 'Alt+KeyN';
// The end of the note: ⌘↓ on a Mac, where ⌃End only scrolls (as the web suite's keys.ts).
const DOC_END = mac ? 'Meta+ArrowDown' : 'Control+End';
const opened: Launched[] = [];

let cliDir: string;
let cliBundle: string;

test.beforeAll(() => {
  cliDir = mkdtempSync(join(tmpdir(), 'penmoss-git-cli-'));
  cliBundle = join(cliDir, 'penmoss.js');
  const build = fileURLToPath(new URL('../../../../packages/cli/build.js', import.meta.url));
  execFileSync(process.execPath, [build, cliDir]);
});

const hosts: Array<{ close(): Promise<void> }> = [];

test.afterEach(async () => {
  for (const { app } of opened.splice(0)) await app.close().catch(() => undefined);
  for (const host of hosts.splice(0)) await host.close();
});
test.afterAll(() => {
  removeDataDirs();
  rmSync(cliDir, { recursive: true, force: true });
});

/** A bare repository on this machine, and a git config naming the committer. */
function world() {
  const root = dataDir();
  const remote = join(root, 'notes.git');
  execFileSync('git', ['init', '--bare', '--quiet', '--initial-branch=main', remote]);
  const config = join(root, 'gitconfig');
  writeFileSync(
    config,
    [
      '[user]',
      '  name = Ryan on the Mac',
      '  email = ryan@example.invalid',
      '[commit]',
      '  gpgSign = false',
      '',
    ].join('\n'),
  );
  const home = join(root, 'cli-home');
  const env = {
    ...process.env,
    PENMOSS_HOME: home,
    GIT_CONFIG_GLOBAL: config,
    GIT_CONFIG_NOSYSTEM: '1',
  };
  /** The CLI as another device on the same repository. */
  const cli = (args: readonly string[]) =>
    execFileSync(process.execPath, [cliBundle, ...args], {
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 60_000,
    });
  /** The rendered markdown files on the branch, as the repository has them. */
  const files = () =>
    execFileSync('git', ['-C', remote, 'ls-tree', '-r', '--name-only', 'main'], {
      encoding: 'utf8',
    })
      .split('\n')
      .filter(Boolean);
  const show = (path: string) =>
    execFileSync('git', ['-C', remote, 'show', `main:${path}`], { encoding: 'utf8' });
  return { root, remote, config, cli, files, show };
}

async function start(config: string): Promise<Launched> {
  const launched = await launch({ env: { PENMOSS_TEST_GIT_CONFIG: config } });
  opened.push(launched);
  await mainBounds(launched.app, { x: 0, y: 0, width: 1200, height: 800 });
  return launched;
}

/** Chooses a menu item, once the page has put it in the menu (and it can be chosen). */
async function chooseMenu(app: ElectronApplication, id: string) {
  await expect
    .poll(() =>
      app.evaluate(
        ({ Menu }, itemId) => Menu.getApplicationMenu()?.getMenuItemById(itemId)?.enabled ?? null,
        id,
      ),
    )
    .toBe(true);
  await app.evaluate(({ Menu }, itemId) => {
    (Menu.getApplicationMenu()?.getMenuItemById(itemId) as unknown as { click(): void }).click();
  }, id);
}

/** Closes the note window as ⌘W or its close button does: main asks it to store first (T29). */
async function closeNoteWindow(app: ElectronApplication, window: Page) {
  await Promise.all([
    window.waitForEvent('close'),
    app.evaluate(() => {
      const [note] = (
        globalThis as unknown as { penmossDesktop: { noteWindows(): Electron.BrowserWindow[] } }
      ).penmossDesktop.noteWindows();
      note!.close();
    }),
  ]);
}

/** The main window in front again, as macOS tells it (xvfb has no window manager). */
async function focusMain(app: ElectronApplication) {
  await app.evaluate(() => {
    (
      globalThis as unknown as { penmossDesktop: { mainWindow(): Electron.BrowserWindow } }
    ).penmossDesktop
      .mainWindow()
      .emit('focus');
  });
}

/** Every request and socket frame a window sends anywhere but the app itself, as text. */
function recordOutsideTraffic(page: Page, into: string[]): void {
  page.on('request', (request) => {
    if (/^(app|blob|data):/.test(request.url())) return;
    into.push(`${request.method()} ${request.url()} ${request.postData() ?? ''}`);
  });
  page.on('websocket', (socket) => {
    into.push(`WS ${socket.url()}`);
    socket.on('framesent', (frame) => {
      const payload = frame.payload;
      into.push(typeof payload === 'string' ? payload : payload.toString('latin1'));
    });
  });
}

/** Adds a git notebook in Settings → Git notebooks; returns its card. */
async function addNotebook(page: Page, input: { remote: string; name?: string }) {
  // The first notebook is added on the first run (T59, A1030; firstRunPasteUrl); later ones in
  // Settings, whose form opens from Add a Git Notebook… under the list (A1098).
  const settings = page.getByTestId('git-notebooks-settings');
  await expect(settings).toBeVisible();
  await settings.getByTestId('git-add-open').click();
  const form = settings.getByTestId('git-add');
  await form.getByTestId('git-add-remote').fill(input.remote);
  if (input.name) await form.getByTestId('git-add-name').fill(input.name);
  await form.locator('button[type="submit"]').click();
  return settings;
}

async function newNote(page: Page, title: string, text: string): Promise<string> {
  const before = page.url();
  await page.keyboard.press(NEW_NOTE);
  await expect(page).not.toHaveURL(before);
  await expect(page).toHaveURL(ULID);
  await expect(page.getByTestId('note-title')).toBeFocused();
  await page.keyboard.type(title);
  await page.keyboard.press('Enter');
  await page.keyboard.type(text);
  await expect(body(page)).toContainText(text);
  return ULID.exec(new URL(page.url()).pathname)![1]!;
}

const section = (page: Page, name: string) =>
  page.getByTestId('source-section').filter({
    has: page.locator('.sb-section-name', { hasText: name }),
  });

/** The notebook's own page in Settings, from Notebooks' list (A1098). */
async function notebookPage(page: Page, name: string) {
  await go(page, '/settings/git-notebooks');
  await page.getByTestId('git-notebook-row').filter({ hasText: name }).click();
  return page.getByTestId('git-notebook').filter({ hasText: name });
}

/** Sync now from the notebook's Settings page, then waits for "Synced" with nothing waiting. */
async function syncNow(page: Page, name: string) {
  const card = await notebookPage(page, name);
  await card.getByTestId('git-sync-now').click();
  await expect(card.getByTestId('git-status')).toHaveAttribute('data-phase', 'synced', {
    timeout: 30_000,
  });
  await expect(card.getByTestId('git-status')).not.toContainText('waiting');
  return card;
}

/** How many git notebooks main keeps. */
const gitNotebookCount = (app: ElectronApplication) =>
  app.evaluate(async () =>
    (
      globalThis as unknown as { penmossDesktop: { gitNotebooks(): Promise<unknown[]> } }
    ).penmossDesktop
      .gitNotebooks()
      .then((list) => list.length),
  );

/** Goes to a path inside the app, as a link does (no reload). */
const go = (page: Page, path: string) =>
  page.evaluate((to) => {
    window.history.pushState(null, '', to);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, path);

test('a notebook made on the Mac, notes and the Journal in it, synced on quit, nothing leaving the app', async () => {
  const w = world();
  const launched = await start(w.config);
  const { app, page, errors } = launched;
  const traffic: string[] = [];
  recordOutsideTraffic(page, traffic);

  // The first run's Paste a URL (T59, A1030; First Run C): GitHub cannot be asked about a
  // repository on this machine, so it syncs without a check and nobody is asked (D51); it holds
  // no notebook yet, so Name Your Notebook. Then the app opens on the notebook.
  await firstRunPasteUrl(page, `file://${w.remote}`);
  const name = `Mac notes ${RUN}`;
  await firstRunName(page, name);
  await expect(section(page, name)).toBeVisible({ timeout: 30_000 });
  await chooseMenu(app, 'app.gitNotebooks');
  await expect(page).toHaveURL('app://penmoss/settings/git-notebooks');
  const settings = page.getByTestId('git-notebooks-settings');
  expect(checksAsked(launched)).toEqual([]);
  await settings.getByTestId('git-notebook-row').filter({ hasText: name }).click();
  const card = settings.getByTestId('git-notebook').filter({ hasText: name });
  await expect(card.getByTestId('git-status')).toHaveAttribute('data-phase', 'synced', {
    timeout: 30_000,
  });
  // No privacy line of any kind (D61).
  await expect(card.getByTestId('git-privacy')).toHaveCount(0);
  await expect(card.getByTestId('git-confirm-private')).toHaveCount(0);
  const notebookId = (await card.getAttribute('data-notebook-id'))!;
  expect(w.files()).toContain('.penmoss/notebook.json');

  // The app is the notebook's (A828, T59): no sign-in banner, no personal section.
  await chooseMenu(app, 'app.home');
  await expect(section(page, name)).toBeVisible();
  await expect(page.locator('[data-testid="source-section"][data-source="personal"]')).toHaveCount(
    0,
  );
  await expect(page.getByTestId('sign-in-banner')).toHaveCount(0);

  // The CLI, another device, joins; the notebook's daily template is set there (A827).
  w.cli(['notebook', 'add', `file://${w.remote}`, '--name', 'nb']);
  w.cli(['settings', 'template.daily', `## Plan for the day ${RUN}`, '--notebook', 'nb']);
  await syncNow(page, name);

  // A note from the Mac, pushed after Sync now.
  await go(page, '/');
  const title = `Plan ${RUN}`;
  const noteId = await newNote(page, title, `Secret words ${RUN}`);
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', /syncing|synced/);

  // Today's note made on both while apart: the same note, with the template once (A820).
  const cliDaily = JSON.parse(w.cli(['daily', '--notebook', 'nb', '--no-sync', '--json'])) as {
    id: string;
  };
  await chooseMenu(app, 'journal.today');
  await expect(page).not.toHaveURL(new RegExp(noteId));
  await expect(page).toHaveURL(ULID);
  const dailyId = ULID.exec(new URL(page.url()).pathname)![1]!;
  expect(dailyId).toBe(cliDaily.id);
  await syncNow(page, name);
  w.cli(['notebook', 'sync', 'nb']);
  await syncNow(page, name);
  await expect.poll(() => w.files().some((path) => path.endsWith(`${title}.md`))).toBe(true);
  expect(w.show(w.files().find((path) => path.endsWith(`${title}.md`))!)).toContain(
    `Secret words ${RUN}`,
  );
  const dailies = w.files().filter((path) => path.startsWith('Journal/') && path.endsWith('.md'));
  expect(dailies).toHaveLength(1);
  expect(w.show(dailies[0]!).split(`## Plan for the day ${RUN}`)).toHaveLength(2);

  // A note from the CLI reaches the Mac, in the notebook's section.
  const fromCli = JSON.parse(
    w.cli([
      'new',
      `From the CLI ${RUN}`,
      '--text',
      'typed elsewhere',
      '--notebook',
      'nb',
      '--json',
    ]),
  ) as { id: string };
  await syncNow(page, name);
  await chooseMenu(app, 'app.home');
  const cliLink = section(page, name).getByRole('link', { name: `From the CLI ${RUN}` });
  await expect(cliLink).toBeVisible();

  // An agent's clone (the CLI with --agent) makes a folder; the notebook's Agent activity lists
  // it from the branch, and Undo is the Mac's own change, pushed, which the CLI reads (#172, A920).
  w.cli(['notebook', 'add', `file://${w.remote}`, '--name', 'agent', '--agent', 'Claude Code']);
  const agentFolder = `Agent folder ${RUN}`;
  w.cli(['mkdir', agentFolder, '--notebook', 'agent']);
  const synced = await syncNow(page, name);
  await synced.getByTestId('git-agent-activity-open').click();
  const activity = synced.getByTestId('git-agent-activity');
  const made = activity
    .getByRole('listitem')
    .filter({ hasText: `Made the folder “${agentFolder}”` });
  await expect(made).toContainText('✦ Claude Code');
  await made.getByRole('button', { name: 'Undo' }).click();
  await expect(activity.getByTestId('agent-activity-status')).toHaveText(
    `Undone: Made the folder “${agentFolder}”.`,
  );
  await expect(made).toContainText('Undone by Penmoss for Mac');
  await expect
    .poll(async () => {
      await syncNow(page, name);
      return w.cli(['ls', '--notebook', 'nb']);
    })
    .not.toContain(agentFolder);

  // Settings' actions from the menus and the palette (#170 F5): File → Set this git notebook's
  // commit name and email… takes the person to it; its own identity is used from the next
  // commit (#170 F6), and File → Sync this git notebook now pushes it.
  await chooseMenu(app, 'app.home');
  const ownCard = page.getByTestId('git-notebook').filter({ hasText: name });
  await chooseMenu(app, 'git.identity');
  await expect(ownCard.getByTestId('git-author-email')).toBeFocused();
  await ownCard.getByTestId('git-author-name').fill('Ryan');
  await ownCard.getByTestId('git-author-email').fill('1234+ryan@users.noreply.github.com');
  await ownCard.getByTestId('git-author').getByRole('button', { name: 'Save' }).click();
  await expect(ownCard.getByTestId('git-author-now')).toContainText(
    'Commits as Ryan <1234+ryan@users.noreply.github.com>, this notebook’s own.',
  );
  await chooseMenu(app, 'app.home');
  await section(page, name).getByTestId('tree-root-drop').click();
  await newNote(page, `Own identity ${RUN}`, 'Committed as the notebook’s own.');
  await expect
    .poll(
      async () => {
        await chooseMenu(app, 'git.syncNow');
        await page.waitForTimeout(500);
        return execFileSync('git', ['-C', w.remote, 'log', '-1', '--format=%an <%ae>', 'main'], {
          encoding: 'utf8',
        }).trim();
      },
      { timeout: 30_000 },
    )
    .toBe('Ryan <1234+ryan@users.noreply.github.com>');
  await page.keyboard.press('ControlOrMeta+KeyK');
  const palette = page.getByRole('dialog', { name: 'Command Palette' });
  await palette.getByRole('combobox', { name: 'Command Palette' }).fill('remove this git');
  await expect(palette.getByRole('option').first()).toContainText(
    'Remove This Git Notebook from This Mac…',
  );
  await page.keyboard.press('Enter');
  // Taken to the button, which still says what would be lost and asks for Touch ID.
  await expect(ownCard.getByTestId('git-remove')).toBeFocused();
  expect(await gitNotebookCount(app)).toBe(1);

  // A git notebook is one notebook (T39 pass 3 review, A912): its folders offer no Turn into
  // notebook, and its section no Open or Close Notebooks (on the sidebar's top row since T53
  // item 5).
  w.cli(['mkdir', `Ideas ${RUN}`, '--notebook', 'nb']);
  await syncNow(page, name);
  await chooseMenu(app, 'app.home');
  await section(page, name)
    .getByRole('treeitem', { name: `Ideas ${RUN}`, exact: true })
    .click({ button: 'right' });
  const folderMenu = page.getByRole('menu', { name: `Folder Ideas ${RUN}` });
  await expect(folderMenu.getByRole('menuitem', { name: 'Rename' })).toBeVisible();
  await expect(folderMenu.getByRole('menuitem', { name: 'Turn into Notebook' })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(section(page, name).locator('[data-command="notebook.manage"]')).toHaveCount(0);

  // Move to Trash, then Undo, from the note: the notebook's own trash both ways (A826), with no
  // account to send it to anyway.
  await cliLink.click();
  await expect(page).toHaveURL(new RegExp(`/notes/${fromCli.id}$`));
  await expect(page.getByTestId('note-view')).toHaveAttribute('data-ready', 'true');
  await chooseMenu(app, 'note.delete');
  const toast = page.getByTestId('trashed-toast');
  await expect(toast).toContainText(`Moved “From the CLI ${RUN}” to Trash`);
  await expect(cliLink).toHaveCount(0);
  await toast.getByTestId('trashed-undo').click();
  await expect(page).toHaveURL(new RegExp(`/notes/${fromCli.id}$`));
  await expect(body(page)).toContainText('typed elsewhere');
  await expect(toast).toBeHidden();
  await expect(cliLink).toBeVisible();

  // A second notebook: Move to Trash from its section while the first one's note is open, then
  // Undo, brings the note back in its own notebook, not in the one whose note is open.
  const otherRemote = join(w.root, 'other.git');
  execFileSync('git', ['init', '--bare', '--quiet', '--initial-branch=main', otherRemote]);
  const otherName = `Other ${RUN}`;
  await go(page, '/settings/git-notebooks');
  await addNotebook(page, { remote: `file://${otherRemote}`, name: otherName });
  await expect(settings.getByTestId('git-add-message')).toContainText(
    `Made the notebook “${otherName}”`,
  );
  await chooseMenu(app, 'app.home');
  const other = section(page, otherName);
  await other.getByTestId('tree-root-drop').click();
  const otherNote = await newNote(page, `Elsewhere ${RUN}`, 'in the other notebook');
  await expect(other.locator(`a[href="/notes/${otherNote}"]`)).toBeVisible();
  await cliLink.click();
  await expect(page).toHaveURL(new RegExp(`/notes/${fromCli.id}$`));
  await expect(page.getByTestId('note-view')).toHaveAttribute('data-ready', 'true');
  await other.getByRole('treeitem', { name: `Elsewhere ${RUN}`, exact: true }).click({
    button: 'right',
  });
  await page
    .getByRole('menu', { name: `“Elsewhere ${RUN}”` })
    .getByRole('menuitem', { name: 'Move to Trash' })
    .click();
  await expect(toast).toContainText(`Moved “Elsewhere ${RUN}” to Trash`);
  await expect(other.locator(`a[href="/notes/${otherNote}"]`)).toHaveCount(0);
  await toast.getByTestId('trashed-undo').click();
  await expect(toast).toBeHidden();
  await expect(other.locator(`a[href="/notes/${otherNote}"]`)).toBeVisible();
  await expect(section(page, name).locator(`a[href="/notes/${otherNote}"]`)).toHaveCount(0);
  // Undo opens the note it brought back (A524).
  await expect(page).toHaveURL(new RegExp(`/notes/${otherNote}$`));
  await expect(body(page)).toContainText('in the other notebook');

  // A setting changed here is kept in the Journal notebook (A827).
  await chooseMenu(app, 'theme.toggleDark');
  await expect(page.locator('html')).toHaveAttribute('data-mode', 'dark');

  // An edit just before quitting is pushed by the closing sync (A825), not lost to the delay.
  await go(page, `/notes/${noteId}`);
  await expect(page.getByTestId('note-view')).toHaveAttribute('data-ready', 'true');
  await body(page).click();
  await page.keyboard.press('End');
  await page.keyboard.type(` and before quitting ${RUN}`);
  await expect(body(page)).toContainText(`before quitting ${RUN}`);
  opened.splice(opened.indexOf(launched), 1);
  await app.close();
  await expect
    .poll(() => w.show(w.files().find((path) => path.endsWith(`${title}.md`))!))
    .toContain(`before quitting ${RUN}`);

  // A registry as a Mac before D51 kept it, with a sealed confirmation in the entry: it still
  // loads, and the next write drops the confirmation.
  const registryFile = join(launched.userData, 'git-notebooks.json');
  const registry = JSON.parse(readFileSync(registryFile, 'utf8')) as {
    notebooks: Array<{ notebookId: string; confirmed?: string }>;
  };
  for (const entry of registry.notebooks) {
    if (entry.notebookId === notebookId) entry.confirmed = 'djEwAAAAsealed-by-an-older-mac';
  }
  writeFileSync(registryFile, JSON.stringify(registry, null, 2));

  // Launched again: still the notebook's app, and still dark.
  const again = await launch({
    userData: launched.userData,
    env: { PENMOSS_TEST_GIT_CONFIG: w.config },
  });
  opened.push(again);
  await expect(section(again.page, name)).toBeVisible();
  await expect(again.page.locator('html')).toHaveAttribute('data-mode', 'dark');
  recordOutsideTraffic(again.page, traffic);
  await go(again.page, `/notes/${noteId}`);
  await expect(again.page.getByTestId('note-view')).toHaveAttribute('data-ready', 'true');
  const loaded = await notebookPage(again.page, name);
  await loaded.getByTestId('git-sync-now').click();
  await expect(loaded.getByTestId('git-status')).toHaveAttribute('data-phase', 'synced', {
    timeout: 30_000,
  });
  await expect(loaded.getByTestId('git-privacy')).toHaveCount(0);
  // The File menu has no Confirm private any more.
  expect(
    await again.app.evaluate(
      ({ Menu }) => Menu.getApplicationMenu()?.getMenuItemById('git.confirmPrivate') ?? null,
    ),
  ).toBeNull();
  // A write (Pull every, here) keeps the notebook and drops the old confirmation.
  await loaded.getByTestId('git-pull-interval').fill('7');
  await loaded.getByTestId('git-pull-interval').blur();
  await expect.poll(() => readFileSync(registryFile, 'utf8')).toContain('"pullEveryMin": 7');
  expect(readFileSync(registryFile, 'utf8')).not.toContain('"confirmed"');
  expect(checksAsked(again)).toEqual([]);

  // No request or frame outside the app named the notebook, its notes or their words.
  const sent = traffic.join('\n');
  for (const secret of [
    notebookId,
    noteId,
    dailyId,
    fromCli.id,
    otherNote,
    otherName,
    title,
    `Secret words ${RUN}`,
    name,
  ]) {
    expect(sent).not.toContain(secret);
  }
  expect(errors).toEqual([]);
});

test('two git notebooks side by side, one over HTTP; two windows, History, a tag, the Journal, and Remove', async () => {
  const w = world();
  // The other device makes the notebook and a note with two versions.
  w.cli(['notebook', 'add', `file://${w.remote}`, '--name', 'team']);
  const title = `Team plan ${RUN}`;
  const made = JSON.parse(
    w.cli(['new', title, '--text', `First line ${RUN}`, '--notebook', 'team', '--json']),
  ) as { id: string };
  w.cli(['append', made.id, '--text', `Second line ${RUN}`, '--notebook', 'team']);

  // The Mac reaches the same repository as a host serves it, over HTTP (an https:// remote's
  // shape: host, owner path, .git).
  execFileSync('git', ['-C', w.remote, 'config', 'http.receivepack', 'true']);
  const host = await httpHost(w.root, null);
  hosts.push(host);
  const launched = await start(w.config);
  const { app, page, errors } = launched;
  const traffic: string[] = [];
  recordOutsideTraffic(page, traffic);
  // This Mac's own notebook first, on a repository here.
  const own = await gitNotebook(launched, `Own ${RUN}`);

  // A repository on a host GitHub cannot be asked about: it syncs without a check, and nobody
  // is asked (D51), even with the owner check refusing everything.
  answerChecks(launched, 'refuse');
  await go(page, '/settings/git-notebooks');
  const remote = `${host.origin}/notes.git`;
  const settings = await addNotebook(page, { remote });
  await expect(settings.getByTestId('git-add-message')).toContainText('Added “team”');
  expect(checksAsked(launched)).toEqual([]);
  await settings.getByTestId('git-notebook-row').filter({ hasText: 'team' }).click();
  const card = settings.getByTestId('git-notebook').filter({ hasText: 'team' });
  // A1128: no Private row; the repository is shown instead.
  await expect(card.getByTestId('git-privacy')).toHaveCount(0);
  await expect(card.getByTestId('git-repository')).toContainText('127.0.0.1');
  await expect(card.getByTestId('git-status')).toHaveAttribute('data-phase', 'synced', {
    timeout: 30_000,
  });
  const notebookId = (await card.getAttribute('data-notebook-id'))!;

  // A script in the page, as an agent driving it would be, cannot remove the notebook: main
  // wants a click or a key press, then the owner check (Touch ID), which only a person can give
  // (A855). Here nobody answers it. The click on Add a moment ago still
  // counts as a person's for a few seconds (transient activation): the script runs after it.
  answerChecks(launched, 'refuse');
  await expect
    .poll(() => runInMainPage(app, 'navigator.userActivation.isActive', false), {
      timeout: 15_000,
    })
    .toBe(false);
  const scripted = (await runInMainPage(
    app,
    `(async () => {
      const git = window.penmossDesktop.git;
      const entry = (await git.list()).find((each) => each.name === 'team');
      return [
        typeof git.confirmPrivate,
        await git.remove(entry.localId),
        await git.update(entry.localId, { author: { name: 'Agent', email: 'agent@example.invalid' } }),
      ];
    })()`,
    false,
  )) as [string, ...Array<{ ok: boolean; error?: { message: string } }>];
  const [confirmPrivate, ...refused] = scripted;
  // The page has no Confirm private to call (D51).
  expect(confirmPrivate).toBe('undefined');
  // Nor set who commits (#174 review).
  expect(refused.map((answer) => answer.ok)).toEqual([false, false]);
  // Refused for want of a click or a key press, before any Touch ID.
  for (const answer of refused) {
    expect(answer.error).toEqual({
      code: 'not_confirmed',
      message: 'Not done: confirm with a click or a key press.',
    });
  }
  expect(checksAsked(launched)).toEqual([]);
  await expect(card.getByTestId('git-privacy')).toHaveCount(0);
  answerChecks(launched, 'confirm');

  // Side by side: the two notebooks' sections, each its own tree.
  await chooseMenu(app, 'app.home');
  const mine = section(page, own.name);
  const team = section(page, 'team');
  await expect(mine).toBeVisible();
  await expect(team.getByRole('link', { name: title })).toBeVisible();
  await expect(mine.getByRole('link', { name: title })).toHaveCount(0);
  const ownTitle = `Own note ${RUN}`;
  await mine.getByTestId('tree-root-drop').click();
  const ownId = await newNote(page, ownTitle, 'only in my own notebook');
  await expect(mine.getByRole('link', { name: ownTitle })).toBeVisible();
  await expect(team.getByRole('link', { name: ownTitle })).toHaveCount(0);
  // A click in the notebook's section makes it the one new notes go to (A862).
  await team.getByTestId('tree-root-drop').click();
  const teamNote = await newNote(page, `Team note ${RUN}`, 'made from the section');
  await expect(team.locator(`a[href="/notes/${teamNote}"]`)).toBeVisible();
  // And another straight after: New note knows a git note's title too (not a repeated press).
  const teamNote2 = await newNote(page, `Team second ${RUN}`, 'right after');
  await expect(team.locator(`a[href="/notes/${teamNote2}"]`)).toBeVisible();
  await expect(mine.locator(`a[href="/notes/${teamNote}"]`)).toHaveCount(0);

  // Move to Trash from the notebook's section while the other notebook's note is open, then Undo:
  // the notebook's own trash both ways (A826); the other note stays open.
  await mine.getByRole('link', { name: ownTitle }).click();
  await expect(page).toHaveURL(new RegExp(`/notes/${ownId}$`));
  await expect(page.getByTestId('note-view')).toHaveAttribute('data-ready', 'true');
  const second2 = team.getByRole('treeitem', { name: `Team second ${RUN}`, exact: true });
  await second2.click({ button: 'right' });
  await page
    .getByRole('menu', { name: `“Team second ${RUN}”` })
    .getByRole('menuitem', { name: 'Move to Trash' })
    .click();
  const toast = page.getByTestId('trashed-toast');
  await expect(toast).toContainText(`Moved “Team second ${RUN}” to Trash`);
  await expect(team.locator(`a[href="/notes/${teamNote2}"]`)).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`/notes/${ownId}$`));
  await toast.getByTestId('trashed-undo').click();
  await expect(toast).toBeHidden();
  await expect(team.locator(`a[href="/notes/${teamNote2}"]`)).toBeVisible();
  await expect(mine.locator(`a[href="/notes/${teamNote2}"]`)).toHaveCount(0);
  // And from the note itself, in the notebook.
  await team.locator(`a[href="/notes/${teamNote}"]`).click();
  await expect(page).toHaveURL(new RegExp(`/notes/${teamNote}$`));
  await expect(page.getByTestId('note-view')).toHaveAttribute('data-ready', 'true');
  await chooseMenu(app, 'note.delete');
  await expect(toast).toContainText(`Moved “Team note ${RUN}” to Trash`);
  await toast.getByTestId('trashed-undo').click();
  await expect(page).toHaveURL(new RegExp(`/notes/${teamNote}$`));
  await expect(body(page)).toContainText('made from the section');
  await expect(team.locator(`a[href="/notes/${teamNote}"]`)).toBeVisible();

  // The git note in a window of its own: its edit goes through the main window's engine.
  await team.getByRole('link', { name: title }).click();
  await expect(page).toHaveURL(new RegExp(`/notes/${made.id}$`));
  await expect(page.getByTestId('note-view')).toHaveAttribute('data-ready', 'true');
  await expect(body(page)).toContainText(`Second line ${RUN}`);
  await expect(page.getByTestId('save-status')).toHaveAttribute('data-state', 'synced');
  const [second] = await Promise.all([
    app.waitForEvent('window'),
    chooseMenu(app, 'note.openInNewWindow'),
  ]);
  recordOutsideTraffic(second, traffic);
  await expect(second).toHaveURL(WINDOW);
  await expect(second.getByTestId('note-view')).toHaveAttribute('data-ready', 'true');
  await body(second).click();
  await second.keyboard.press(DOC_END);
  await second.keyboard.press('Enter');
  await second.keyboard.type(`From the note window #gitsecret${RUN} `);
  await expect(body(page)).toContainText(`From the note window`);
  // Closed straight after typing (PR #167, #166's loss): main has it store its last keystrokes
  // first, the main window reads them, and its engine pushes them, whole.
  await closeNoteWindow(app, second);
  await focusMain(app);
  await expect(body(page)).toContainText(`From the note window #gitsecret${RUN}`);
  await syncNow(page, 'team');
  await expect
    .poll(() => w.cli(['cat', made.id, '--notebook', 'team']))
    .toContain(`From the note window #gitsecret${RUN}`);
  // A window that goes without that hand-off (its 3 seconds ran out) keeps its last keystrokes
  // as it goes (A626); the main window merges them at once, not at the next launch, and pushes.
  await go(page, `/notes/${made.id}`);
  await expect(page.getByTestId('note-view')).toHaveAttribute('data-ready', 'true');
  await expect(body(page)).toContainText(`From the note window #gitsecret${RUN}`);
  const [third] = await Promise.all([
    app.waitForEvent('window'),
    chooseMenu(app, 'note.openInNewWindow'),
  ]);
  recordOutsideTraffic(third, traffic);
  await expect(third.getByTestId('note-view')).toHaveAttribute('data-ready', 'true');
  await body(third).click();
  await third.keyboard.press(DOC_END);
  await third.keyboard.press('Enter');
  await third.keyboard.type(`Kept as it went ${RUN}`);
  await third.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')));
  // Playwright's close tears the page down with no close event for main to hold it.
  await third.close();
  await focusMain(app);
  await expect(body(page)).toContainText(`Kept as it went ${RUN}`);
  await syncNow(page, 'team');
  await expect
    .poll(() => w.cli(['cat', made.id, '--notebook', 'team']))
    .toContain(`Kept as it went ${RUN}`);

  // Rename the tag in the notebook: an edit of each of its notes, on this Mac.
  await go(page, `/notes/${made.id}`);
  const tags = page.getByTestId('tag-pane');
  await tags.getByRole('button', { name: `Rename #gitsecret${RUN}` }).click();
  await tags
    .getByRole('textbox', { name: `New name for #gitsecret${RUN}` })
    .fill(`gitrenamed${RUN}`);
  await tags.getByRole('button', { name: 'Rename', exact: true }).click();
  await expect(tags.getByRole('status')).toHaveText(
    `Renamed #gitsecret${RUN} to #gitrenamed${RUN} in 1 note`,
  );
  await expect(body(page)).toContainText(`#gitrenamed${RUN}`);

  // History: the notebook's commits; Restore brings the CLI's first version back (A858).
  await body(page).click();
  await page.keyboard.press(mac ? 'Meta+Alt+Shift+KeyH' : 'Alt+Shift+KeyH');
  const history = page.getByTestId('history-panel');
  await expect(history).toBeVisible();
  const versions = history.getByRole('list', { name: 'Versions' }).getByRole('button');
  await expect.poll(() => versions.count()).toBeGreaterThanOrEqual(3);
  await versions.last().click();
  await expect(history.getByTestId('history-diff')).toContainText(`First line ${RUN}`);
  await history.getByRole('button', { name: 'Restore This Version' }).click();
  await expect(history.getByTestId('history-status')).toContainText('as a new change');
  // Touch ID first, naming the note, as Android's BiometricPrompt does (A901).
  expect(checksAsked(launched).at(-1)).toContain('restore an earlier version');
  await expect(body(page)).not.toContainText(`Second line ${RUN}`);
  // The History tab of the note's panel (T51, A936), over the text: beside the sidebar, a 1200 px
  // window's note pane is under 60rem, too narrow for the panel beside it (T53 item 9, A985).
  await expect(page.locator('.note-columns')).toHaveAttribute('data-over', '');
  await page.getByTestId('note-panel-close').click();
  await expect(history).toHaveCount(0);
  await syncNow(page, 'team');
  await expect
    .poll(() => w.cli(['cat', made.id, '--notebook', 'team']))
    .not.toContain(`Second line ${RUN}`);

  // The Primary Notebook is this Mac's choice (A827; T62 item 9, on the notebook's page): today's
  // note goes to the notebook.
  await go(page, `/settings/git-notebooks/${notebookId}`);
  await page.getByTestId('git-make-primary').click();
  await expect(page.getByTestId('git-primary-chip')).toBeVisible();
  await chooseMenu(app, 'app.home');
  await chooseMenu(app, 'journal.today');
  await expect(page).toHaveURL(ULID);
  const dailyId = ULID.exec(new URL(page.url()).pathname)![1]!;
  await chooseMenu(app, 'app.home');
  await expect(
    team.locator(`a[href="/notes/${dailyId}"]`),
    'today’s note is in the notebook',
  ).toBeVisible();
  await expect(mine.locator(`a[href="/notes/${dailyId}"]`)).toHaveCount(0);

  // Quick capture names its notebook and lets it be changed, as Android's sheet does (A888,
  // A914): it starts on the Journal notebook picked here, and goes where it is set.
  await app.evaluate(() =>
    (
      globalThis as unknown as { penmossDesktop: { showCapture(): void } }
    ).penmossDesktop.showCapture(),
  );
  const capture = await capturePage(app);
  const into = capture.getByTestId('capture-into');
  await expect(into).toHaveValue(notebookId);
  await expect(into.locator('option')).toHaveCount(2);
  const other = await into
    .locator('option')
    .evaluateAll(
      (options, id) => options.map((o) => (o as HTMLOptionElement).value).find((v) => v !== id)!,
      notebookId,
    );
  await into.selectOption(other);
  await expect(into).toHaveValue(other);
  await into.selectOption(notebookId);
  await capture.getByRole('radio', { name: 'New Note in Inbox' }).check();
  await capture.getByTestId('capture-text').fill(`Captured into team ${RUN}\nfrom the hotkey`);
  await capture.getByTestId('capture-text').press('Control+Enter');
  await expect
    .poll(() =>
      app.evaluate(
        () =>
          (
            globalThis as unknown as {
              penmossDesktop: { captureWindow(): { isVisible(): boolean } | null };
            }
          ).penmossDesktop
            .captureWindow()
            ?.isVisible() ?? false,
      ),
    )
    .toBe(false);
  // The capture reaches the notebook's engine on its own time: a Sync now that ran before it
  // leaves it for the next push (60 s), so Sync now again until the branch has it.
  await expect
    .poll(
      async () => {
        await syncNow(page, 'team');
        return w.files().some((path) => path.endsWith(`Captured into team ${RUN}.md`));
      },
      { timeout: 30_000 },
    )
    .toBe(true);

  // Remove with an edit not pushed yet: it says what would be lost and offers to push first.
  await go(page, `/notes/${made.id}`);
  await expect(page.getByTestId('note-view')).toHaveAttribute('data-ready', 'true');
  await body(page).click();
  await page.keyboard.press(DOC_END);
  await page.keyboard.type(` not pushed yet ${RUN}`);
  await expect(body(page)).toContainText(`not pushed yet ${RUN}`);
  await notebookPage(page, 'team');
  await card.getByTestId('git-remove').click();
  const removing = card.getByTestId('git-remove-confirm');
  await expect(removing).toContainText('not pushed yet: removing now loses');
  await removing.getByTestId('git-remove-push').click();
  await expect(card.getByTestId('git-status')).toHaveAttribute('data-phase', 'synced', {
    timeout: 30_000,
  });
  await expect(card.getByTestId('git-status')).not.toContainText('waiting');
  await expect
    .poll(() => w.cli(['cat', made.id, '--notebook', 'team']))
    .toContain(`not pushed yet ${RUN}`);
  // Everything pushed: Touch ID at once; this Mac's copy goes, the repository keeps it all.
  await card.getByTestId('git-remove').click();
  // Back to the list, with the other notebook alone.
  await expect(settings.getByTestId('git-notebook-row')).toHaveCount(1);
  expect(checksAsked(launched).at(-1)).toBe(
    'remove the git notebook at 127.0.0.1/notes from this Mac',
  );
  // Every git call went to the host the Mac was given.
  expect(host.requests.length).toBeGreaterThan(0);
  await expect
    .poll(() => page.evaluate(async () => (await indexedDB.databases()).map((db) => db.name ?? '')))
    .not.toEqual(expect.arrayContaining([`penmoss-git-${notebookId}`]));
  await chooseMenu(app, 'app.home');
  await expect(section(page, 'team')).toHaveCount(0);
  expect(w.files().some((path) => path.endsWith(`${title}.md`))).toBe(true);

  const sent = traffic.join('\n');
  for (const secret of [
    notebookId,
    made.id,
    teamNote,
    dailyId,
    title,
    `First line ${RUN}`,
    teamNote2,
    `gitsecret${RUN}`,
    `gitrenamed${RUN}`,
    `not pushed yet ${RUN}`,
    `Captured into team ${RUN}`,
    ownId,
    w.remote,
    own.remote,
  ]) {
    expect(sent, secret).not.toContain(secret);
  }
  expect(errors).toEqual([]);
});

test('Add a Git Notebook lists GitHub repositories with git’s own credential, and makes the notebook in one picked (T81)', async () => {
  test.setTimeout(120_000);
  const w = world();
  // git's credential helper has a token for github.com; the fake GitHub takes only that one.
  const token = `gho_e2e${RUN}0000000000000000000000`;
  const helper = join(w.root, 'credential.sh');
  writeFileSync(
    helper,
    `#!/bin/sh\n[ "$1" = get ] || exit 0\nwhile read line; do [ -z "$line" ] && break; done\necho username=x-access-token\necho password=${token}\n`,
    { mode: 0o755 },
  );
  writeFileSync(w.config, `${readFileSync(w.config, 'utf8')}[credential]\n  helper = ${helper}\n`);
  const github = new FakeGitHubBrowse({ token, login: 'ryan' });
  github.repos = [
    {
      owner: 'ryan',
      name: 'notes',
      cloneUrl: `file://${w.remote}`,
      pushedAt: '2026-11-06T10:00:00Z',
      files: null,
    },
    {
      owner: 'acme',
      name: 'wiki',
      canPush: false,
      visibility: 'internal',
      pushedAt: '2026-01-01T10:00:00Z',
      files: { 'a.md': 'a' },
    },
  ];
  const served = await github.serve();
  hosts.push(served);
  const launched = await launch({
    env: { PENMOSS_TEST_GIT_CONFIG: w.config, PENMOSS_TEST_GITHUB_API: served.origin },
  });
  opened.push(launched);
  await mainBounds(launched.app, { x: 0, y: 0, width: 1200, height: 800 });
  const { page, errors } = launched;
  const traffic: string[] = [];
  recordOutsideTraffic(page, traffic);

  // First Run C: Start a New Notebook, Use Existing Repo, the tree of repositories.
  const firstRun = page.getByTestId('first-run');
  await firstRun.getByTestId('first-run-start').click({ timeout: 30_000 });
  await firstRun.getByTestId('first-run-continue').click();
  await firstRun.getByTestId('first-run-way-existing').click();
  await firstRun.getByTestId('first-run-continue').click();
  const rows = firstRun.getByTestId('first-run-tree-repo');
  await expect(rows).toHaveCount(2, { timeout: 30_000 });
  await expect(rows.first()).toHaveAttribute('data-repo', 'ryan/notes');
  await expect(rows.last().getByTestId('first-run-repo-pick')).toBeDisabled();
  await rows.first().getByTestId('first-run-repo-pick').click();
  await expect(firstRun.getByRole('heading', { name: 'Empty Repository' })).toBeVisible();
  await firstRun.getByTestId('first-run-continue').click();
  await firstRunName(page, `Picked ${RUN}`);
  await expect(page.getByTestId('note-title')).toHaveValue('Welcome to Penmoss', {
    timeout: 30_000,
  });
  // The repository was empty: `main` exists only once the first push lands, and `expect.poll`
  // stops at a throw, so a branch not there yet reads as no files.
  const pushed = () => {
    try {
      return w.files();
    } catch {
      return [];
    }
  };
  await expect.poll(pushed, { timeout: 30_000 }).toContain('.penmoss/notebook.json');

  // main asked GitHub with git's token; the page never sent it, nor reached GitHub itself.
  expect(github.requests.length).toBeGreaterThan(0);
  expect(github.requests.every((each) => each.auth === `Bearer ${token}`)).toBe(true);
  expect(traffic.join('\n')).not.toContain(token);
  expect(traffic.join('\n')).not.toContain(served.origin);
  expect(errors).toEqual([]);
});

test('with no GitHub sign-in in git, Sign in with GitHub lists the repositories with Penmoss’s own (T82)', async () => {
  test.setTimeout(120_000);
  const w = world();
  // git has no credential for github.com; GitHub's device flow gives Penmoss this token.
  const token = `gho_e2e${RUN}1111111111111111111111`;
  const github = new FakeGitHubBrowse({ token, login: 'ryan' });
  github.repos = [
    {
      owner: 'ryan',
      name: 'notes',
      cloneUrl: `file://${w.remote}`,
      pushedAt: '2026-11-06T10:00:00Z',
      files: null,
    },
  ];
  const served = await github.serve();
  hosts.push(served);
  const launched = await launch({
    env: {
      PENMOSS_TEST_GIT_CONFIG: w.config,
      PENMOSS_TEST_GITHUB_API: served.origin,
      PENMOSS_TEST_GITHUB_WEB: served.origin,
      PENMOSS_TEST_GITHUB_CLIENT_ID: github.device.clientId,
    },
  });
  opened.push(launched);
  await mainBounds(launched.app, { x: 0, y: 0, width: 1200, height: 800 });
  const { page, errors } = launched;
  const traffic: string[] = [];
  recordOutsideTraffic(page, traffic);

  // First Run C: Start a New Notebook, Use Existing Repo; git has no sign-in, so Sign In to GitHub.
  const firstRun = page.getByTestId('first-run');
  await firstRun.getByTestId('first-run-start').click({ timeout: 30_000 });
  await firstRun.getByTestId('first-run-continue').click();
  await firstRun.getByTestId('first-run-way-existing').click();
  await firstRun.getByTestId('first-run-continue').click();
  await firstRun.getByTestId('first-run-signin').click({ timeout: 30_000 });
  await expect(firstRun.getByTestId('github-signin-code')).toHaveText(github.device.userCode);
  expect(github.device.codes).toBe(1);
  github.approve();
  await expect(firstRun.getByTestId('first-run-signed-in')).toContainText('Signed in as ryan', {
    timeout: 30_000,
  });
  await firstRun.getByTestId('first-run-continue').click();
  await expect(firstRun.getByTestId('first-run-via')).toContainText('Signed in as ryan', {
    timeout: 30_000,
  });
  await firstRun
    .getByTestId('first-run-tree-repo')
    .first()
    .getByTestId('first-run-repo-pick')
    .click();
  await expect(firstRun.getByRole('heading', { name: 'Empty Repository' })).toBeVisible();
  await firstRun.getByTestId('first-run-continue').click();
  await firstRunName(page, `Signed in ${RUN}`);
  await expect(page.getByTestId('note-title')).toHaveValue('Welcome to Penmoss', {
    timeout: 30_000,
  });

  // The API was asked with the device flow's token only, and only by main.
  const api = github.requests.filter((each) => !each.path.startsWith('/login/'));
  expect(api.length).toBeGreaterThan(0);
  expect(api.every((each) => each.auth === `Bearer ${token}`)).toBe(true);
  expect(traffic.join('\n')).not.toContain(token);
  expect(traffic.join('\n')).not.toContain(github.device.deviceCode);
  expect(traffic.join('\n')).not.toContain(served.origin);
  expect(errors).toEqual([]);
});
