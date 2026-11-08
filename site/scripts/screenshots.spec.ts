/**
 * penmoss.app's screenshots (T80.9, A1210): the demo notebook (site/demo/) played into a git
 * repository by its three writers (the Mac, the Pixel and an agent), each at its own fixed time,
 * then opened in the web app as the Mac app's page, through the web suite's stand-in for the Mac
 * (apps/web/test/e2e/fixtures.ts), with the page's clock fixed at the notebook's `now`.
 *
 * Every shot is taken in light and dark, as PNG at 2880×1800 (1440×900 at 2x), into
 * `PENMOSS_SHOTS_DIR`; scripts/screenshots.mjs turns them into WebP. Nothing here is random:
 * the writers' ids, clocks and client ids are fixed, and git's dates are each step's.
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  GitNotebookEngine,
  MemorySecrets,
  MemoryStorage,
  NotebookOps,
  type WriterKind,
} from '../../packages/git-notebook/src/index';
import { LocalNotebook } from '../../packages/git-notebook/src/local/index';
import { NodeGitTransport } from '../../packages/git-notebook/src/node/index';
import { expect, test, type GitHost, type Page } from '../../apps/web/test/e2e/fixtures';

const DEMO = fileURLToPath(new URL('../demo/', import.meta.url));
const OUT = process.env['PENMOSS_SHOTS_DIR'];

interface DemoNote {
  readonly title: string;
  readonly folder: string;
  readonly file: string;
}
interface DemoStep {
  readonly at: string;
  readonly writer: string;
  readonly folders?: readonly string[];
  readonly notes?: readonly DemoNote[];
  readonly daily?: string;
  /** An edit through the local notes API: `append` a file's markdown, or `replace` text. */
  readonly edit?:
    | { readonly note: string; readonly op: 'append'; readonly file: string }
    | {
        readonly note: string;
        readonly op: 'replace';
        readonly find: string;
        readonly replace: string;
      };
}
interface Demo {
  readonly name: string;
  readonly timeZone: string;
  readonly now: string;
  readonly writers: Readonly<Record<string, { kind: WriterKind; label: string }>>;
  readonly steps: readonly DemoStep[];
}

const demo = JSON.parse(readFileSync(join(DEMO, 'notebook.json'), 'utf8')) as Demo;
const text = (file: string) => readFileSync(join(DEMO, file), 'utf8');

/** Crockford's base32, as ULIDs spell them. */
const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
function ulidAt(ms: number, n: number): string {
  let time = '';
  for (let i = 0, t = ms; i < 10; i++, t = Math.floor(t / 32)) time = B32[t % 32]! + time;
  let rest = '';
  for (let i = 0, k = n; i < 16; i++, k = Math.floor(k / 32)) rest = B32[k % 32]! + rest;
  return time + rest;
}

/** mulberry32: the writers' "random" numbers, the same on every run. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Git's author and committer dates for what runs next (gitRunner reads process.env each time). */
function gitDate(iso: string): void {
  process.env['GIT_AUTHOR_DATE'] = iso;
  process.env['GIT_COMMITTER_DATE'] = iso;
}

/**
 * Plays the demo's steps into a new bare repository: each writer on its own clone (as the Mac,
 * the phone and an agent's local MCP each have one), syncing once per step at the step's time.
 * Returns the remote and the notes' ids by title.
 */
