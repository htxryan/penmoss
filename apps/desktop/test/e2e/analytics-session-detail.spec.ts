import { createHmac } from 'node:crypto';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { analyticsEnv, analyticsStatus, fakeAnalytics, type FakeAnalytics } from './fake-analytics';
import {
  bareRepository,
  body,
  firstRunName,
  firstRunPasteUrl,
  gitNotebook,
  go,
  holdForProof,
  launch,
  mainBounds,
  notebookSection,
  removeDataDirs,
  ULID,
  type Launched,
} from './support';

// PEN-177 in the Mac app: session detail, in the standard Share Usage Data set. The first run's
// last step and the dialog over an existing install list "The shape of your notes and how much
// you type, never the words" under What Is Recorded (AC20). Then, sharing: a note written and
// opened again records its shape, typing bursts and splices by a 16-hex ref, the same ref each
// time, and never its id, title or words; main keeps the ref key beside the consent file, out of
// every event and the status (AC1, AC2, AC4). Settings → Privacy → View Analytics Data shows the
// rows, a long shape cut to 12 tokens and "… +N" (AC21); Advanced gives Keep at Most as 200,000,
// 500–2,000,000 (AC16); and Delete My Shared Data asks first, naming the ID, then deletes (AC23).

const mac = process.platform === 'darwin';
const RUN = `d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
const NEW_NOTE = mac ? 'Meta+Alt+KeyN' : 'Alt+KeyN';
/** Core's consent.recorded.5. */
const SHAPE_LINE = 'The shape of your notes and how much you type, never the words';
const TITLE = `Garden Plans ${RUN}`;
/** Sixteen lines: a shape longer than the viewer's 12 tokens. */
const LINES = Array.from({ length: 16 }, (_, n) => `Row ${n + 1} of seeds to sow`);

const opened: Launched[] = [];
const endpoints: FakeAnalytics[] = [];

test.afterEach(async () => {
  for (const { app } of opened.splice(0)) await app.close().catch(() => undefined);
  for (const endpoint of endpoints.splice(0)) await endpoint.close();
});
test.afterAll(() => removeDataDirs());

async function endpoint(): Promise<FakeAnalytics> {
  const started = await fakeAnalytics();
  endpoints.push(started);
  return started;
}

interface Recorded {
  readonly id: number;
  readonly at: number;
  readonly kind: string;
  readonly name: string;
  readonly props: Readonly<Record<string, unknown>>;
}

/** The record on this Mac, oldest first. */
async function record(page: Page): Promise<Recorded[]> {
  const { events } = await page.evaluate(() =>
    window.penmossDesktop!.analytics!.page({ limit: 1000 }),
  );
  return (events as unknown as Recorded[]).slice().sort((a, b) => a.id - b.id);
}

const noteEvents = async (page: Page, name?: string) =>
  (await record(page)).filter(
    (event) => event.kind === 'note' && (name === undefined || event.name === name),
  );

/** A note's ref under the key main keeps beside the consent file: AC1's formula, worked here. */
const refOf = (key: string, noteId: string) =>
  createHmac('sha256', Buffer.from(key, 'hex'))
    .update(`note:${noteId}`, 'utf8')
    .digest('hex')
    .slice(0, 16);

/**
 * Every `note open` the record holds now (ref, how, shape, at), logged and attached to the report:
 * the evidence of which open the test reads. The welcome note the first run opens is one of them.
 */
async function logOpens(page: Page, testInfo: TestInfo, label: string): Promise<void> {
  const opens = (await noteEvents(page, 'open')).map(({ id, at, props }) => ({
    id,
    at,
    ref: props['note'],
    how: props['how'],
    shape: props['shape'],
  }));
  const line = JSON.stringify({ label, opens });
  console.log(`[note open] ${line}`);
  await testInfo.attach(`note-open-${label}`, { body: line, contentType: 'application/json' });
}

test('the first run’s last step lists the shape of your notes under What Is Recorded (AC20)', async () => {
  test.setTimeout(180_000);
  const fake = await endpoint();
  const launched = await launch({ analytics: 'ask', env: analyticsEnv(fake) });
  opened.push(launched);
  const { app, page } = launched;
  await mainBounds(app, { x: 0, y: 0, width: 1280, height: 720 });

  // First Run C: Paste a URL, then Name Your Notebook; set up and synced, the usage question.
  await firstRunPasteUrl(page, `file://${bareRepository()}`);
  await firstRunName(page, 'Notes');
  const consent = page.getByTestId('first-run').getByTestId('first-run-consent');
  await expect(consent).toBeVisible({ timeout: 60_000 });
  await expect(consent.locator('.fr-step')).toHaveText('Last Step');
  await expect(consent.getByRole('heading', { name: 'What Is Recorded' })).toBeVisible();
  const recorded = consent.getByTestId('consent-recorded');
  // After the CLI's line, the last of What Is Recorded.
  await expect(recorded.locator('li').last()).toHaveText(SHAPE_LINE);
  const line = recorded.getByText(SHAPE_LINE, { exact: true });
  await line.scrollIntoViewIfNeeded();
  await expect(line).toBeInViewport();
  await page.mouse.move(0, 0);
  await holdForProof(page);
  // Still unanswered, and the line in view as the recording ends.
  expect((await analyticsStatus(page)).consent).toBeNull();
  await expect(consent).toBeVisible();
  await expect(line).toBeInViewport();
});

