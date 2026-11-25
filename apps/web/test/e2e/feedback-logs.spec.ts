// PEN-137 ac3, ac28: Send Feedback's Attach Anonymised Logs on the Mac. A bug report has the box
// ticked, after Captured Context, with the sentence the limits make and the exact text attached,
// collapsed under its line count and size; a feature request has none. Report Lines set to 50
// is honoured: 50 of the 120 lines go. The filed issue holds them as a collapsed "Anonymised
// Logs" block before its footer. The stand-in Mac's analytics (support/fake-bridge.ts) give the
// lines; core's fake GitHub files the issue (as send-feedback.spec.ts).
import type { Page } from '@playwright/test';
import { expect, GITHUB_TOKEN, test, type GitHost } from './fixtures';
import { collectErrors, holdForProof, newNote } from './support/app';

const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
const NOTE_TITLE = `Okapicanary Plan ${RUN}`;

/** 120 lines as main's log file writes them (already scrubbed), oldest first. */
const LINES = Array.from({ length: 120 }, (_, index) => {
  const minute = String(Math.floor(index / 60) + 10).padStart(2, '0');
  const second = String(index % 60).padStart(2, '0');
  return `2026-11-19T11:${minute}:${second}.000Z info main sync pass ${index + 1} ok in 120 ms`;
});
const KEPT = LINES.slice(-50);

test.use({ analytics: { consent: 'no', limits: { 'report.lines': 50 }, reportLines: LINES } });

test.beforeEach(async ({ host }) => {
  expect(await host.githubToken.save(GITHUB_TOKEN)).toMatchObject({ ok: true });
});

interface FakeIssue {
  readonly title: string;
  readonly body: string;
}

const fakeIssue = (host: GitHost, title: string) =>
  (host.github.issues as readonly FakeIssue[]).find((issue) => issue.title === title);

const dialog = (page: Page) => page.getByRole('dialog', { name: 'Send Feedback' });

/** The size the summary names: the lines joined, in KB (1,000 bytes) to one place under 10 KB. */
const size = (lines: readonly string[]) =>
  `${Math.round(new TextEncoder().encode(lines.join('\n')).length / 100) / 10} KB`;

test('a bug report attaches its anonymised logs, exactly as previewed, before the footer', async ({
  page,
  host,
}) => {
  test.setTimeout(90_000);
  const errors = collectErrors(page);
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto('/');
  await newNote(page, NOTE_TITLE, 'A note whose title must not reach the logs.');

  await page.getByTestId('sidebar-feedback').click();
  const form = dialog(page);
  await form.getByTestId('feedback-type-bug').check();
  await form.getByTestId('feedback-priority-2').check();
  const title = `[e2e] Logs attached ${RUN}`;
  await form.getByTestId('feedback-title').fill(title);

  // After Captured Context, ticked for a bug, with the sentence the limits make (ac28).
  const logs = form.getByTestId('feedback-logs');
  await expect(logs).toBeVisible();
  const box = logs.getByRole('checkbox', { name: 'Attach Anonymised Logs' });
  await expect(box).toBeChecked();
  await expect(logs).toContainText(
    'The app’s logs from the last 24 hours, at most 50 lines and 16 KB, with names, paths, IDs and secrets replaced. This is exactly what is attached.',
  );
  const order = await form.evaluate((element) =>
    [...element.querySelectorAll('[data-testid="feedback-context"], [data-testid="feedback-logs"]')]
      .map((each) => each.getAttribute('data-testid'))
      .join(' '),
  );
  expect(order).toBe('feedback-context feedback-logs');
  // Scrub #2 knows the open notebooks' names: this note's title among them.
  const names = await page.evaluate(
    () => (window as { __penmossReportNames?: readonly string[] }).__penmossReportNames ?? [],
  );
  expect(names).toContain(NOTE_TITLE);

  // The exact text, collapsed under its count and size: the newest 50 of 120 lines.
  const preview = logs.getByTestId('feedback-logs-preview');
  const summary = preview.locator('summary');
  await expect(summary).toHaveText(`Anonymised Logs · 50 lines · ${size(KEPT)}`);
  await expect(logs.getByTestId('feedback-logs-text')).toBeHidden();
  await summary.click();
  await expect(logs.getByTestId('feedback-logs-text')).toHaveText(KEPT.join('\n'));

  // A feature request has none; back to a bug, it is ticked again.
  await form.getByTestId('feedback-type-feature').check();
  await expect(logs).toBeHidden();
  await form.getByTestId('feedback-type-bug').check();
  await expect(box).toBeChecked();

  await form.getByTestId('feedback-send').click();
  await expect(page.getByTestId('feedback-sent-toast')).toBeVisible({ timeout: 15_000 });
  await expect.poll(() => Boolean(fakeIssue(host, title)), { timeout: 10_000 }).toBe(true);
  const body = fakeIssue(host, title)!.body;
  const context = body.indexOf('<details><summary>Captured Context</summary>');
  const block = body.indexOf('<details>\n<summary>Anonymised Logs (50 lines)</summary>');
  const footer = body.search(/Sent from Penmoss Mac .+ · submission [0-9A-HJKMNP-TV-Z]{26}/);
  expect(context).toBeGreaterThanOrEqual(0);
  expect(block).toBeGreaterThan(context);
  expect(footer).toBeGreaterThan(block);
  expect(body).toContain(`\`\`\`text\n${KEPT.join('\n')}\n\`\`\`\n\n</details>`);
  expect(body).not.toContain(LINES[0]);
  expect(body).not.toContain(NOTE_TITLE);

  // The proof: a new bug report, its logs' exact text open on screen.
  await page.getByTestId('feedback-sent-toast').getByRole('button', { name: 'Dismiss' }).click();
  await page.getByTestId('sidebar-feedback').click();
  await form.getByTestId('feedback-type-bug').check();
  await form.getByTestId('feedback-title').fill(`[e2e] Logs again ${RUN}`);
  await summary.click();
  const text = logs.getByTestId('feedback-logs-text');
  await expect(text).toBeVisible();
  await text.evaluate((element) => element.scrollIntoView({ block: 'end' }));
  expect(errors).toEqual([]);
  await holdForProof(page, 2000);
  await expect(text).toHaveText(KEPT.join('\n'));
});

test('unticked, a bug report goes without its logs', async ({ page, host }) => {
  await page.goto('/');
  await expect(page.locator('button[data-command="note.new"]')).toBeVisible();
  await page.getByTestId('sidebar-feedback').click();
  const form = dialog(page);
  await form.getByTestId('feedback-type-bug').check();
  await form.getByTestId('feedback-priority-3').check();
  const title = `[e2e] Logs left out ${RUN}`;
  await form.getByTestId('feedback-title').fill(title);
  await form.getByRole('checkbox', { name: 'Attach Anonymised Logs' }).uncheck();
  await form.getByTestId('feedback-send').click();
  await expect(page.getByTestId('feedback-sent-toast')).toBeVisible({ timeout: 15_000 });
  await expect.poll(() => Boolean(fakeIssue(host, title)), { timeout: 10_000 }).toBe(true);
  expect(fakeIssue(host, title)!.body).not.toContain('Anonymised Logs');
});
