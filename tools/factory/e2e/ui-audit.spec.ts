import { createRequire } from 'node:module';
import { expect, test } from '@playwright/test';

/**
 * The validator's UI audit (A1650) on a page like PEN-137's evidence: a Privacy group whose
 * confirmation sticks out of it, consent answers of different widths, and labels in sentence
 * case. Headless Chromium, as the validator runs it in the gate's sandbox.
 */
const { audit } = createRequire(import.meta.url)('../sandbox/ui-audit.cjs') as {
  audit: (page: unknown) => Promise<{
    findings: { kind: string; where: string; detail: string }[];
  }>;
};

const PAGE = `<!doctype html><html><body style="margin:0;font:14px system-ui">
<main style="width:600px;padding:20px">
  <h2>Privacy</h2>
  <h3>Analytics Id</h3>
  <div role="group" style="width:400px;border:1px solid #ccc;padding:8px">
    <div class="confirm" style="width:420px;background:#fee">
      <p>Delete your shared data? Everything sent under this ID goes.</p>
      <button>Cancel</button><button>Delete</button>
    </div>
  </div>
  <section role="dialog" style="border:1px solid #999;padding:12px;width:360px">
    <h3>Share How You Use Penmoss?</h3>
    <div><button>Share Usage Data</button><button>Don't share</button></div>
  </section>
  <label>Keep at Most <input type="number" value="5000"></label>
  <p>Hints and sentences are never checked: keep this in sentence case.</p>
</main></body></html>`;

test('finds overflow, unequal answers and labels out of Title Case', async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 600 });
  await page.setContent(PAGE);
  const { findings } = await audit(page);
  const kinds = (k: string) => findings.filter((f) => f.kind === k);
  expect(kinds('overflow')).toEqual([
    expect.objectContaining({
      detail: expect.stringMatching(/sticks out of div\[role=group\] .* by 1\d px/),
    }),
  ]);
  expect(kinds('title-case').map((f) => f.detail)).toEqual([
    '"Analytics Id" should read "Analytics ID"',
    `"Don't share" should read "Don't Share"`,
  ]);
  expect(kinds('unequal-choices')).toHaveLength(1);
  expect(kinds('unequal-choices')[0]!.where).toContain('Share Usage Data');
});

test('finds nothing on a screen that keeps the conventions', async ({ page }) => {
  await page.setContent(`<!doctype html><body><fieldset style="border:1px solid #ccc;width:400px">
    <legend>Analytics ID</legend><div style="display:flex;gap:8px">
    <button style="width:150px">Share Usage Data</button><button style="width:150px">Don't Share</button>
    </div></fieldset></body>`);
  expect((await audit(page)).findings).toEqual([]);
});
