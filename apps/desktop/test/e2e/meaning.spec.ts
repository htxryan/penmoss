import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, symlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { EMBEDDING_GEMMA, fetchModel, modelId, modelPaths, vectorsDir } from '@penmoss/embed';
import { readdirSync } from 'node:fs';
import { expect, test, type ElectronApplication } from '@playwright/test';
import type { DesktopMeaningNote, DesktopMeaningStatus } from '../../../web/src/desktop/bridge';
import {
  dataDir,
  gitNotebook,
  go,
  launch,
  removeDataDirs,
  runInMainPage,
  type Launched,
} from './support';

// T76 (A1152, A1157, A1158): the embedding service, a utilityProcess main forks, with the real
// EmbeddingGemma from a pinned folder (PENMOSS_TEST_MODELS, by default the folder
// .github/scripts/meaning-check.sh keeps, downloaded once). The service never downloads here
// (PENMOSS_TEST_MEANING=no-download) and the app runs offline. The page reaches the service
// only through main's named calls (window.penmossDesktop.meaning).

const MODELS =
  process.env['PENMOSS_TEST_MODELS'] ||
  join(homedir(), 'Library', 'Caches', 'penmoss-ci', 'models');
const opened: Launched[] = [];

test.beforeAll(async () => {
  // The first run on a machine downloads the model (about 219 MB) into the pinned folder.
  test.setTimeout(15 * 60_000);
  mkdirSync(MODELS, { recursive: true });
  const home = dataDir();
  symlinkSync(MODELS, join(home, 'models'));
  await fetchModel(EMBEDDING_GEMMA, { home });
});
test.afterEach(async () => {
  for (const { app } of opened.splice(0)) await app.close().catch(() => undefined);
});
test.afterAll(() => removeDataDirs());

/** A ~/.penmoss with the pinned model: linked, or cloned (APFS) for a test that removes it. */
function meaningHome(copy = false): string {
  const home = dataDir();
  if (copy)
    execFileSync('cp', [
      process.platform === 'darwin' ? '-cR' : '-R',
      MODELS,
      join(home, 'models'),
    ]);
  else symlinkSync(MODELS, join(home, 'models'));
  return home;
}

async function start(home: string): Promise<Launched> {
  const launched = await launch({
    offline: true,
    env: { PENMOSS_HOME: home, PENMOSS_TEST_MEANING: 'no-download' },
  });
  opened.push(launched);
  return launched;
}

const note = (id: string, title: string, text: string): DesktopMeaningNote => ({
  id,
  version: 1,
  title,
  sections: [{ heading: null, path: [], text }],
});

const NOTES = [
  note(
    'ups',
    'UPS shutdown',
    'When the power fails the battery keeps the rack up and the guests shut down in order.',
  ),
  note('bread', 'Sourdough', 'Feed the starter flour and water every morning.'),
  note('trip', 'Japan trip', 'Shrines in Kyoto and the rail pass.'),
];

/** Runs `code` in the main window's page, where the preload's bridge is. */
const inPage = <T>(app: ElectronApplication, code: string, gesture = false): Promise<T> =>
  runInMainPage(app, code, gesture) as Promise<T>;

const status = (app: ElectronApplication) =>
  inPage<DesktopMeaningStatus | null>(app, 'window.penmossDesktop.meaning.status()');

/** Sends the notes as the page will: versions first, then the sections the service asks for. */
const send = (app: ElectronApplication, notes: readonly DesktopMeaningNote[]) =>
  inPage<string[]>(
    app,
    `(async (notes) => {
      const meaning = window.penmossDesktop.meaning;
      const need = await meaning.update('e2e', notes.map(({ id, version }) => ({ id, version })));
      await meaning.update('e2e', notes);
      return need;
    })(${JSON.stringify(notes)})`,
  );

const search = (app: ElectronApplication, query: string) =>
  inPage<{ answer: { floor: number; hits: Array<{ id: string }> } | null; ms: number }>(
    app,
    `(async (query) => {
      const started = performance.now();
      const answer = await window.penmossDesktop.meaning.search('e2e', query);
      return { answer, ms: performance.now() - started };
    })(${JSON.stringify(query)})`,
  );

/** Until a start of the service (`generation`) answers: the page sends its notes then. */
async function untilStarted(app: ElectronApplication, generation = 1): Promise<void> {
  await expect
    .poll(
      async () => {
        const now = await status(app);
        return now?.generation === generation && !['starting', 'restarting'].includes(now.state);
      },
      { timeout: 30_000 },
    )
    .toBe(true);
}

async function untilReady(app: ElectronApplication, generation = 1): Promise<void> {
  await expect
    .poll(
      async () => {
        const now = await status(app);
        return now?.generation === generation && now.state === 'ready' ? now.indexed : -1;
      },
      { timeout: 60_000 },
    )
    .toBe(NOTES.length);
}

