/**
 * AI Descriptions (PEN-161) in the app, with a stubbed provider (support/fake-bridge.ts): the
 * Metadata tab in layout A, choosing a provider and turning it on in Settings, Describe Now
 * writing the description, a hand edit asking Keep Mine or Let Claude Update It, Settings'
 * Describe All Notes, and the description under the title once Settings → Note shows it.
 */
import { expect, type Page, test } from './fixtures';
import { collectErrors, newNote } from './support/app';

test.use({ ai: true });

const RUN = Date.now().toString(36);
const info = (page: Page) => page.getByRole('complementary', { name: 'Metadata' });
const calls = (page: Page) =>
  page.evaluate(() => (window as unknown as { __aiCalls: string[] }).__aiCalls.length);

async function setUp(page: Page) {
  await page.goto('/settings/ai-descriptions');
  const settings = page.getByTestId('ai-descriptions-settings');
  await expect(settings).toBeVisible();
  await expect(settings.getByTestId('ai-provider')).toHaveValue('none');
  await expect(settings.getByTestId('ai-via')).toContainText('nothing is sent');
  await settings.getByTestId('ai-provider').selectOption('claude-code');
  await expect(settings.getByTestId('ai-claude-code-status')).toContainText('signed in');
  await settings.getByTestId('ai-global').getByText('On', { exact: true }).click();
}

test('the Metadata tab: Tags, Description with AI Description, Details, Backlinks', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await newNote(page, `Layout ${RUN}`, 'Some text.');
  const panel = info(page);
  await expect(panel).toBeVisible();
  const headings = await panel
    .locator('.info-heading, .info-subheading, .info-subsub, .bl-heading')
    .allInnerTexts();
  expect(headings.map((text) => text.trim().toLowerCase())).toEqual([
    'metadata',
    'tags',
    'description',
    'ai description',
    'details',
    expect.stringMatching(/backlinks/),
  ]);
  // Off by default, from Settings: nothing is sent and Describe Now waits for a provider.
  await expect(panel.getByTestId('ai-effective')).toContainText('Off');
  await expect(panel.getByTestId('ai-source')).toContainText('Everywhere');
  await expect(panel.getByTestId('ai-describe-now')).toBeDisabled();
  expect(await calls(page)).toBe(0);
  expect(errors).toEqual([]);
});

test('Describe Now writes the description; a hand edit asks first', async ({ page }) => {
  const errors = collectErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await setUp(page);
  await page.goto('/');
  await newNote(page, `Groceries ${RUN}`, 'Milk, eggs and bread.');
  const panel = info(page);
  await expect(panel.getByTestId('ai-effective')).toContainText('On');
  await panel.getByTestId('ai-describe-now').click();
  await expect(panel.getByTestId('ai-description')).toHaveValue(`A note about Groceries ${RUN}.`);
  await expect(panel.getByTestId('ai-description-by')).toHaveText('Written by AI Descriptions');
  await expect(panel.getByTestId('ai-status')).toContainText('Described');
  // Describe Now and Clear are equal side by side (PEN-182).
  const describeNow = (await panel.getByTestId('ai-describe-now').boundingBox())!;
  const clear = (await panel.getByTestId('ai-clear').boundingBox())!;
  expect(Math.abs(describeNow.width - clear.width)).toBeLessThanOrEqual(1);
  expect(await calls(page)).toBe(1);
  const prompt = await page.evaluate(
    () => (window as unknown as { __aiCalls: string[] }).__aiCalls[0],
  );
  expect(prompt).toContain('claude-code|haiku|');
  expect(prompt).toContain('Milk, eggs and bread.');

  // Written by hand: kept, and asked about while AI Descriptions is on.
  const field = panel.getByTestId('ai-description');
  await field.fill('My shopping list.');
  await field.press('Enter');
  await expect(panel.getByTestId('ai-ask')).toBeVisible();
  await expect(panel.getByTestId('ai-description-by')).toHaveText('Written by you');
  // The two answers are equal (docs/ux-conventions.md, PEN-182).
  const keep = (await panel.getByRole('button', { name: 'Keep Mine' }).boundingBox())!;
  const update = (await panel.getByRole('button', { name: 'Let Claude Update It' }).boundingBox())!;
  expect(Math.abs(keep.width - update.width)).toBeLessThanOrEqual(1);
  await panel.getByRole('button', { name: 'Keep Mine' }).click();
  await expect(panel.getByTestId('ai-ask')).toHaveCount(0);
  await expect(panel.getByRole('radio', { name: 'Off' })).toBeChecked();
  await expect(panel.getByTestId('ai-effective')).toContainText('Off');
  await expect(field).toHaveValue('My shopping list.');

  // Clear removes it.
  await panel.getByTestId('ai-clear').click();
  await expect(field).toHaveValue('');
  expect(errors).toEqual([]);
});

