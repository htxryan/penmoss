import AxeBuilder from '@axe-core/playwright';
import { expect, GITHUB_TOKEN, test, type GitHost, type Page } from './fixtures';
import { crc32, deflateSync } from 'node:zlib';
import { collectErrors, newNote } from './support/app';

// T49: Send feedback files a GitHub issue. On the Mac (T57, A1010–A1012) main files it with the
// person's own GitHub token: here apps/desktop's GitHubToken against core's fake GitHub, in the
// stand-in Mac (support/git-host.ts). Opened from the sidebar and the palette; an image pasted
// and one picked; offline, it waits in the outbox and goes once the browser is back; with no
// token it waits until one is saved in Settings → GitHub. Unsent reports wait in the form's
// Waiting to Send (PEN-146). The note's body holds a marker that
// must reach neither what the page hands main nor the issue (A791). The Mac app's own suite
// covers the window captured by main (apps/desktop/test/e2e/send-feedback.spec.ts).

const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
const MARKER = `QUIETMARKER${RUN}`;
const PHONE = { width: 390, height: 844 };

/** A real 4×4 red PNG (the form decodes and encodes it again). */
const PNG = (() => {
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(4);
    head.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([head, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(4, 0);
  header.writeUInt32BE(4, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const row = Buffer.from([0, ...Array.from({ length: 4 }, () => [255, 0, 0]).flat()]);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.concat([row, row, row, row]))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
})();

interface FakeIssue {
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly labels: readonly string[];
}

function fakeIssue(host: GitHost, title: string): FakeIssue | undefined {
  return (host.github.issues as readonly FakeIssue[]).find((issue) => issue.title === title);
}

/** Main holds the person's GitHub token (A1012), unless a test says otherwise. */
test.beforeEach(async ({ host }, info) => {
  if (info.title.startsWith('with no GitHub token')) return;
  expect(await host.githubToken.save(GITHUB_TOKEN)).toMatchObject({ ok: true });
});

const dialog = (page: Page) => page.getByRole('dialog', { name: 'Send Feedback' });

/** Pastes `bytes` as an image file into the focused element. */
async function pasteImage(page: Page, name: string): Promise<void> {
  await page.evaluate(
    ({ base64, name }) => {
      const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
      const transfer = new DataTransfer();
      transfer.items.add(new File([bytes], name, { type: 'image/png' }));
      const target = document.activeElement ?? document.body;
      target.dispatchEvent(
        new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }),
      );
    },
    { base64: PNG.toString('base64'), name },
  );
}

async function fillForm(page: Page, title: string, description: string): Promise<void> {
  const form = dialog(page);
  await form.getByTestId('feedback-type-bug').check();
  await form.getByTestId('feedback-priority-2').check();
  await form.getByTestId('feedback-title').fill(title);
  await form.getByTestId('feedback-description').click();
  await page.keyboard.type(description);
}