test('the dialog over an existing install lists the shape of your notes too (AC20)', async () => {
  test.setTimeout(180_000);
  const fake = await endpoint();
  // Before this build: a notebook, and no answer. Not recorded: the proof is the launch after it.
  const before = await launch({ env: analyticsEnv(fake), record: false });
  await gitNotebook(before);
  await before.app.close();
  rmSync(join(before.home, 'analytics.json'), { force: true });

  const launched = await launch({
    userData: before.userData,
    analytics: 'ask',
    env: analyticsEnv(fake),
  });
  opened.push(launched);
  const { app, page } = launched;
  await mainBounds(app, { x: 0, y: 0, width: 1280, height: 720 });
  const dialog = page.getByTestId('consent-dialog');
  await expect(dialog).toBeVisible({ timeout: 30_000 });
  await expect(notebookSection(page, 'Notes')).toBeVisible({ timeout: 30_000 });
  const line = dialog.getByTestId('consent-recorded').getByText(SHAPE_LINE, { exact: true });
  await line.scrollIntoViewIfNeeded();
  await expect(line).toBeInViewport();
  await page.mouse.move(0, 0);
  await holdForProof(page);
  expect((await analyticsStatus(page)).consent).toBeNull();
  await expect(dialog).toBeVisible();
  await expect(line).toBeInViewport();
});

