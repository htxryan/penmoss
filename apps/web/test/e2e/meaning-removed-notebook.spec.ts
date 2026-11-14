import { expect, test, type Page } from './fixtures';

// Search by meaning forgets a removed notebook (A1373): Settings → Notebooks removes one from
// this Mac, and the stand-in Mac's embedding service (MeaningService, support/meaning-host.ts)
// drops its notes from "All N notes are indexed" and from the keys compaction keeps.

test.use({
  meaning: true,
  seed: {
    name: 'Notes',
    notes: [
      { title: 'Server room', markdown: 'The UPS battery holds for twenty minutes.' },
      { title: 'Sourdough', markdown: 'Feed the starter, knead the dough, bake the loaf.' },
      { title: 'Japan trip', markdown: 'Shrines in Kyoto, and the rail pass.' },
      { title: 'Taxes', markdown: 'The receipts are in the blue folder.' },
    ],
  },
});

/** Goes to a path inside the app, as a link does (no reload). */
const go = (page: Page, path: string) =>
  page.evaluate((to) => {
    window.history.pushState(null, '', to);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, path);

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(error.message));
  return errors;
}

test('a removed notebook leaves Search by Meaning’s count (A1373)', async ({ page, host }) => {
  test.setTimeout(120_000);
  const errors = collectErrors(page);
  // A second notebook beside the seeded one.
  await host.seed({
    name: 'Work',
    notes: [
      { title: 'Parser', markdown: 'The grammar of the query language.' },
      { title: 'Release', markdown: 'Tag the build and write the notes.' },
    ],
  });
  await page.goto('/');
  const status = () =>
    page.evaluate(async () => {
      const now = await window.penmossDesktop?.meaning?.status();
      return now ? `${now.indexed}/${now.total}` : null;
    });
  await expect.poll(status, { timeout: 40_000 }).toBe('6/6');
  // From here on, in the app as a link goes (a reload would start the page afresh).
  await go(page, '/settings/meaning');
  const row = page.getByTestId('meaning-settings');
  await expect(row.getByTestId('meaning-status')).toContainText('All 6 notes are indexed.');
  await page.waitForTimeout(1_000);

  // Settings → Notebooks removes Work from this Mac.
  await go(page, '/settings/git-notebooks');
  await expect(page.getByTestId('git-notebook-row')).toHaveCount(2);
  await page.getByTestId('git-notebook-row').filter({ hasText: 'Work' }).click();
  const card = page
    .getByTestId('git-notebook')
    .filter({ has: page.getByRole('heading', { name: 'Work' }) });
  await card.getByTestId('git-remove').click();
  const confirm = card.getByTestId('git-remove-confirm');
  if (await confirm.isVisible()) await confirm.getByTestId('git-remove-anyway').click();
  await expect(page.getByTestId('git-notebook-row')).toHaveCount(1, { timeout: 20_000 });

  // The service forgot it: its two notes leave the count.
  await expect.poll(status, { timeout: 10_000 }).toBe('4/4');
  await go(page, '/settings/meaning');
  await expect(row.getByTestId('meaning-status')).toContainText('All 4 notes are indexed.');
  await row.scrollIntoViewIfNeeded();
  await page.waitForTimeout(2_000);
  await expect(row.getByTestId('meaning-status')).toContainText('All 4 notes are indexed.');
  expect(errors).toEqual([]);
});
