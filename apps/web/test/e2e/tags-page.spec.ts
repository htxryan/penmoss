import { expect, seeded, test, type Page } from './fixtures';
import { readAsAgent, syncNow } from './support/sync';

// PEN-68: the Tags page. Every tag as a tree with its note count and a description that saves as
// it is typed into the notebook's WorkspaceDoc, one section per notebook; opened from the Tags
// section's title row and the palette; a tag's name opens Search on its notes, as the sidebar's
// tag does. Once pushed, an agent's describe_tags reads the description.

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
const section = (page: Page, name: string) =>
  tagsPage(page).getByRole('region', { name, exact: true });
const description = (scope: ReturnType<typeof tagsPage>, tag: string) =>
  scope.getByRole('textbox', { name: `Description of #${tag}`, exact: true });

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

  // One section per notebook, in the sidebar's order, each its own tree with counts.
  const work = section(page, 'Work');
  const personal = section(page, 'Personal');
  await expect(work).toBeVisible();
  await expect(personal).toBeVisible();
  await expect(tagsPage(page).getByRole('heading', { level: 3 })).toHaveText(['Work', 'Personal']);
  await expect(work.getByRole('button', { name: '#project, 2 notes', exact: true })).toBeVisible();
  await expect(
    work.getByRole('button', { name: '#project/penmoss/android, 1 note', exact: true }),
  ).toBeVisible();
  await expect(
    personal.getByRole('button', { name: '#reading, 1 note', exact: true }),
  ).toBeVisible();
  // Nested under its parent.
  await expect(
    work.locator(
      '[data-tag="project"] [data-tag="project/penmoss"] [data-tag="project/penmoss/android"]',
    ),
  ).toHaveCount(1);
  await expect(personal.locator('[data-tag="garden"]')).toHaveCount(0);

  // A description saves as it is typed, several lines, and stays after a reload.
  const penmoss = description(work, 'project/penmoss');
  await penmoss.click();
  await page.keyboard.type('The notes app itself.');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Ship notes for it go here.');
  await description(work, 'project').fill('Work with an end.');
  await description(personal, 'reading').fill('Books to read.');
  await description(personal, 'reading').blur();
  await page.reload();
  await expect(description(section(page, 'Work'), 'project/penmoss')).toHaveValue(
    'The notes app itself.\nShip notes for it go here.',
    { timeout: 30_000 },
  );
  await expect(description(section(page, 'Personal'), 'reading')).toHaveValue('Books to read.');

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
  await description(section(page, 'Work'), 'project').fill('');

  // A tag's name opens Search on its notes, as the sidebar's tag does, on its notebook (finding 9
  // of the #192 review).
  await section(page, 'Work').getByRole('button', { name: '#garden, 1 note', exact: true }).click();
  const search = page.getByTestId('search');
  await expect(search.getByTestId('search-notebook').locator('option:checked')).toHaveText('Work');
  await expect(search.getByRole('combobox', { name: 'Tag' })).toHaveValue('garden');
  await expect(search.locator('.search-hit')).toHaveCount(1);
  await expect(search.locator('.search-hit')).toContainText('Beds');
  await page.keyboard.press('Escape');
  await expect(search).toBeHidden();
  await expect(page).toHaveURL(/\/tags$/);

  // The palette opens it too.
  await page.goto(`/notes/${seeded(notebook).noteIds[2]}`);
  await page.getByRole('button', { name: 'Commands', exact: true }).click();
  const palette = page.getByRole('dialog', { name: 'Command Palette' });
  await palette.getByRole('combobox', { name: 'Command Palette' }).fill('Tags');
  await expect(palette.getByRole('option').first()).toContainText('Tags');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/tags$/);
  const field = description(section(page, 'Work'), 'project/penmoss');
  await expect(field).toHaveValue('The notes app itself.\nShip notes for it go here.');
  await expect(description(section(page, 'Work'), 'project')).toHaveValue('');
  // Held on the page for the proof's recording.
  await field.scrollIntoViewIfNeeded();
  await page.waitForTimeout(2_000);
  await expect(field).toBeVisible();
  expect(errors).toEqual([]);
});

test.describe('with no tags', () => {
  test.use({ seed: { name: 'Work', notes: [{ title: 'Plain', markdown: 'No tags here' }] } });

  test('the Tags page says when there are none', async ({ page }) => {
    await page.goto('/tags');
    await expect(page.getByTestId('tags-page')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('tags-page-empty')).toContainText('No tags yet');
  });
});