async function playDemo(host: GitHost): Promise<{ remote: string; ids: Map<string, string> }> {
  const remote = host.bare('demo');
  let now = Date.parse(demo.steps[0]!.at);
  let count = 0;
  const newId = () => ulidAt(now, ++count);
  const writers = new Map<
    string,
    { engine: GitNotebookEngine; ops: NotebookOps; local: LocalNotebook }
  >();
  const ids = new Map<string, string>();
  const folders = new Map<string, string>();
  let clientID = 1000;
  const writerOf = async (key: string) => {
    const known = writers.get(key);
    if (known) return known;
    const writer = demo.writers[key];
    if (!writer) throw new Error(`No writer ${key} in the demo.`);
    const dir = mkdtempSync(join(host.root, `demo-${key}-`));
    const transport = new NodeGitTransport({
      gitDir: join(dir, 'repo.git'),
      remote,
      branch: 'main',
      root: '',
      author: { name: writer.label, email: `${key}@example.invalid` },
      env: host.env,
      sign: false,
    });
    await transport.init();
    const engine = await GitNotebookEngine.open({
      transport,
      storage: new MemoryStorage(),
      secrets: new MemorySecrets(),
      writer,
      ...(writers.size === 0 ? { create: { id: newId(), name: demo.name } } : {}),
      clock: () => now,
      clientID: (clientID += 1000),
      random: seeded(clientID),
      newId,
    });
    const ops = new NotebookOps(engine, () => now, newId);
    const made = { engine, ops, local: new LocalNotebook(ops, () => now) };
    writers.set(key, made);
    return made;
  };
  const folderAt = (ops: NotebookOps, path: string): string => {
    const known = folders.get(path);
    if (known) return known;
    const cut = path.lastIndexOf('/');
    const parentId = cut < 0 ? null : folderAt(ops, path.slice(0, cut));
    const id = ops.createFolder({ name: path.slice(cut + 1), parentId });
    folders.set(path, id);
    return id;
  };

  for (const step of demo.steps) {
    now = Date.parse(step.at);
    gitDate(step.at);
    const { engine, ops, local } = await writerOf(step.writer);
    await engine.sync();
    if (writers.size === 1 && folders.size === 0) ops.setSetting('timeZone', demo.timeZone);
    for (const folder of step.folders ?? []) folderAt(ops, folder);
    for (const note of step.notes ?? []) {
      const id = ops.createNote({
        title: note.title,
        folderId: folderAt(ops, note.folder),
        markdown: text(note.file),
      });
      ids.set(note.title, id);
    }
    if (step.daily) {
      const day = ops.daily({ kind: 'daily', date: step.daily, create: true });
      ids.set(step.daily, day.id);
      // The template's headings, filled in.
      for (const section of text(`journal/${step.daily}.md`).split(/^## /m).slice(1)) {
        const cut = section.indexOf('\n');
        local.edit(
          day.id,
          {
            op: 'section',
            heading: section.slice(0, cut).trim(),
            markdown: section.slice(cut + 1).trim(),
            mode: 'replace',
          },
          null,
        );
      }
    }
    if (step.edit) {
      const id = ids.get(step.edit.note);
      if (!id) throw new Error(`No note ${step.edit.note} before this edit.`);
      local.edit(
        id,
        step.edit.op === 'replace'
          ? { op: 'replace', find: step.edit.find, replace: step.edit.replace, all: false }
          : { op: 'append', markdown: text(step.edit.file).trim() },
        null,
      );
    }
    await engine.save();
    const report = await engine.sync();
    if (!report.commit) throw new Error(`The step at ${step.at} made no commit.`);
  }
  return { remote, ids };
}

/** The app has drawn everything: fonts, diagrams, no transition running. */
async function still(page: Page): Promise<void> {
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  await page.waitForFunction(() =>
    document.getAnimations().every((animation) => animation.playState !== 'running'),
  );
}

/** A screenshot once two in a row are the same: whatever was still changing has settled. */
async function shot(page: Page, name: string): Promise<void> {
  await still(page);
  let last = await page.screenshot({ animations: 'disabled', caret: 'hide' });
  for (let tries = 0; ; tries++) {
    const next = await page.screenshot({ animations: 'disabled', caret: 'hide' });
    if (next.equals(last)) break;
    if (tries > 20) throw new Error(`${name} never settled.`);
    last = next;
  }
  if (!OUT) throw new Error('PENMOSS_SHOTS_DIR is not set.');
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, `${name}.png`), last);
}

const view = (page: Page) => page.getByTestId('note-view');

async function openNote(page: Page, id: string): Promise<void> {
  await page.goto(`/notes/${id}`);
  await expect(view(page)).toHaveAttribute('data-ready', 'true', { timeout: 30_000 });
  await expect(page.getByTestId('section-sync').first()).toHaveAttribute('data-state', 'synced', {
    timeout: 40_000,
  });
}