test('Settings → Describe All Notes counts, asks, then describes every note that wants it', async ({
  page,
}) => {
  const errors = collectErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await newNote(page, `Plans ${RUN}`, 'Book the train.');
  await newNote(page, `Ideas ${RUN}`, 'A garden shed.');
  await page.goto('/settings/ai-descriptions');
  const settings = page.getByTestId('ai-descriptions-settings');
  // Nothing to send with until a provider is picked.
  await expect(settings.getByTestId('ai-describe-all-setting')).toContainText('Describe All Notes');
  await expect(settings.getByTestId('ai-describe-all')).toBeDisabled();
  await setUp(page);
  const button = settings.getByTestId('ai-describe-all');
  await expect(button).toHaveText('Describe Notes Now…');
  await button.click();
  const dialog = page.getByTestId('describe-all');
  await expect(dialog.getByRole('heading')).toHaveText('Describe All Notes?');
  const count = dialog.getByTestId('describe-all-count');
  await expect(count).toContainText(/\d+ notes have no description/);
  const wanted = Number((await count.innerText()).match(/(\d+) notes/)![1]);
  expect(wanted).toBeGreaterThanOrEqual(2);
  // Nothing goes until it is confirmed.
  expect(await calls(page)).toBe(0);
  await dialog.getByRole('button', { name: `Describe ${wanted} Notes` }).click();
  await expect(dialog.getByTestId('describe-all-progress')).toHaveText(
    `Described ${wanted} of ${wanted}.`,
  );
  expect(await calls(page)).toBe(wanted);
  const prompts = await page.evaluate(
    () => (window as unknown as { __aiCalls: string[] }).__aiCalls,
  );
  expect(prompts.some((prompt) => prompt.includes('Book the train.'))).toBe(true);
  expect(prompts.some((prompt) => prompt.includes('A garden shed.'))).toBe(true);
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(dialog).toHaveCount(0);

  // Described now: asked again, there is nothing left to send.
  await button.click();
  await expect(dialog.getByTestId('describe-all-count')).toContainText('described already');
  await expect(dialog.getByRole('button', { name: 'Describe', exact: true })).toBeDisabled();
  expect(errors).toEqual([]);
});

test('the description shows under the title once Settings → Note shows it', async ({ page }) => {
  const errors = collectErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await setUp(page);
  await page.goto('/');
  await newNote(page, `Under ${RUN}`, 'Body.');
  const panel = info(page);
  await panel.getByTestId('ai-describe-now').click();
  await expect(panel.getByTestId('ai-description')).toHaveValue(`A note about Under ${RUN}.`);
  await expect(page.locator('.doc-meta-description')).toHaveCount(0);
  await page.goto('/settings/note');
  await page.getByRole('checkbox', { name: 'Description', exact: true }).first().check();
  await page.goBack();
  await expect(page.locator('.doc-meta-description')).toHaveText(`A note about Under ${RUN}.`);
  expect(errors).toEqual([]);
});

