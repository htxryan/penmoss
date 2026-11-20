import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import {
  bareRepository,
  firstRunName,
  firstRunPasteUrl,
  holdForProof,
  launch,
  notebookSection,
  removeDataDirs,
  type Launched,
} from './support';

// PEN-161 in the Mac app: the first run asks "Describe Notes for Agents?" once, after Setting
// Up, with Not Now picked. Not Now leaves AI Descriptions off, and this Mac is not asked again.

const opened: Launched[] = [];

test.afterEach(async () => {
  for (const launched of opened.splice(0)) await launched.app.close().catch(() => undefined);
});
test.afterAll(() => removeDataDirs());

test('the first run asks once whether to describe notes for agents; Not Now leaves it off', async () => {
  test.setTimeout(180_000);
  const launched = await launch({ aiQuestion: 'ask' });
  opened.push(launched);
  const { page } = launched;
  await firstRunPasteUrl(page, `file://${bareRepository()}`);
  await firstRunName(page, 'Notes');
  const firstRun = page.getByTestId('first-run');
  await expect(firstRun.getByRole('heading', { name: 'Describe Notes for Agents?' })).toBeVisible({
    timeout: 60_000,
  });
  await expect(firstRun.getByTestId('first-run-ai-off')).toBeChecked();
  await holdForProof(page);
  await firstRun.getByTestId('first-run-continue').click();
  await expect(notebookSection(page, 'Notes')).toBeVisible({ timeout: 30_000 });
  // Asked: kept on this Mac, beside the (absent) key.
  await expect
    .poll(() => {
      try {
        return (
          JSON.parse(readFileSync(join(launched.userData, 'ai-keys.json'), 'utf8')) as {
            asked?: boolean;
          }
        ).asked;
      } catch {
        return undefined;
      }
    })
    .toBe(true);
});
