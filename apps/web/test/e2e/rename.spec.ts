import { expect, test, type Page } from './fixtures';

// Rename a git notebook (Ryan's review of PR #192): from its row's menu in the sidebar, in place,
// and from its page in Settings → Notebooks. The name goes to `notebook.json` at the next sync,
// so every device follows; a name another notebook on this Mac has is warned about, with a free
// one offered. Another device's rename is followed here too.

test.use({ seed: { name: 'Notes', notes: [{ title: 'First', markdown: 'one' }] } });

/** A notebook's section of the sidebar: a region named for it. */
const section = (page: Page, name: string) =>
  page.getByTestId('source-section').and(page.getByRole('region', { name, exact: true }));

/** `notebook.json`'s name at the head of a bare repository on this machine. */
const nameAtHead = (host: { git(cwd: string, args: readonly string[]): string }, remote: string) =>
  (
    JSON.parse(
      host.git(remote.replace(/^file:\/\//, ''), ['show', 'main:.penmoss/notebook.json']),
    ) as { name: string }
  ).name;

test('renames a notebook from its row, warns of a name in use, and pushes the name', async ({
  page,
  host,
}) => {
  test.setTimeout(120_000);
  const work = await host.seed({ name: 'Work', notes: [{ title: 'Second', markdown: 'two' }] });
  await page.goto('/');
  await expect(section(page, 'Work').getByTestId('section-sync')).toHaveAttribute(
    'data-state',
    'synced',
    { timeout: 40_000 },
  );

  // Its row's menu: Rename Notebook edits the name in place, and says what it does.
  await section(page, 'Work').locator('.sb-section-head').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Rename Notebook' }).click();
  const input = page.getByTestId('notebook-rename-input');
  await expect(input).toBeFocused();
  await expect(page.getByTestId('notebook-rename-hint')).toHaveText(
    'Renames it on every device that syncs it.',
  );
  // A name the other notebook here has (any case): warned, with a free one offered.
  await input.fill('notes');
  await input.press('Enter');
  const clash = page.getByTestId('notebook-name-clash');
  await expect(clash).toContainText('Another notebook on this Mac is named “Notes”');
  await clash.getByRole('button', { name: 'Use “notes (2)”' }).click();
  await expect(section(page, 'notes (2)')).toBeVisible();
  await expect(section(page, 'Notes')).toBeVisible();

  // Pushed at once: notebook.json at the branch has the new name.
  await expect.poll(() => nameAtHead(host, work.remote), { timeout: 40_000 }).toBe('notes (2)');
});

test('renames from Settings, and follows a rename made on another device', async ({
  page,
  host,
  notebook,
}) => {
  test.setTimeout(120_000);
  const seeded = notebook!;
  await page.goto(`/settings/git-notebooks/${seeded.info.notebookId}`);
  const field = page.getByTestId('git-notebook-name');
  await expect(field).toHaveValue('Notes');
  await expect(page.getByText('Renames it on every device that syncs it.')).toBeVisible();
  await field.fill('Personal (old)');
  await page.getByTestId('git-notebook-rename').click();
  await expect(page.getByTestId('git-rename-message')).toHaveText(
    'Renamed to “Personal (old)” on every device that syncs it.',
  );
  await expect(page.getByRole('heading', { name: 'Personal (old)', level: 2 })).toBeVisible();
  await expect
    .poll(() => nameAtHead(host, seeded.remote), { timeout: 40_000 })
    .toBe('Personal (old)');

  // Another device renames it: this Mac follows at its next sync.
  const phone = await host.writer(seeded.info);
  await phone.engine.sync();
  phone.engine.rename('From the Phone');
  await phone.engine.sync();
  await page.getByTestId('git-sync-now').click();
  await expect(page.getByRole('heading', { name: 'From the Phone', level: 2 })).toBeVisible({
    timeout: 40_000,
  });
  await expect(field).toHaveValue('From the Phone');
});