const pid = (app: ElectronApplication) =>
  app.evaluate(() =>
    (
      globalThis as unknown as { penmossDesktop: { meaningPid(): number | null } }
    ).penmossDesktop.meaningPid(),
  );

test('the service indexes what the page sends and answers by meaning, the page off the network', async () => {
  const home = meaningHome();
  const { app, page, errors } = await start(home);
  const requests: string[] = [];
  page.on('request', (request) => requests.push(request.url()));
  await untilStarted(app);
  expect((await send(app, NOTES)).sort()).toEqual(['bread', 'trip', 'ups']);
  await untilReady(app);
  const times: number[] = [];
  for (const query of [
    'keep the computers running during a blackout',
    'baking bread at home',
    'temples and trains',
  ]) {
    const { answer, ms } = await search(app, query);
    times.push(ms);
    expect(answer?.floor).toBe(0.28);
    expect(answer?.hits[0]?.id).toBe(
      { 'keep the computers running during a blackout': 'ups', 'baking bread at home': 'bread' }[
        query
      ] ?? 'trip',
    );
  }
  // A1160: a query within 800 ms (the median, on a busy Mac).
  console.log(
    `[T76] meaning queries from the page: ${times.map((ms) => Math.round(ms)).join(', ')} ms`,
  );
  expect(times.sort((a, b) => a - b)[1]).toBeLessThan(800);
  // The vectors are in the shared cache, in the app's own segment (A1153).
  expect(readdirSync(vectorsDir(home, modelId(EMBEDDING_GEMMA)))).toContain('seg-app.bin');
  // Nothing the page asked for left the app's own origin.
  expect(requests.filter((url) => !/^(app:\/\/penmoss\/|data:|blob:)/.test(url))).toEqual([]);
  expect(errors).toEqual([]);
});

test('a crash is restarted, the page searching by words meanwhile', async () => {
  const { app } = await start(meaningHome());
  await untilStarted(app);
  await send(app, NOTES);
  await untilReady(app);
  const first = await pid(app);
  expect(first).not.toBeNull();
  process.kill(first!, 'SIGKILL');
  await expect.poll(async () => (await status(app))?.state).toBe('restarting');
  expect((await search(app, 'blackout')).answer).toBeNull();
  // Started again: a new generation, which has none of the notes, so the page sends them again.
  await untilStarted(app, 2);
  expect(await pid(app)).not.toBe(first);
  expect(await send(app, NOTES)).toHaveLength(3);
  await untilReady(app, 2);
  expect(
    (await search(app, 'keep the computers running during a blackout')).answer?.hits[0]?.id,
  ).toBe('ups');
});

test('Settings → Search by Meaning: Off removes the model and the vectors, after a click (A1158)', async () => {
  const home = meaningHome(true);
  const launched = await start(home);
  const { app, page } = launched;
  await untilStarted(app);
  // From a script, with no click or key press, nothing changes (before anything is typed: a key
  // press lets the page act for a few seconds after it).
  expect(await inPage(app, 'window.penmossDesktop.meaning.setEnabled(false)')).toBeNull();
  // Settings needs a notebook (with none, the app shows its first-run screen).
  await gitNotebook(launched);
  await send(app, NOTES);
  await untilReady(app);
  // T78: the row says what meaning is doing; its switch turns it off.
  await go(page, '/settings/meaning');
  const row = page.getByTestId('meaning-settings');
  await expect(row.getByTestId('meaning-status')).toHaveText(
    'Ready: EmbeddingGemma 300M (219 MB), on this Mac. All 3 notes are indexed.',
  );
  await row.getByTestId('meaning-enabled').click();
  await expect(row.getByTestId('meaning-status')).toHaveAttribute('data-state', 'off');
  await expect(row.getByTestId('meaning-enabled')).not.toBeChecked();
  expect(JSON.parse(readFileSync(join(home, 'meaning.json'), 'utf8'))).toEqual({ enabled: false });
  expect(existsSync(modelPaths(EMBEDDING_GEMMA, home).dir)).toBe(false);
  expect(existsSync(vectorsDir(home, modelId(EMBEDDING_GEMMA)))).toBe(false);
  expect((await search(app, 'blackout')).answer).toBeNull();
  // On again: the model is gone and this service never downloads, so it says Not downloaded.
  await row.getByTestId('meaning-enabled').click();
  await expect(row.getByTestId('meaning-status')).toHaveAttribute('data-state', 'absent');
  await expect(row.getByTestId('meaning-status')).toContainText('Not downloaded.');
  await expect(row.getByTestId('meaning-enabled')).toBeChecked();
});