test.describe('the first run', () => {
  test.use({ seed: null });

  test('asks once, Not Now first; Turn On asks for a provider and checks the key', async ({
    page,
    host,
  }) => {
    test.setTimeout(90_000);
    const errors = collectErrors(page);
    await page.goto('/');
    const firstRun = page.getByTestId('first-run');
    await firstRun.getByTestId('first-run-start').click();
    await firstRun.getByTestId('first-run-continue').click();
    await firstRun.getByTestId('first-run-way-url').click();
    await firstRun.getByTestId('first-run-continue').click();
    await firstRun.getByTestId('first-run-url-input').fill(host.bare('described'));
    await firstRun.getByTestId('first-run-continue').click();
    await firstRun.getByTestId('first-run-name-input').fill('Described');
    await firstRun.getByTestId('first-run-make').click();

    const question = firstRun.getByTestId('first-run-ai');
    await expect(question).toBeVisible({ timeout: 30_000 });
    await expect(
      question.getByRole('heading', { name: 'Describe Notes for Agents?' }),
    ).toBeFocused();
    await expect(question.getByRole('radio', { name: /Not Now/ })).toBeChecked();
    await expect(question.getByTestId('first-run-continue')).toHaveText('Start Writing');
    await question.getByTestId('first-run-ai-on').click();
    await expect(question.getByTestId('first-run-continue')).toHaveText('Continue');
    await question.getByTestId('first-run-continue').click();

    const step = firstRun.getByTestId('first-run-ai-provider');
    await expect(step.getByRole('radio', { checked: true })).toHaveCount(0);
    await expect(step.getByTestId('first-run-continue')).toBeDisabled();
    await expect(step.getByTestId('first-run-continue')).toHaveText('Pick One to Continue');
    await step.getByTestId('first-run-ai-anthropic').click();
    await expect(step.getByTestId('first-run-continue')).toBeDisabled();
    await step.getByTestId('first-run-ai-key').fill('sk-ant-bad');
    await step.getByTestId('first-run-ai-check-key').click();
    await expect(step.getByTestId('first-run-ai-key-state')).toContainText('refused');
    await expect(step.getByTestId('first-run-continue')).toBeDisabled();
    await step.getByTestId('first-run-ai-key').fill('sk-ant-good');
    await step.getByTestId('first-run-ai-check-key').click();
    await expect(step.getByTestId('first-run-ai-key-state')).toContainText('accepted');
    await expect(step.getByTestId('first-run-continue')).toHaveText('Turn On and Start Writing');
    await step.getByTestId('first-run-continue').click();

    await expect(page.getByTestId('first-run')).toHaveCount(0, { timeout: 20_000 });
    await expect(page.getByTestId('note-title')).toHaveValue('Welcome to Penmoss', {
      timeout: 20_000,
    });
    await page.goto('/settings/ai-descriptions');
    const settings = page.getByTestId('ai-descriptions-settings');
    await expect(settings.getByTestId('ai-provider')).toHaveValue('anthropic');
    await expect(
      settings.getByTestId('ai-global').getByRole('radio', { name: 'On', exact: true }),
    ).toBeChecked();
    expect(errors).toEqual([]);
  });

  test('Not Now leaves it off', async ({ page, host }) => {
    test.setTimeout(90_000);
    await page.goto('/');
    const firstRun = page.getByTestId('first-run');
    await firstRun.getByTestId('first-run-start').click();
    await firstRun.getByTestId('first-run-continue').click();
    await firstRun.getByTestId('first-run-way-url').click();
    await firstRun.getByTestId('first-run-continue').click();
    await firstRun.getByTestId('first-run-url-input').fill(host.bare('later'));
    await firstRun.getByTestId('first-run-continue').click();
    await firstRun.getByTestId('first-run-name-input').fill('Later');
    await firstRun.getByTestId('first-run-make').click();
    await firstRun.getByTestId('first-run-ai').getByTestId('first-run-continue').click();
    await expect(page.getByTestId('first-run')).toHaveCount(0, { timeout: 20_000 });
    await page.goto('/settings/ai-descriptions');
    const settings = page.getByTestId('ai-descriptions-settings');
    await expect(settings.getByTestId('ai-provider')).toHaveValue('none');
    await expect(
      settings.getByTestId('ai-global').getByRole('radio', { name: 'Off', exact: true }),
    ).toBeChecked();
  });
});
