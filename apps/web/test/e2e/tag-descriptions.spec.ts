/**
 * A tag's AI description (A1677) on the Tags page, with a stubbed provider
 * (support/fake-bridge.ts, which answers a tag's prompt with “Notes about #tag.”): without a
 * provider, Generate points to Settings → AI Descriptions; Settings shows the Tag Prompt; a row's
 * Generate AI Description sends the tag prompt with the tag's notes and the other tags on them,
 * writes the answer, and its toast's Undo puts back what was there; Generate All asks first,
 * saying how many tags and that each goes to the provider, then describes them with progress.
 */
import { expect, test, type Page } from './fixtures';
import { collectErrors } from './support/app';

test.use({
  ai: true,
  seed: {
    name: 'Work',
    notes: [
      { title: 'Beds', markdown: 'Raised beds for tomatoes #garden #summer' },
      { title: 'Seeds', markdown: 'Order the seeds #garden/seeds' },
      { title: 'Roadmap', markdown: 'Plans for #project this month' },
    ],
  },
});

const tagsPage = (page: Page) => page.getByTestId('tags-page');
const work = (page: Page) => tagsPage(page).getByRole('region', { name: 'Work', exact: true });
const row = (page: Page, tag: string) => work(page).locator(`.tags-row[data-tag="${tag}"]`);
const shown = (page: Page, tag: string) =>
  row(page, tag).locator('.tags-desc-view .tags-desc-line');
const calls = (page: Page) =>
  page.evaluate(() => (window as unknown as { __aiCalls: string[] }).__aiCalls);

async function openTags(page: Page) {
  await page.goto('/tags');
  await expect(row(page, 'garden')).toBeVisible({ timeout: 30_000 });
}

test('Generate AI Description writes one tag’s description; Generate All asks, then the rest', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const errors = collectErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });

  // No provider yet: Generate points to Settings, and nothing is sent.
  await openTags(page);
  await page.getByTestId(`tag-more-garden`).first().click();
  await page.getByRole('menuitem', { name: 'Generate AI Description' }).click();
  const choose = page.getByTestId('choose-ai-provider');
  await expect(choose.getByRole('heading')).toHaveText('Choose an AI Provider');
  await choose.getByRole('link', { name: 'Open Settings' }).click();
  await expect(page).toHaveURL(/\/settings\/ai-descriptions$/);
  expect(await calls(page)).toEqual([]);

  // Settings → AI Descriptions shows the tag prompt, with its tokens, beside the note prompt.
  const settings = page.getByTestId('ai-descriptions-settings');
  await expect(settings.getByTestId('ai-prompt-setting')).toContainText('Note Prompt');
  const tagPrompt = settings.getByTestId('ai-tag-prompt-setting');
  await expect(tagPrompt).toContainText('Tag Prompt');
  await expect(settings.getByTestId('ai-tag-prompt')).toHaveValue(/Tag: #\{\{tag\}\}/);
  for (const token of ['tag', 'notes', 'tags', 'count', 'notebook', 'description', 'date']) {
    await expect(settings.getByTestId(`ai-tag-token-${token}`)).toHaveText(`{{${token}}}`);
  }
  await expect(settings.getByTestId('ai-reset-tag-prompt')).toBeDisabled();
  await settings.getByTestId('ai-provider').selectOption('claude-code');
  await expect(settings.getByTestId('ai-claude-code-status')).toContainText('signed in');

  // One tag: the prompt names the tag, its notes and the other tags on them.
  await openTags(page);
  await page.getByTestId('tag-more-garden').first().click();
  await page.getByRole('menuitem', { name: 'Generate AI Description' }).click();
  await expect(shown(page, 'garden')).toHaveText('Notes about #garden.');
  await expect(page.getByTestId('tag-done-toast')).toContainText('Wrote a description of #garden.');
  const sent = await calls(page);
  expect(sent).toHaveLength(1);
  expect(sent[0]).toContain('claude-code|haiku|');
  expect(sent[0]).toContain('Tag: #garden\n');
  expect(sent[0]).toContain('Notebook: Work\n');
  expect(sent[0]).toContain('Notes with it: 2\n');
  expect(sent[0]).toContain('Other tags on these notes: #garden/seeds (1), #summer (1)');
  expect(sent[0]).toContain('- Beds: Raised beds for tomatoes');
  expect(sent[0]).toContain('- Seeds: Order the seeds');
  expect(sent[0]).not.toContain('Roadmap');

  // It can be edited afterwards, as any description; Undo puts back what was there.
  await page.getByTestId('tag-undo').click();
  await expect(page.getByTestId('tag-undone-toast')).toHaveText(
    'The description of #garden is as it was.',
  );
  await expect(row(page, 'garden').locator('.tags-desc-view')).toHaveAttribute('data-empty', '');
  await page.getByTestId('tag-more-garden').first().click();
  await page.getByRole('menuitem', { name: 'Generate AI Description' }).click();
  await expect(shown(page, 'garden')).toHaveText('Notes about #garden.');
  await row(page, 'garden').locator('.tags-desc-view').click();
  const field = row(page, 'garden').getByRole('textbox', { name: 'Description of #garden' });
  await field.fill('Notes about #garden, and the shed.');
  await expect(row(page, 'garden').getByTestId('tags-save')).toHaveText('Saved');
  await page.keyboard.press('Escape');
  await expect(shown(page, 'garden')).toHaveText('Notes about #garden, and the shed.');

  // Generate All: asks first, how many and that each goes to the provider; nothing sent yet.
  await page.getByTestId('tags-generate-all').click();
  const dialog = page.getByTestId('generate-tags');
  await expect(dialog.getByRole('heading')).toHaveText('Generate All Tag Descriptions?');
  // garden/seeds, project, summer (garden has one, and the Personal notebook has no tags).
  await expect(dialog.getByTestId('generate-tags-count')).toHaveText(
    '3 tags have no description. Each goes to your AI provider with its notes’ titles and descriptions, two at a time.',
  );
  await dialog.getByTestId('generate-tags-replace').check();
  await expect(dialog.getByRole('button', { name: 'Generate 4 Descriptions' })).toBeVisible();
  await dialog.getByTestId('generate-tags-replace').uncheck();
  expect(await calls(page)).toHaveLength(2);
  await dialog.getByRole('button', { name: 'Generate 3 Descriptions' }).click();
  await expect(dialog.getByTestId('generate-tags-progress')).toHaveText('Generated 3 of 3.');
  await dialog.getByRole('button', { name: 'Close' }).click();
  await expect(dialog).toBeHidden();
  await expect(shown(page, 'garden/seeds')).toHaveText('Notes about #garden/seeds.');
  await expect(shown(page, 'project')).toHaveText('Notes about #project.');
  await expect(shown(page, 'summer')).toHaveText('Notes about #summer.');
  // Its own words stay.
  await expect(shown(page, 'garden')).toHaveText('Notes about #garden, and the shed.');
  expect(await calls(page)).toHaveLength(5);

  // Nothing left without a description: Generate All says so and sends nothing.
  await page.getByTestId('tags-generate-all').click();
  await expect(dialog.getByTestId('generate-tags-count')).toHaveText(
    'Every tag has a description already.',
  );
  await expect(dialog.getByRole('button', { name: 'Generate 0 Descriptions' })).toBeDisabled();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  expect(await calls(page)).toHaveLength(5);
  expect(errors).toEqual([]);
});
