/**
 * A deliberate CI-only failure (PEN-98): it passes in the factory's sandbox and fails on GitHub
 * Actions, so the factory's handling of a CI failure it can't fix can be watched. Never merge.
 */
import { expect, test } from 'vitest';

test('runs outside GitHub Actions', () => {
  expect(process.env['GITHUB_ACTIONS']).toBeUndefined();
});
