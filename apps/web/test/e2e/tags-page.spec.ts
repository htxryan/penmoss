import { expect, seeded, test, type Page } from './fixtures';
import { readAsAgent, syncNow } from './support/sync';

// PEN-68 and finding 8 of Ryan's review of #192 (design "Tags D"): the Tags page. One compact
// table per notebook, a tag and its note count on the left and what it means on the right, with
// a filter at the top. A description saves as it is typed into the notebook's WorkspaceDoc and
// its row says Saving…, then Saved; once pushed, an agent's describe_tags reads it. Tags are
// managed there too: rename in place (Undo in the toast), merge (one dialog, from a row or the
// selection), and delete (confirmed, with Undo). A tag's name opens Search on its notes.

test.use({
  seed: {
    name: 'Work',
    notes: [
      { title: 'Roadmap', markdown: 'Plans for #project/penmoss this month' },
      { title: 'Phone', markdown: 'The #project/penmoss/android build' },
      { title: 'Beds', markdown: 'Raised beds #garden' },
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

const tagsPage = (page: Page) => page.getByTestId('tags-page');
type Scope = ReturnType<typeof tagsPage>;
const section = (page: Page, name: string) =>
  tagsPage(page).getByRole('region', { name, exact: true });
const row = (scope: Scope, tag: string) => scope.locator(`.tags-row[data-tag="${tag}"]`);
/** A tag's description field, opened for editing (it shows one line until chosen). */
async function description(scope: Scope, tag: string) {
  const field = row(scope, tag).getByRole('textbox', { name: `Description of #${tag}` });
  if ((await field.count()) === 0) await row(scope, tag).locator('.tags-desc-view').click();
  await expect(field).toBeFocused();
  return field;
}
/** What a tag's description shows when it is not being edited. */
const shownDescription = (scope: Scope, tag: string) =>
  row(scope, tag).locator('.tags-desc-view .tags-desc-line');
const tagNames = (scope: Scope) => scope.locator('.tags-row[data-tag]');

test('the Tags page describes each tag, per notebook, and agents read the descriptions', async ({
  page,
  host,
  notebook,
}) => {
  test.setTimeout(120_000);
  const errors = collectErrors(page);
  // A second notebook, with a tag of its own.
  await host.seed({ name: 'Personal', notes: [{ title: 'Books', markdown: 'Read #reading' }] });
  await page.goto('/');
  const pane = page.getByTestId('tag-pane');
  await expect(pane.getByRole('button', { name: /^#garden, 1 note$/ })).toBeVisible({
    timeout: 30_000,
  });
  // The sidebar's tag opens Search on its notes, starting on the notebook the tag is in, with the
  // sidebar's Notes section left as it is (finding 9 of the #192 review).
  await pane.getByRole('button', { name: /^#garden, 1 note$/ }).click();
  const fromPane = page.getByTestId('search');
  await expect(fromPane.getByTestId('search-notebook').locator('option:checked')).toHaveText(
    'Work',
  );
  await expect(fromPane.locator('.search-hit')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(fromPane).toBeHidden();

  // Opened from the Tags section's title row.
  await pane.getByTestId('tag-pane-toggle').hover();
  const open = pane.getByRole('link', { name: 'Open the Tags Page' });
  await expect(open).toBeVisible();
  await open.click();
  await expect(page).toHaveURL(/\/tags$/);
  await expect(tagsPage(page).getByRole('heading', { name: 'Tags', level: 2 })).toBeVisible();

  // One table per notebook, in the sidebar's order: a row per tag, each with its note count.
  const work = section(page, 'Work');
  const personal = section(page, 'Personal');
  await expect(work).toBeVisible();
  await expect(personal).toBeVisible();
  await expect(tagsPage(page).getByRole('heading', { level: 3 })).toHaveText(['Work', 'Personal']);
  await expect(tagNames(work)).toHaveCount(4);
  await expect(work.locator('.tags-row[data-tag] .tags-name')).toHaveText([
    '#garden',
    '#project',
    '#project/penmoss',
    '#project/penmoss/android',
  ]);
  await expect(row(work, 'project').locator('.tags-count-cell')).toHaveText('2');
  await expect(row(work, 'project/penmoss/android').locator('.tags-count-cell')).toHaveText('1');
  await expect(row(personal, 'reading')).toBeVisible();
  await expect(row(personal, 'garden')).toHaveCount(0);

  // A description saves as it is typed, several lines, says so, and stays after a reload.
  const penmoss = await description(work, 'project/penmoss');
  await page.keyboard.type('The notes app itself.');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Ship notes for it go here.');
  const saved = row(work, 'project/penmoss').getByTestId('tags-save');
  await expect(saved).toHaveText('Saved');
  await expect(penmoss).toHaveValue('The notes app itself.\nShip notes for it go here.');
  await (await description(work, 'project')).fill('Work with an end.');
  await (await description(personal, 'reading')).fill('Books to read.');
  await page.keyboard.press('Escape');
  // Read-only, a description shows its first line.
  await expect(shownDescription(work, 'project/penmoss')).toHaveText('The notes app itself. …');
  await expect(row(personal, 'reading').getByTestId('tags-save')).toHaveText('Saved');
  await page.reload();
  await expect(shownDescription(section(page, 'Work'), 'project/penmoss')).toHaveText(
    'The notes app itself. …',
    { timeout: 30_000 },
  );
  await expect(await description(section(page, 'Work'), 'project/penmoss')).toHaveValue(
    'The notes app itself.\nShip notes for it go here.',
  );
  await expect(shownDescription(section(page, 'Personal'), 'reading')).toHaveText('Books to read.');

  // The filter narrows each table, by name and by description.
  const filter = page.getByTestId('tags-filter');
  await filter.fill('penmoss');
  await expect(tagNames(section(page, 'Work'))).toHaveCount(2);
  await expect(section(page, 'Work').getByTestId('tags-count')).toHaveText('2 of 4 Tags');
  await expect(section(page, 'Personal').getByTestId('tags-page-none')).toHaveText(
    'No tag matches “penmoss”.',
  );
  await filter.fill('books');
  await expect(tagNames(section(page, 'Personal'))).toHaveCount(1);
  await filter.press('Escape');
  await expect(filter).toHaveValue('');
  await expect(tagNames(section(page, 'Work'))).toHaveCount(4);

  // An agent on its own clone reads them, with the parent's as context, once they are pushed.
  // Sync Now acts on the open note's notebook when there are several (Work's here).
  await page.goto(`/notes/${seeded(notebook).noteIds[0]}`);
  await syncNow(page);
  const described = await readAsAgent(host, seeded(notebook).remote, (local) =>
    local.describeTags(['project/penmoss']),
  );
  expect(described.tags[0]).toEqual({
    name: 'project/penmoss',
    description: 'The notes app itself.\nShip notes for it go here.',
    notes: 2,
    ancestors: [{ name: 'project', description: 'Work with an end.' }],
  });

  // Emptied, the description goes.
  await page.goto('/tags');
  await (await description(section(page, 'Work'), 'project')).fill('');
  await page.keyboard.press('Escape');
  await expect(shownDescription(section(page, 'Work'), 'project')).toHaveText('Add a description');

  // A tag's name opens Search on its notes, as the sidebar's tag does, on its notebook (finding 9
  // of the #192 review); so does Show Notes in its ⋯ menu.
  await row(section(page, 'Work'), 'garden')
    .getByRole('button', { name: '#garden', exact: true })
    .click();
  const search = page.getByTestId('search');
  await expect(search.getByTestId('search-notebook').locator('option:checked')).toHaveText('Work');
  await expect(search.getByRole('combobox', { name: 'Tag' })).toHaveValue('garden');
  await expect(search.locator('.search-hit')).toHaveCount(1);
  await expect(search.locator('.search-hit')).toContainText('Beds');
  await page.keyboard.press('Escape');
  await expect(search).toBeHidden();
  await expect(page).toHaveURL(/\/tags$/);
  await row(section(page, 'Personal'), 'reading')
    .getByRole('button', { name: 'More Actions for #reading' })
    .click();
  await page.getByRole('menuitem', { name: 'Show Notes' }).click();
  await expect(search.getByRole('combobox', { name: 'Tag' })).toHaveValue('reading');
  await expect(search.locator('.search-hit')).toContainText('Books');
  await page.keyboard.press('Escape');

  // The palette opens it too.
  await page.goto(`/notes/${seeded(notebook).noteIds[2]}`);
  await page.getByRole('button', { name: 'Commands', exact: true }).click();
  const palette = page.getByRole('dialog', { name: 'Command Palette' });
  await palette.getByRole('combobox', { name: 'Command Palette' }).fill('Tags');
  await expect(palette.getByRole('option').first()).toContainText('Tags');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/tags$/);
  await expect(shownDescription(section(page, 'Work'), 'project/penmoss')).toHaveText(
    'The notes app itself. …',
  );
  expect(errors).toEqual([]);
});

test.describe('managing tags', () => {
  test.use({
    seed: {
      name: 'Work',
      notes: [
        { title: 'Workers', markdown: 'Deploy with #cf and #dev' },
        { title: 'Buckets', markdown: 'R2 #cf and #cloudflare' },
        { title: 'Tables', markdown: 'D1 #cloudflare' },
        { title: 'Build', markdown: 'CI #development #dev-notes' },
        { title: 'Review', markdown: 'Round two #penmoss #penmoss/review' },
        { title: 'Factory', markdown: 'Runs #penmoss/factory' },
        { title: 'Beds', markdown: 'Raised beds #garden' },
      ],
    },
  });

  test('rename in place, merge from a row and from the selection, and delete, each with Undo', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const errors = collectErrors(page);
    await page.goto('/tags');
    const work = section(page, 'Work');
    await expect(row(work, 'garden')).toBeVisible({ timeout: 30_000 });
    const toast = page.getByTestId('tag-done-toast');
    const strip = work.getByTestId('tags-rename-strip');
    const more = async (tag: string, item: string) => {
      await row(work, tag)
        .getByRole('button', { name: `More Actions for #${tag}` })
        .click();
      await page.getByRole('menuitem', { name: item }).click();
    };

    // Rename in place: Return renames at once, no confirm; the toast offers Undo.
    await (await description(work, 'garden')).fill('Beds and seeds');
    await page.keyboard.press('Escape');
    await more('garden', 'Rename…');
    const name = work.getByRole('textbox', { name: 'New name for #garden' });
    await expect(name).toBeFocused();
    await expect(strip).toContainText('Renames it in 1 note.');
    await name.fill('gardening');
    await name.press('Enter');
    await expect(toast).toContainText('Renamed #garden to #gardening in 1 note.');
    await expect(row(work, 'gardening')).toBeVisible();
    await expect(row(work, 'garden')).toHaveCount(0);
    // Its description went with it.
    await expect(shownDescription(work, 'gardening')).toHaveText('Beds and seeds');
    await toast.getByRole('button', { name: 'Undo' }).click();
    await expect(row(work, 'garden')).toBeVisible();
    await expect(row(work, 'gardening')).toHaveCount(0);
    await expect(shownDescription(work, 'garden')).toHaveText('Beds and seeds');
    await expect(page.getByTestId('tag-undone-toast')).toBeVisible();

    // F2 on a row renames too; a name that exists offers a merge, with the counts.
    await row(work, 'cf').locator('.tags-check').focus();
    await page.keyboard.press('F2');
    const cfName = work.getByRole('textbox', { name: 'New name for #cf' });
    await cfName.fill('cloudflare');
    await cfName.press('Enter');
    await expect(strip).toContainText(
      '#cloudflare already exists (2 notes). Merge #cf into it? 3 notes end up with #cloudflare; 1 already has both.',
    );
    // Nothing changed yet.
    await expect(row(work, 'cf')).toBeVisible();
    await strip.getByRole('button', { name: 'Merge Into #cloudflare' }).click();
    // The same Merge dialog as the top Merge…, with #cloudflare picked.
    const merge = page.getByTestId('tags-merge-dialog');
    await expect(merge.getByRole('heading', { name: 'Merge #cf Into…' })).toBeVisible();
    await expect(merge.getByRole('radio', { name: /#cloudflare/ })).toBeChecked();
    await expect(merge.getByTestId('tags-merge-preview')).toHaveText(
      '#cf will be merged into #cloudflare: 1 note retagged, 1 already had #cloudflare. #cf is gone.',
    );
    await merge.getByRole('button', { name: 'Merge Tags' }).click();
    await expect(merge).toBeHidden();
    await expect(toast).toContainText('Merged #cf into #cloudflare in 2 notes.');
    await expect(row(work, 'cf')).toHaveCount(0);
    await expect(row(work, 'cloudflare').locator('.tags-count-cell')).toHaveText('3');

    // Several selected: only Merge… and Delete… at the top; pick the one to keep.
    await row(work, 'dev').getByRole('checkbox', { name: 'Select #dev' }).check();
    const actions = work.getByRole('group', { name: 'Selected Tags' });
    await expect(actions.getByRole('button', { name: 'Rename…' })).toBeVisible();
    await row(work, 'dev-notes').getByRole('checkbox', { name: 'Select #dev-notes' }).check();
    await row(work, 'development').getByRole('checkbox', { name: 'Select #development' }).check();
    await expect(actions).toContainText('3 Selected');
    await expect(actions.getByRole('button', { name: 'Rename…' })).toHaveCount(0);
    await actions.getByRole('button', { name: 'Merge…' }).click();
    await expect(merge.getByRole('heading', { name: 'Merge 3 Tags' })).toBeVisible();
    await merge.getByRole('radio', { name: /#development/ }).check();
    await expect(merge.getByTestId('tags-merge-preview')).toContainText(
      '#dev and #dev-notes will be merged into #development: 1 note retagged, 1 already had #development.',
    );
    await merge.getByRole('button', { name: 'Merge Tags' }).click();
    await expect(toast).toContainText('Merged #dev and #dev-notes into #development in 2 notes.');
    await expect(row(work, 'dev')).toHaveCount(0);
    await expect(row(work, 'dev-notes')).toHaveCount(0);
    await expect(row(work, 'development').locator('.tags-count-cell')).toHaveText('2');
    await expect(actions).toHaveCount(0);

    // Renaming a parent offers to rename the tags inside it; left off, they stay.
    await more('penmoss', 'Rename…');
    const parent = work.getByRole('textbox', { name: 'New name for #penmoss' });
    await parent.fill('app');
    await expect(strip).toContainText('#penmoss/factory → #app/factory');
    await expect(strip).toContainText('Renames 3 tags in 2 notes.');
    await strip.getByRole('checkbox', { name: /Also rename the 2 tags inside it/ }).uncheck();
    await expect(strip).toContainText('Renames it in 1 note.');
    await strip.getByRole('button', { name: 'Rename Tag' }).click();
    await expect(toast).toContainText('Renamed #penmoss to #app in 1 note.');
    await expect(row(work, 'app')).toBeVisible();
    await expect(row(work, 'penmoss/review')).toBeVisible();
    await expect(row(work, 'penmoss/factory')).toBeVisible();

    // Delete confirms, then offers Undo; the notes stay.
    await more('garden', 'Delete…');
    const remove = page.getByTestId('tags-delete-dialog');
    await expect(remove.getByRole('heading', { name: 'Delete #garden' })).toBeVisible();
    await expect(remove).toContainText('Removes #garden from 1 note. The notes stay');
    await remove.getByRole('button', { name: 'Delete Tag' }).click();
    await expect(toast).toContainText('Deleted #garden from 1 note.');
    await expect(row(work, 'garden')).toHaveCount(0);
    await toast.getByRole('button', { name: 'Undo' }).click();
    await expect(row(work, 'garden')).toBeVisible();
    await expect(shownDescription(work, 'garden')).toHaveText('Beds and seeds');

    // The note's text kept its word through the delete and has its tag back after Undo.
    await row(work, 'garden').getByRole('button', { name: '#garden', exact: true }).click();
    const search = page.getByTestId('search');
    await expect(search.locator('.search-hit')).toContainText('Beds');
    await page.keyboard.press('Escape');
    expect(errors).toEqual([]);
  });
});

test.describe('with no tags', () => {
  test.use({ seed: { name: 'Work', notes: [{ title: 'Plain', markdown: 'No tags here' }] } });

  test('the Tags page says when there are none', async ({ page }) => {
    await page.goto('/tags');
    await expect(page.getByTestId('tags-page')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('tags-page-empty')).toContainText('No tags yet');
  });
});