test('files an issue from the sidebar, beside a note, with screenshots and context, never the note’s text', async ({
  page,
  host,
}) => {
  const errors = collectErrors(page);
  const sent = host.feedbackPayloads;
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');
  await newNote(page, `Feedback note ${RUN}`, `The body says ${MARKER} and nothing else.`);

  // The sidebar's Send Feedback (the note's ⋯ menu lost it in T51, A937).
  await page.getByTestId('sidebar-feedback').click();
  const form = dialog(page);
  await expect(form).toBeVisible();
  await expect(form.getByTestId('feedback-type-bug')).toBeFocused();

  // Sending without a type, priority and title names each.
  await form.getByTestId('feedback-send').click();
  await expect(form.getByText('Choose Bug report or Feature request.')).toBeVisible();
  await expect(form.getByText('Choose a priority.')).toBeVisible();
  await expect(form.getByText('Give it a title.')).toBeVisible();

  const title = `[e2e] The sidebar flickers ${RUN}`;
  await fillForm(page, title, 'It flickers when ');
  await form.getByTestId('feedback-format-bold').click();
  await page.keyboard.type('syncing');
  await pasteImage(page, 'pasted.png');
  await expect(form.getByTestId('feedback-shot')).toHaveCount(1);
  await form.getByTestId('feedback-file').setInputFiles({
    name: 'picked.png',
    mimeType: 'image/png',
    buffer: PNG,
  });
  await expect(form.getByTestId('feedback-shot')).toHaveCount(2);

  // The preview is what is sent; a group left out leaves it.
  await form.getByTestId('feedback-context').locator('summary').click();
  const preview = form.getByTestId('feedback-preview');
  await expect(preview).toContainText('#### This note');
  // A git notebook's history is the notebook's: no recent edits, and nothing that names the
  // notebook or the note (A826, A889).
  await expect(preview).not.toContainText('#### Recent edits to this note');
  await expect(preview).toContainText('nothing of the notebook is sent');
  await expect(preview).not.toContainText(MARKER);
  await form.getByTestId('feedback-group-errors').uncheck();
  await expect(preview).not.toContainText('#### Recent errors');

  const axe = await new AxeBuilder({ page })
    .include('[data-testid="feedback-dialog"]')
    .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
    .analyze();
  expect(
    axe.violations
      .filter((v) => v.impact === 'serious' || v.impact === 'critical')
      .map((v) => v.id),
  ).toEqual([]);

  await form.getByTestId('feedback-send').click();
  const toast = page.getByTestId('feedback-sent-toast');
  await expect(toast).toBeVisible({ timeout: 15_000 });
  await expect(form).toBeHidden();

  await expect.poll(() => Boolean(fakeIssue(host, title)), { timeout: 10_000 }).toBe(true);
  const issue = fakeIssue(host, title)!;
  await expect(toast).toContainText(`Sent as #${issue.number}`);
  expect(issue.labels).toEqual(['in-app feedback', 'bug', 'P2']);
  expect(issue.body).toContain('It flickers when **syncing**');
  expect(issue.body).toMatch(
    /!\[screenshot-1\.png\]\(https:\/\/github\.com\/user-attachments\/assets\/[0-9a-f-]+\)/,
  );
  expect(issue.body).toContain('![screenshot-2.png](https://github.com/user-attachments/assets/');
  expect(issue.body).toContain('<details><summary>Captured context</summary>');
  expect(issue.body).toContain('#### This note');
  expect(issue.body).not.toContain('#### Recent errors');
  expect(issue.body).toMatch(/Sent from Penmoss Mac .+ · submission [0-9A-HJKMNP-TV-Z]{26}/);
  expect(issue.body).not.toContain(MARKER);
  expect(sent).toHaveLength(1);
  expect(sent[0]).not.toContain(MARKER);
  expect(errors).toEqual([]);
});

test('offline, it waits in the outbox and goes when the browser is back', async ({
  page,
  context,
  host,
}) => {
  await page.goto('/');
  await expect(page.locator('button[data-command="note.new"]')).toBeVisible();
  // The dev server serves modules on demand: let the app finish loading its lazy modules first
  // (the form's markdown codec among them) before the connection goes.
  await page.waitForLoadState('networkidle');
  await context.setOffline(true);

  // From the sidebar's Feedback button.
  await page.getByTestId('sidebar-feedback').click();
  const title = `[e2e] Offline report ${RUN}`;
  await fillForm(page, title, 'Sent while offline.');
  await dialog(page).getByTestId('feedback-send').click();
  await expect(page.getByTestId('feedback-queued')).toBeVisible();
  await page.getByTestId('feedback-close').click();
  await expect(dialog(page)).toBeHidden();

  // In the app (a page load needs the network): the form again, where it waits (PEN-146).
  await page.getByTestId('sidebar-feedback').click();
  const entry = dialog(page).getByTestId('feedback-outbox-entry').filter({ hasText: title });
  await expect(entry).toBeVisible();

  await context.setOffline(false);
  await expect(page.getByTestId('feedback-sent-toast')).toBeVisible({ timeout: 20_000 });
  await expect(entry).toBeHidden();
  await expect(dialog(page).getByTestId('feedback-outbox')).toHaveCount(0);
  const issue = fakeIssue(host, title);
  expect(issue?.labels).toEqual(['in-app feedback', 'bug', 'P2']);
});

