import { createHash } from 'node:crypto';
import { expect, test, type Page } from './fixtures';
import { isDeleted } from '@penmoss/sync-client/note';
import { readRemote, remoteFiles } from './support/remote';

// T68 (D58), in the web app (the Mac app runs the same page): Duplicate in a note's menu, named
// "(copy)", "(copy 2)" and so on (#227, A1144); moving or copying notes and folders to another
// open notebook, from a note's or a folder's menu or a Shift-click selection of both (#230,
// A1145).

const SHOTS = process.env['PENMOSS_EVIDENCE'];
const ULID = /\/notes\/([0-9A-HJKMNP-TV-Z]{26})$/;
/** A 1×1 PNG, kept in the first notebook and shown by one of its notes. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);
const SHA = createHash('sha256').update(PNG).digest('hex');

test.use({
  seed: {
    name: 'Personal',
    folders: ['Projects', 'Projects/Designs', 'Archive'],
    images: [new Uint8Array(PNG)],
    notes: [
      { title: 'Plan', markdown: 'The plan for the week.\n' },
      { title: 'Loose', markdown: 'A loose note.\n' },
      { title: 'Spec', markdown: 'What to build.\n', folder: 'Projects' },
      {
        title: 'Sketch',
        markdown: `A sketch.\n\n![](attachments/${SHA}.png)\n`,
        folder: 'Projects/Designs',
      },
      { title: 'Old', markdown: 'Done with.\n', folder: 'Archive' },
    ],
  },
});

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(error.message));
  return errors;
}

const section = (page: Page, name: string) =>
  page.getByTestId('source-section').and(page.getByRole('region', { name, exact: true }));
const treeIn = (page: Page, name: string) =>
  section(page, name).getByRole('tree', { name: 'Folders and notes' });
const rowIn = (page: Page, notebook: string, name: string) =>
  treeIn(page, notebook).getByRole('treeitem', { name, exact: true });

/** The tree's row labels in order, as shown. */
const labels = (page: Page, notebook: string) =>
  treeIn(page, notebook)
    .getByRole('treeitem')
    .evaluateAll((rows) => rows.map((row) => row.getAttribute('aria-label')));

async function synced(page: Page, name: string): Promise<void> {
  await expect(section(page, name).getByTestId('section-sync')).toHaveAttribute(
    'data-state',
    'synced',
    { timeout: 40_000 },
  );
}

async function pickIn(page: Page, path: string): Promise<void> {
  const picker = page.getByTestId('folder-picker');
  await expect(picker).toBeVisible();
  await picker.getByRole('combobox').fill(path);
  await picker.getByRole('combobox').press('Enter');
  await expect(picker).toBeHidden();
}

test('#227: Duplicate makes "(copy)", then "(copy 2)", just after the note, and opens it', async ({
  page,
  host,
  notebook,
}) => {
  test.setTimeout(90_000);
  const errors = collectErrors(page);
  await page.goto('/');
  await synced(page, 'Personal');
  const duplicate = async (title: string) => {
    await rowIn(page, 'Personal', title).click({ button: 'right' });
    await page.getByTestId('note-menu-duplicate').click();
  };

  await duplicate('Plan');
  await expect(page).toHaveURL(ULID);
  await expect(page.getByTestId('note-title')).toHaveValue('Plan (copy)');
  await expect(page.getByTestId('note-view').locator('.ProseMirror')).toContainText(
    'The plan for the week.',
  );
  const copyId = ULID.exec(page.url())![1]!;
  await expect(rowIn(page, 'Personal', 'Plan (copy)')).toHaveAttribute('aria-selected', 'true');
  await expect
    .poll(() => labels(page, 'Personal'))
    .toEqual(['Projects', 'Archive', 'Plan', 'Plan (copy)', 'Loose']);

  // Later copies of the same note, and a copy of a copy, count from the same base.
  await duplicate('Plan');
  await expect(page.getByTestId('note-title')).toHaveValue('Plan (copy 2)');
  await duplicate('Plan (copy)');
  await expect(page.getByTestId('note-title')).toHaveValue('Plan (copy 3)');
  await expect
    .poll(() => labels(page, 'Personal'))
    .toEqual([
      'Projects',
      'Archive',
      'Plan',
      'Plan (copy 2)',
      'Plan (copy)',
      'Plan (copy 3)',
      'Loose',
    ]);
  if (SHOTS) await page.locator('.sidebar').screenshot({ path: `${SHOTS}/duplicate.png` });

  // The copy reaches the repository as a note of its own.
  await synced(page, 'Personal');
  await expect
    .poll(async () => (await readRemote(host, notebook!.remote)).title(copyId), {
      timeout: 40_000,
    })
    .toBe('Plan (copy)');
  expect(errors).toEqual([]);
});