test('a note’s shape and typing are recorded by ref, shown in Analytics Data; Advanced and Delete My Shared Data (AC1, AC2, AC16, AC21, AC23)', async () => {
  test.setTimeout(300_000);
  const testInfo = test.info();
  const fake = await endpoint();
  const launched = await launch({ analytics: 'yes', env: analyticsEnv(fake) });
  opened.push(launched);
  const { app, page, home } = launched;
  await mainBounds(app, { x: 0, y: 0, width: 1280, height: 720 });
  // A new notebook's first run ends on its welcome note: that note's open is in the record too,
  // under its own ref, before this test's note is made.
  await gitNotebook(launched);

  // A note written line by line: its open, typing bursts and a splice for each Enter.
  await expect(page.locator('button[data-command="note.new"]').first()).toBeVisible();
  await page.keyboard.press(NEW_NOTE);
  await expect(page).toHaveURL(ULID);
  const noteId = ULID.exec(new URL(page.url()).pathname)![1]!;
  // The key beside the consent file, made by the first event that named a note (AC1, AC4).
  const keyPath = join(home, 'analytics-key');
  await expect(page.getByTestId('note-title')).toBeFocused();
  await page.keyboard.type(TITLE);
  await page.keyboard.press('Enter');
  for (const [n, line] of LINES.entries()) {
    if (n > 0) await page.keyboard.press('Enter');
    await page.keyboard.type(line, { delay: 15 });
  }
  await expect(body(page)).toContainText(LINES.at(-1)!);
  await holdForProof(page, 1_000);
  await expect.poll(async () => (await noteEvents(page, 'typing')).length).toBeGreaterThan(3);
  await expect.poll(async () => (await noteEvents(page, 'blocks')).length).toBeGreaterThan(3);
  const key = readFileSync(keyPath, 'utf8').trim();
  expect(key).toMatch(/^[0-9a-f]{64}$/);
  // This note's ref, which every one of its events names (AC1).
  const ref = refOf(key, noteId);
  await logOpens(page, testInfo, 'before-reopen');

  // Opened again: a note open with the same ref, its 16 blocks in its shape (AC2, AC5). The open
  // recorded by this showing, not an earlier one: the record already holds the welcome note's
  // and this note's own first open (`p:0`, before a line was typed), and the page sends its
  // events a moment after it records them.
  await go(page, '/');
  await expect(page).not.toHaveURL(ULID);
  const reopened = Date.now();
  await go(page, `/notes/${noteId}`);
  await expect(page.getByTestId('note-view')).toHaveAttribute('data-ready', 'true');
  const ready = Date.now();
  const reopen = async () =>
    (await noteEvents(page, 'open')).filter(
      (event) => event.props['note'] === ref && event.at >= reopened,
    );
  await expect.poll(async () => (await reopen()).length).toBeGreaterThan(0);
  await logOpens(page, testInfo, `reopened-${reopened}-ready-${ready}`);
  const [last] = await reopen();
  expect(last!.props['how']).toMatch(/^(open|switch)$/);
  expect(last!.props['shape']).toEqual(LINES.map((line) => `p:${line.length}`));
  expect(last!.props['titleChars']).toBe(TITLE.length);

  // Refs, never the note's id, title or words; this note's ref throughout (AC1, AC2): every
  // event the writing made names it, and the opens before it name only it and the welcome note.
  const events = await noteEvents(page);
  for (const event of events) expect(event.props['note']).toMatch(/^[0-9a-f]{16}$/);
  const written = events.filter((event) => event.name === 'typing' || event.name === 'blocks');
  expect(written.length).toBeGreaterThan(6);
  expect(new Set(written.map((event) => event.props['note']))).toEqual(new Set([ref]));
  const opens = await noteEvents(page, 'open');
  expect(opens.filter((event) => event.props['note'] === ref).length).toBeGreaterThan(1);
  expect(new Set(opens.map((event) => event.props['note'])).size).toBeLessThanOrEqual(2);
  const stored = JSON.stringify(await record(page));
  for (const text of [noteId, TITLE, 'seeds', 'Garden']) expect(stored).not.toContain(text);
  // The key beside the consent file, never in an event, the status or the consent file (AC4).
  expect(stored).not.toContain(key);
  expect(JSON.stringify(await analyticsStatus(page))).not.toContain(key);
  expect(readFileSync(join(home, 'analytics.json'), 'utf8')).not.toContain(key);

  // Settings → Privacy → View Analytics Data: the note open, its shape cut, and the typing rows.
  await go(page, '/settings/privacy');
  await page.getByRole('link', { name: /View Analytics Data/ }).click();
  await expect(page).toHaveURL(/\/settings\/privacy\/data$/);
  const data = page.getByTestId('analytics-data');
  await expect(data.getByRole('heading', { level: 1 })).toHaveText('Analytics Data');
  const rows = data.getByTestId('analytics-data-row');
  const rowsOf = (name: string) =>
    rows
      .filter({ has: page.locator('td:nth-child(3)', { hasText: /^note$/ }) })
      .filter({ has: page.locator('td:nth-child(4)', { hasText: new RegExp(`^${name}$`) }) });
  // This note's reopen: the newest of its opens (the viewer shows the newest first).
  const openRow = rowsOf('open').filter({ hasText: ref }).first();
  await expect(openRow).toBeVisible();
  const shown = LINES.slice(0, 12)
    .map((line) => `p:${line.length}`)
    .join(' ');
  // Opened again it says `open`, or `switch` when its editor was still on the shelf of kept ones.
  await expect(openRow.locator('td:nth-child(5)')).toHaveText(
    new RegExp(
      `^note: ${ref}, how: (open|switch), titleChars: ${TITLE.length}, shape: ${shown} … \\+4$`,
    ),
  );
  const typingRow = rowsOf('typing').filter({ hasText: ref }).first();
  await expect(typingRow).toBeVisible();
  await expect(typingRow.locator('td:nth-child(5)')).toHaveText(
    new RegExp(`^note: ${ref}, (block: \\d+|title: true), typed: \\d+, deleted: \\d+$`),
  );
  await openRow.scrollIntoViewIfNeeded();
  await page.mouse.move(0, 0);
  await holdForProof(page);
  await expect(openRow).toBeInViewport();

  // Advanced: Keep at Most's default and range, and the space it may take (AC16).
  await go(page, '/settings/privacy');
  const section = page.getByTestId('privacy-settings');
  const advanced = section.getByTestId('privacy-advanced');
  await section.getByTestId('privacy-advanced-summary').click();
  await expect(advanced).toHaveAttribute('open', '');
  const most = advanced.locator('[data-setting="keep-at-most"]');
  await expect(most.getByRole('textbox')).toHaveValue('200,000');
  await expect(most.getByTestId('privacy-limit-range')).toHaveText('500–2,000,000 events');
  const space = advanced.getByTestId('privacy-space-usage');
  await expect(space).toHaveText('About 95 MB of events at most on this Mac');
  await space.scrollIntoViewIfNeeded();
  await page.mouse.move(0, 0);
  await holdForProof(page);
  await expect(most).toBeInViewport();

  // Delete My Shared Data asks first, naming the ID, under its row (AC23).
  const row = page.locator('[data-setting="analytics-id"]');
  const install = (await analyticsStatus(page)).install;
  const id = `${install.slice(0, 8)}…${install.slice(-4)}`;
  const button = row.getByRole('button', { name: 'Delete My Shared Data' });
  const confirm = row.getByRole('alertdialog', { name: 'Delete Your Shared Data?' });
  await button.scrollIntoViewIfNeeded();
  await button.click();
  await expect(confirm).toBeVisible();
  await expect(confirm).toContainText(
    `Penmoss’s server deletes everything this Mac shared under ID ${id}, and this Mac gets a new ID. The record on this Mac stays.`,
  );
  await expect(confirm.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await page.mouse.move(0, 0);
  await holdForProof(page);
  await confirm.getByRole('button', { name: 'Delete' }).click();
  const done = row.getByTestId('privacy-id-note');
  await expect(done).toHaveText('Your shared data was deleted, and this Mac has a new ID.');
  expect(fake.forgets).toEqual([install]);
  // A new ID, and a new ref key with it (AC3).
  expect((await analyticsStatus(page)).install).not.toBe(install);
  await expect.poll(() => readFileSync(keyPath, 'utf8').trim()).not.toBe(key);
  await holdForProof(page);
  await expect(done).toBeInViewport();
});