test('with no GitHub token, a report waits until one is saved in Settings → GitHub', async ({
  page,
  host,
}) => {
  await page.goto('/');
  await expect(page.locator('button[data-command="note.new"]')).toBeVisible();
  await page.getByTestId('sidebar-feedback').click();
  const title = `[e2e] Waiting for a token ${RUN}`;
  await fillForm(page, title, 'Sent before a token was saved.');
  await dialog(page).getByTestId('feedback-send').click();
  await expect(dialog(page)).toContainText('Sign in to GitHub in Settings → GitHub');
  await page.getByTestId('feedback-close').click();
  await expect(dialog(page)).toBeHidden();
  expect(fakeIssue(host, title)).toBeUndefined();

  // Settings → GitHub (PEN-146): it says a report waits, and the token is saved there. This
  // stand-in Mac has no Penmoss GitHub app, so the token's field shows without Use a Token.
  await page.keyboard.press('ControlOrMeta+Comma');
  await page
    .getByRole('navigation', { name: 'Settings Sections' })
    .getByRole('link', { name: 'GitHub' })
    .click();
  const waiting = page.getByTestId('github-feedback-waiting');
  await expect(waiting).toHaveText('· 1 report waiting');
  await expect(page.getByTestId('github-token-none')).toBeVisible();
  await page.getByTestId('github-token-input').fill(GITHUB_TOKEN);
  await page.getByTestId('github-token-save').click();
  await expect(page.getByTestId('github-account')).toContainText('htxryan');
  await expect(page.getByTestId('github-token-saved')).toContainText('Token Saved');
  // Saving it sends what waited for one (A1012).
  await expect(waiting).toBeHidden({ timeout: 20_000 });
  await expect.poll(() => Boolean(fakeIssue(host, title)), { timeout: 10_000 }).toBe(true);
  expect(await host.githubToken.status()).toMatchObject({ saved: true, login: 'htxryan' });
});

test('at phone width, from the palette: fits the screen, keeps its draft, closes with Escape', async ({
  page,
}) => {
  await page.setViewportSize(PHONE);
  await page.goto('/');
  await expect(page.locator('.notes-app')).toBeVisible();
  await page.waitForLoadState('networkidle');
  await page.keyboard.press('ControlOrMeta+KeyK');
  const palette = page.getByRole('dialog', { name: 'Command Palette' });
  await expect(palette).toBeVisible();
  await page.keyboard.type('Send feedback');
  await expect(palette.getByRole('option').first()).toContainText('Send Feedback');
  await page.keyboard.press('Enter');
  const form = dialog(page);
  await expect(form).toBeVisible();

  const box = await form.boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(PHONE.width);
  const scrolls = await page.evaluate(
    () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
  );
  expect(scrolls).toBe(false);

  const title = `[e2e] Draft ${RUN}`;
  // Typed once the form has read the draft (focus on its first field): before then, the form
  // keeps nothing, so a draft waiting from before is not overwritten.
  await expect(form.getByTestId('feedback-type-bug')).toBeFocused();
  await form.getByTestId('feedback-title').fill(title);
  await page.keyboard.press('Escape');
  await expect(form).toBeHidden();

  // The draft is kept until it is sent or discarded.
  await page.keyboard.press('ControlOrMeta+KeyK');
  await page.keyboard.type('Send feedback');
  await page.keyboard.press('Enter');
  await expect(form.getByTestId('feedback-title')).toHaveValue(title);
  await form.getByTestId('feedback-discard').click();
  await expect(form).toBeHidden();
});

