import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import {
  analyticsEnv,
  analyticsStatus,
  canaryFiles,
  canaryHits,
  CANARIES,
  fakeAnalytics,
  logFilePath,
  sendNow,
  type FakeAnalytics,
  type WireEvent,
} from './fake-analytics';
import {
  body,
  gitNotebook,
  go,
  holdForProof,
  launch,
  mainBounds,
  removeDataDirs,
  ULID,
  type Launched,
} from './support';

// PEN-137 AC13 and AC14 in the Mac app: with sharing on, a tour of the app through the canary
// notebook (test/fixtures/canary-notebook: its notebook's name, notes' titles, a tag, a body
// word, a search) reaches the endpoint as named events, each kind among them (a command run, a
// screen, a dialog, a tracked click, a setting), in the order they happened by their `seq`. And
// none of the canary strings, exact, in another case or URL-encoded, is in any request, in the
// record on this Mac (events.db and its WAL) or in the log file. The endpoint is a stand-in on
// loopback (fake-analytics.ts).

const mac = process.platform === 'darwin';
const NEW_NOTE = mac ? 'Meta+Alt+KeyN' : 'Alt+KeyN';
const SEARCH = 'ControlOrMeta+Shift+KeyF';
const PALETTE = 'ControlOrMeta+KeyK';
const opened: Launched[] = [];
const endpoints: FakeAnalytics[] = [];

test.afterEach(async () => {
  for (const { app } of opened.splice(0)) await app.close().catch(() => undefined);
  for (const endpoint of endpoints.splice(0)) await endpoint.close();
});
test.afterAll(() => removeDataDirs());

async function newNote(page: Page, title: string, text: string): Promise<void> {
  await expect(page.locator('button[data-command="note.new"]').first()).toBeVisible();
  await page.keyboard.press(NEW_NOTE);
  await expect(page).toHaveURL(ULID);
  await expect(page.getByTestId('note-title')).toBeFocused();
  await page.keyboard.type(title);
  await page.keyboard.press('Enter');
  await page.keyboard.type(text);
  await expect(body(page)).toContainText(text.split(' ')[0]!);
}

/** `kind name` of each event, for a readable failure. */
const named = (events: readonly WireEvent[]) =>
  events.map((event) => `${event.kind} ${event.name}`);

test('a tour of the canary notebook reaches the endpoint by name, in order, and none of its words anywhere (AC13, AC14)', async () => {
  test.setTimeout(240_000);
  const fake = await fakeAnalytics();
  endpoints.push(fake);
  const launched = await launch({ analytics: 'yes', env: analyticsEnv(fake) });
  opened.push(launched);
  const { app, page } = launched;
  await mainBounds(app, { x: 0, y: 0, width: 1280, height: 720 });

  // The canary notebook: its name, two notes with a tag and a body word.
  await gitNotebook(launched, CANARIES.notebook);
  const [zebra, axolotl] = CANARIES.notes;
  await newNote(page, zebra!.title, `${CANARIES.body[0]} saw #${CANARIES.tags[0]} today`);
  await newNote(page, axolotl!.title, `${CANARIES.notes[2]!.title} in ${CANARIES.folders[0]}`);

  // Search for a canary word, and a note's title.
  await page.keyboard.press(SEARCH);
  const search = page.getByTestId('search');
  const input = search.getByRole('combobox', { name: 'Search notes' });
  await expect(input).toBeFocused();
  await input.fill(CANARIES.search);
  await page.waitForTimeout(500);
  await input.fill(zebra!.title);
  await page.waitForTimeout(500);
  await page.keyboard.press('Escape');
  await expect(search).toBeHidden();

  // A setting: Appearance's mode.
  await go(page, '/settings/appearance');
  const mode = page.getByTestId('theme-mode');
  await expect(mode).toBeVisible();
  const dark = mode.getByRole('radio', { name: 'Dark' });
  const next = (await dark.isChecked()) ? 'Light' : 'Dark';
  await mode.locator('label', { hasText: next }).click();
  await expect(mode.getByRole('radio', { name: next })).toBeChecked();

  // The palette: a canary word typed, then Privacy Settings run from it.
  await page.keyboard.press(PALETTE);
  const palette = page.getByRole('dialog', { name: 'Command Palette' });
  await expect(palette).toBeVisible();
  const query = palette.getByRole('combobox', { name: 'Command Palette' });
  await query.fill(CANARIES.search);
  await page.waitForTimeout(300);
  await query.fill('Privacy Settings');
  await expect(palette.getByRole('option').first()).toContainText('Privacy Settings');
  await page.keyboard.press('Enter');
  await expect(palette).toBeHidden();
  await expect(page).toHaveURL(/\/settings\/privacy$/);
  const section = page.getByTestId('privacy-settings');
  await expect(page.getByRole('switch', { name: 'Share Usage Data' })).toBeChecked();

  // Sent now, as the minute's timer would: every kind of the tour, by name (AC13).
  const wanted = [
    'command note.new',
    'dialog search',
    'screen settings.appearance',
    'click settings.appearance.mode',
    'setting theme.mode',
    'dialog palette',
    'command app.privacy',
    'screen settings.privacy',
  ];
  await expect
    .poll(
      async () => {
        await sendNow(app);
        return named(fake.events());
      },
      { timeout: 60_000, intervals: [500, 1000, 2000] },
    )
    .toEqual(expect.arrayContaining(wanted));
  const install = (await analyticsStatus(page)).install;
  expect(fake.batches.every((batch) => batch.install === install && batch.v === 1)).toBe(true);
  const events = fake.events();
  // One launch, one session; each event once, in the order it happened by its seq.
  const sessions = new Set(events.map((event) => event.session));
  expect(sessions.size).toBe(1);
  const seqs = events.map((event) => event.seq);
  expect(new Set(seqs).size).toBe(seqs.length);
  const bySeq = [...events].sort((a, b) => a.seq - b.seq);
  const firstAt = (wantedName: string) => named(bySeq).indexOf(wantedName);
  const order = wanted.map(firstAt);
  expect(order.every((index) => index >= 0)).toBe(true);
  expect([...order].sort((a, b) => a - b)).toEqual(order);
  expect(events.every((event) => event.client === 'mac' && event.actor === 'person')).toBe(true);
  // How it ran, never what it ran on.
  const privacy = events.find((event) => event.kind === 'command' && event.name === 'app.privacy');
  expect(privacy?.props['source']).toBe('palette');
  const setting = events.find((event) => event.kind === 'setting' && event.name === 'theme.mode');
  expect(setting?.props['value']).toBe(next.toLowerCase());

  // None of the canary notebook's words, nor `canary` itself, in any request (AC14).
  expect(fake.requests.every((request) => request === 'POST /v1/batch')).toBe(true);
  for (const sent of fake.bodies) expect(canaryHits(sent, [CANARIES.pattern])).toEqual([]);
  // Nor in the record on this Mac, its WAL included, nor in the log file.
  expect(canaryFiles(join(launched.home, 'analytics'), [CANARIES.pattern])).toEqual([]);
  const log = await logFilePath(app);
  expect(existsSync(log)).toBe(true);
  expect(canaryHits(readFileSync(log, 'utf8'))).toEqual([]);
  expect(canaryFiles(launched.logDir)).toEqual([]);

  // On screen: Settings → Privacy, the record sent.
  const counts = section.getByTestId('privacy-counts');
  await expect(counts).toContainText(/Sent [\d,]+/);
  await counts.scrollIntoViewIfNeeded();
  await holdForProof(page);
});