test('#230: a folder is copied to another notebook with its subfolders, notes and images', async ({
  page,
  host,
  notebook,
}) => {
  test.setTimeout(120_000);
  const errors = collectErrors(page);
  const work = await host.seed({ name: 'Work', folders: ['Clients'] });
  await page.goto('/');
  await synced(page, 'Personal');
  await synced(page, 'Work');

  await rowIn(page, 'Personal', 'Projects').click({ button: 'right' });
  await page.getByTestId('menu-copy-to-notebook').click();
  // Every other notebook's top level and folders, by path; this notebook's are not offered.
  const picker = page.getByTestId('folder-picker');
  await expect(picker.getByRole('dialog')).toHaveAccessibleName(
    'Copy “Projects” to another notebook',
  );
  // Every other notebook's top level, then its folders indented under it.
  await expect(picker.getByRole('option')).toHaveText(['Work', 'Clients']);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/copy-picker.png` });
  await pickIn(page, 'Work / Clients');
  await expect(page.getByTestId('tree-message').first()).toContainText(
    'Copied 2 notes and 2 folders to “Work”.',
  );

  // Work has the folder, its subfolder and both notes; Personal keeps its own.
  for (const name of ['Clients', 'Projects', 'Designs']) {
    const row = rowIn(page, 'Work', name);
    if ((await row.getAttribute('aria-expanded')) === 'false') await row.locator('.twisty').click();
  }
  await expect
    .poll(() => labels(page, 'Work'))
    .toEqual(['Clients', 'Projects', 'Designs', 'Sketch', 'Spec']);
  await expect(rowIn(page, 'Personal', 'Projects')).toBeVisible();

  // The copied note shows its image, from Work's own copy.
  await rowIn(page, 'Work', 'Sketch').click();
  await expect(page.getByTestId('note-title')).toHaveValue('Sketch');
  const view = page.getByTestId('note-view');
  await expect(view.locator('.pm-image')).toHaveAttribute('data-state', 'ready');
  await expect(view.locator('.pm-image img')).toHaveAttribute('src', /^blob:/);
  await expect
    .poll(() => view.locator('.pm-image img').evaluate((img: HTMLImageElement) => img.naturalWidth))
    .toBe(1);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/copied-folder.png` });

  // Work's repository gets the notes and the image; Personal's still has its originals.
  await synced(page, 'Work');
  await expect
    .poll(() => remoteFiles(host, work.remote).some((path) => path.endsWith(`${SHA}.png`)), {
      timeout: 40_000,
    })
    .toBe(true);
  await expect
    .poll(
      async () => {
        const remote = await readRemote(host, work.remote);
        return remote.workspace.folders.map((folder) => folder.name).sort();
      },
      { timeout: 40_000 },
    )
    .toEqual(['Clients', 'Designs', 'Projects']);
  const personal = await readRemote(host, notebook!.remote);
  expect(personal.workspace.folders.map((folder) => folder.name).sort()).toEqual([
    'Archive',
    'Designs',
    'Projects',
  ]);
  expect(errors).toEqual([]);
});

test('#230: a Shift-click selection of a folder and a note moves to another notebook', async ({
  page,
  host,
  notebook,
}) => {
  test.setTimeout(120_000);
  const errors = collectErrors(page);
  await host.seed({ name: 'Work' });
  await page.goto('/');
  await synced(page, 'Personal');
  await synced(page, 'Work');

  // Archive (a folder), then Shift-click down to Plan: both folders and the note between.
  await rowIn(page, 'Personal', 'Archive').click();
  await rowIn(page, 'Personal', 'Plan').click({ modifiers: ['Shift'] });
  await expect(rowIn(page, 'Personal', 'Archive')).toHaveAttribute('data-picked', '');
  await expect(rowIn(page, 'Personal', 'Plan')).toHaveAttribute('aria-selected', 'true');
  // ⌘-click takes one out, and puts one in.
  await rowIn(page, 'Personal', 'Archive').click({ modifiers: ['ControlOrMeta'] });
  await expect(rowIn(page, 'Personal', 'Archive')).not.toHaveAttribute('data-picked', '');
  await rowIn(page, 'Personal', 'Archive').click({ modifiers: ['ControlOrMeta'] });
  await rowIn(page, 'Personal', 'Loose').click({ modifiers: ['ControlOrMeta'] });

  await rowIn(page, 'Personal', 'Loose').click({ button: 'right' });
  await expect(page.getByRole('menu'))
    .toHaveAccessibleName('1 note and 1 folder', {
      ignoreCase: true,
    })
    .catch(() => undefined);
  await page.getByTestId('menu-move-to-notebook').click();
  await pickIn(page, 'Work');
  await expect(page.getByTestId('tree-message').first()).toContainText('Moved');

  // Gone from Personal (to its Trash), in Work with the folder's note.
  await expect(rowIn(page, 'Personal', 'Archive')).toHaveCount(0);
  await expect(rowIn(page, 'Personal', 'Plan')).toHaveCount(0);
  await expect(rowIn(page, 'Personal', 'Loose')).toHaveCount(0);
  await rowIn(page, 'Work', 'Archive').locator('.twisty').click();
  await expect.poll(() => labels(page, 'Work')).toEqual(['Archive', 'Old', 'Plan', 'Loose']);
  if (SHOTS) await page.locator('.sidebar').screenshot({ path: `${SHOTS}/moved.png` });

  // The originals are in Personal's Trash, where they can be restored.
  const [plan, loose, , , old] = notebook!.noteIds;
  await synced(page, 'Personal');
  await expect
    .poll(
      async () => {
        const remote = await readRemote(host, notebook!.remote);
        return [plan!, loose!, old!].map((id) => {
          const doc = remote.ops.note(id);
          return doc ? isDeleted(doc) : null;
        });
      },
      { timeout: 40_000 },
    )
    .toEqual([true, true, true]);
  expect(errors).toEqual([]);
});