test('before its draft is read, the form already has focus: Escape closes it', async ({ page }) => {
  // The feedback database answers only when the test says (a slow disk: CI's sidebar-pen-135
  // pressed Escape at that moment, focus was still on the button behind, and the form stayed).
  await page.addInitScript(() => {
    const held = new Promise<void>((resolve) => {
      (window as unknown as { releaseFeedback: () => void }).releaseFeedback = resolve;
    });
    const open = Object.getOwnPropertyDescriptor(IDBFactory.prototype, 'open')!.value as (
      this: IDBFactory,
      name: string,
      version?: number,
    ) => IDBOpenDBRequest;
    IDBFactory.prototype.open = function (name: string, version?: number) {
      const request = open.call(this, name, version);
      if (name !== 'penmoss-feedback') return request;
      let handler: ((event: Event) => void) | null = null;
      Object.defineProperty(request, 'onsuccess', {
        configurable: true,
        get: () => handler,
        set: (value: ((event: Event) => void) | null) => {
          handler = value;
        },
      });
      request.addEventListener('success', (event) => {
        void held.then(() => handler?.call(request, event));
      });
      return request;
    };
  });
  const errors = collectErrors(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/');
  const button = page.getByTestId('sidebar-feedback');
  await button.click();
  const form = dialog(page);
  await expect(form).toBeVisible();
  await expect(form).toBeFocused();
  // Still reading: its first field has no focus yet.
  await expect(form.getByTestId('feedback-type-bug')).not.toBeFocused();
  await page.keyboard.press('Escape');
  await expect(form).toBeHidden();
  await expect(button).toBeFocused();

  // Once the database answers, the form opens on its first field as before.
  await page.evaluate(() =>
    (window as unknown as { releaseFeedback: () => void }).releaseFeedback(),
  );
  await button.click();
  await expect(form.getByTestId('feedback-type-bug')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(form).toBeHidden();
  expect(errors).toEqual([]);
});

test('a report GitHub refuses is kept: Edit puts it back in the form, and it then files once', async ({
  page,
  host,
}) => {
  await page.goto('/');
  await expect(page.locator('button[data-command="note.new"]')).toBeVisible();
  // The next issue GitHub is asked to open is refused for good (424 github_refused).
  host.github.fail('/repos/htxryan/penmoss/issues', 422, 1);
  await page.getByTestId('sidebar-feedback').click();
  const title = `[e2e] Refused then edited ${RUN}`;
  await fillForm(page, title, 'Kept after a refusal.');
  await dialog(page).getByTestId('feedback-send').click();
  await expect(page.getByTestId('feedback-failed')).toBeVisible({ timeout: 15_000 });

  await page.getByTestId('feedback-edit').click();
  const form = dialog(page);
  await expect(form.getByTestId('feedback-title')).toHaveValue(title);
  await expect(form.getByTestId('feedback-description')).toContainText('Kept after a refusal.');
  await expect(form.getByTestId('feedback-type-bug')).toBeChecked();
  await form.getByTestId('feedback-title').fill(`${title} again`);
  await form.getByTestId('feedback-send').click();
  await expect(page.getByTestId('feedback-sent-toast')).toBeVisible({ timeout: 15_000 });
  expect(fakeIssue(host, `${title} again`)).toBeDefined();
  expect(fakeIssue(host, title)).toBeUndefined();
});

test('Edit in Waiting to Send reopens a refused report with the context it was captured with', async ({
  page,
  host,
}) => {
  await page.goto('/');
  await expect(page.locator('button[data-command="note.new"]')).toBeVisible();
  host.github.fail('/repos/htxryan/penmoss/issues', 422, 1);
  // Made from Home: its context names Home's route.
  await page.getByTestId('sidebar-feedback').click();
  const title = `[e2e] Edited from Status ${RUN}`;
  await fillForm(page, title, 'Taken back from the outbox.');
  await dialog(page).getByTestId('feedback-send').click();
  await expect(page.getByTestId('feedback-failed')).toBeVisible({ timeout: 15_000 });
  await page.getByTestId('feedback-close').click();
  await expect(dialog(page)).toBeHidden();

  // Settings → GitHub → Send Feedback's Open (PEN-146): the form, with the report waiting in it.
  await page.keyboard.press('ControlOrMeta+Comma');
  await page
    .getByRole('navigation', { name: 'Settings Sections' })
    .getByRole('link', { name: 'GitHub' })
    .click();
  await expect(page.getByTestId('github-feedback-waiting')).toHaveText('· 1 report waiting');
  await page.getByTestId('github-feedback-open').click();
  const entry = dialog(page).getByTestId('feedback-outbox-entry').filter({ hasText: title });
  await expect(entry).toHaveAttribute('data-state', 'failed');
  await entry.getByTestId('feedback-outbox-edit').click();

  // Opened over Settings, the form keeps the report's own context, not this screen's.
  const form = dialog(page);
  await expect(form.getByTestId('feedback-title')).toHaveValue(title);
  await expect(form.getByTestId('feedback-context-kept')).toBeVisible();
  await expect(entry).toBeHidden();
  await form.getByTestId('feedback-send').click();
  await expect(page.getByTestId('feedback-sent-toast')).toBeVisible({ timeout: 15_000 });
  const issue = fakeIssue(host, title);
  expect(issue?.body).toMatch(/\| Route +\| \/ +\|/);
  expect(issue?.body).not.toMatch(/\| Route +\| \/settings/);
});