/** Closes the note's side panel (Metadata, History, …) when it is open. */
async function closePanel(page: Page): Promise<void> {
  const close = page.getByTestId('note-panel-close');
  if (await close.isVisible()) await close.click();
  await expect(close).toHaveCount(0);
}

/** Runs a palette command by its title. */
async function runCommand(page: Page, title: string): Promise<void> {
  await page.keyboard.press('ControlOrMeta+KeyK');
  const palette = page.getByRole('dialog', { name: 'Command Palette' });
  await expect(palette).toBeVisible();
  await palette.getByRole('combobox').fill(title);
  await expect(palette.getByRole('option').first()).toContainText(title);
  await page.keyboard.press('Enter');
  await expect(palette).toBeHidden();
}

/** The pointer rests on the empty middle of the title bar, where it lights nothing up. */
const rest = (page: Page) => page.mouse.move(1100, 22);

test.use({ seed: null });

test('the site screenshots', async ({ page, host }, info) => {
  const scheme = info.project.name;
  const { remote, ids } = await playDemo(host);
  // What the page itself commits is dated now, as its clock says.
  gitDate(demo.now);
  await host.add(remote, demo.name);
  await page.clock.install({ time: new Date(demo.now) });
  const id = (title: string) => {
    const found = ids.get(title);
    if (!found) throw new Error(`No note ${title} in the demo.`);
    return found;
  };
  const body = page.getByTestId('note-body').locator('.ProseMirror');

  // Hero: the project note, with its table, diagram and checklist.
  await openNote(page, id('Driftwood 0.4'));
  await closePanel(page);
  await expect(body.locator('.pm-diagram-output svg').first()).toBeVisible({ timeout: 15_000 });
  await rest(page);
  await shot(page, `hero-${scheme}`);

  // Journal: today's note, with the calendar.
  await openNote(page, id('2026-11-06'));
  await closePanel(page);
  await rest(page);
  await shot(page, `journal-${scheme}`);

  // History: the release notes, with the agent's edit chosen and its diff.
  await openNote(page, id('Release notes 0.4'));
  await page.getByTestId('note-tab-history').click();
  const panel = page.getByTestId('history-panel');
  await panel
    .getByRole('list', { name: 'Versions' })
    .getByRole('button', { name: /Claude Code/ })
    .click();
  await expect(panel.getByTestId('history-diff').locator('[data-op="add"]').first()).toBeVisible();
  await rest(page);
  await shot(page, `history-${scheme}`);
  await closePanel(page);

  // Editor: the design note (a callout, highlighted code), with the slash menu open on a new
  // line at its end.
  await openNote(page, id('Feed parser design'));
  await closePanel(page);
  const paragraph = body.locator('p', { hasText: 'Articles are sorted newest first' });
  await paragraph.click();
  await paragraph.evaluate((p) => {
    const range = document.createRange();
    range.selectNodeContents(p);
    range.collapse(false);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  });
  await page.keyboard.press('Enter');
  await page.keyboard.type('/');
  await expect(page.getByRole('listbox', { name: 'Insert block' })).toBeVisible();
  // Kept on this Mac, and its push (seconds later) not started: the same words every run.
  await expect(page.getByTestId('save-status')).toContainText('not pushed yet');
  await rest(page);
  await shot(page, `editor-${scheme}`);
  await page.keyboard.press('Escape');

  // Themes: the project note in Rosé Pine, with Switch Theme open on the eight themes.
  await openNote(page, id('Driftwood 0.4'));
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await runCommand(page, 'Switch Theme…');
  const picker = page.getByRole('dialog', { name: 'Switch Theme' });
  await picker.locator('[role="option"][data-theme-id="rose-pine"]').click();
  await expect(picker).toBeHidden();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'rose-pine');
  await runCommand(page, 'Switch Theme…');
  await expect(picker).toBeVisible();
  await rest(page);
  await shot(page, `themes-${scheme}`);
});
