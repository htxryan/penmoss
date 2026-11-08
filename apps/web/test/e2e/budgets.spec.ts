import { expect, GitHost, macContext, PREVIEW, test, type Page } from './fixtures';
import { LINE_END } from './keys';
import { noteAction } from './note-menu';

// T31: the performance budgets (docs/architecture.md, "Requirements every change keeps"), measured in Chromium on the real
// app with a 10,000-word note:
// - typing latency p95 < 16 ms (letters, Enter and Backspace, caret mid-document);
// - opening a note < 150 ms (switching notes from the sidebar), both ways a note opens:
//   from the local replica (read from IndexedDB, decoded and bound to a new editor), and
//   back to a note shown a moment ago, whose editor is kept (T31, kept-editors.ts).
// T45: with three windows open, the main window and note windows on the long and the short
// note (popups share the main window's renderer, and the long note's window follows the edits).
// Tagged @budget: CI runs these in a job of their own (`--grep @budget`), apart from the
// smoke run. Shared CI runners are noisy, so each budget is a median over several runs or
// switches; the budgets themselves are never loosened here, and a budget
// test is never retried (a retry would pass a breach as "flaky").

const ULID = /\/notes\/([0-9A-HJKMNP-TV-Z]{26})$/;
const RUN = `b${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
const LONG_TITLE = `Budget long ${RUN}`;
const SHORT_TITLE = `Budget short ${RUN}`;
const SHORT_TEXT = `A short note to switch to, ${RUN}.`;
/** The last paragraph of the long note: once it shows, the whole note has rendered. */
const LONG_END = `The end of the long note, ${RUN}.`;
/** Two more notes opened between two opens of the long one, so its editor is no longer kept. */
const OTHERS = [1, 2].map((n) => ({
  title: `Budget other ${n} ${RUN}`,
  text: `Another note to switch to, ${n}, ${RUN}.`,
}));
/** Switches measured per direction, after the warm-up. */
const SAMPLES = 20;

const TYPING_BUDGET_MS = 16;
const SWITCH_BUDGET_MS = 150;

const body = (page: Page) => page.getByTestId('note-body').locator('.ProseMirror');

function collectErrors(page: Page, errors: string[] = []): string[] {
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(error.message));
  return errors;
}

/** The value at fraction `q` of the sorted samples (nearest rank). */
function quantile(samples: readonly number[], q: number): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))]!;
}

const round = (ms: number) => Math.round(ms * 100) / 100;

function report(name: string, value: unknown): void {
  const description = JSON.stringify(value);
  test.info().annotations.push({ type: `[budget] ${name}`, description });
  console.log(`[budget] ${name} ${description}`);
}

// A realistic 10,000-word note in markdown: sections with headings, paragraphs with some
// inline marks, bullet, numbered and task lists. Seeded, so every run types into the same note.
// T44: line symbols too (a heading in four, a checklist's first item, a list's last), drawn in
// the margin by the editor, so the budgets cover their decorations; picked by position, not
// by the seed, which keeps the words and the rest of the note as they were.
const WORDS = (
  'the of and to in is was that for on with as by at from this have are not but had his ' +
  'they which one you were her all she there would their we him been has when who will more ' +
  'no if out so said what up its about into than them can only other new some could time ' +
  'these two may then first any like now my such make over our even most made after also ' +
  'did many before must through back years where much your way well down should because ' +
  'each just those people how too little state good very world still own see men work long ' +
  'get here between both life being under never day same another know while last might us ' +
  'great old year off come since against go came right used take three garden river ' +
  'morning window kitchen letter bridge market winter summer harbor meadow lantern orchard ' +
  'pebble thunder village candle forest journey station blanket compass ladder'
).split(' ');

function longNoteMarkdown(): { markdown: string; words: number } {
  let seed = 31;
  const random = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  let count = 0;
  const words = (n: number) => {
    count += n;
    return Array.from({ length: n }, () => WORDS[Math.floor(random() * WORDS.length)]!);
  };
  const sentence = (n: number) => {
    const list = words(n);
    if (random() < 0.3) list[1] = `**${list[1]}**`;
    if (random() < 0.2) list[n - 2] = `*${list[n - 2]}*`;
    if (random() < 0.1) list[2] = `\`${list[2]}\``;
    const text = list.join(' ');
    return `${text[0]!.toUpperCase()}${text.slice(1)}.`;
  };
  const paragraph = () =>
    Array.from({ length: 4 + Math.floor(random() * 3) }, () =>
      sentence(10 + Math.floor(random() * 8)),
    ).join(' ');
  const blocks: string[] = [];
  for (let section = 1; count < 10_000; section++) {
    const symbol = section % 4 === 0 ? '? ' : '';
    blocks.push(`## ${symbol}${sentence(3 + Math.floor(random() * 3)).slice(0, -1)}`);
    blocks.push(paragraph(), paragraph());
    const kind = section % 3;
    const items = 3 + Math.floor(random() * 3);
    blocks.push(
      Array.from({ length: items }, (_, i) =>
        kind === 0
          ? `- ${i === items - 1 ? '→ ' : ''}${sentence(6 + Math.floor(random() * 6))}`
          : kind === 1
            ? `${i + 1}. ${sentence(6 + Math.floor(random() * 6))}`
            : `- [${random() < 0.5 ? 'x' : ' '}] ${i === 0 ? '! ★ ' : ''}${sentence(4 + Math.floor(random() * 5))}`,
      ).join('\n'),
    );
    blocks.push(paragraph());
  }
  count += LONG_END.split(' ').length;
  blocks.push(LONG_END);
  return { markdown: `${blocks.join('\n\n')}\n`, words: count };
}

async function newNote(page: Page, title: string): Promise<string> {
  await page
    .getByTestId('sidebar-shortcuts')
    .getByRole('button', { name: 'New Note', exact: true })
    .click();
  await expect(page).toHaveURL(ULID);
  await expect(page.getByTestId('note-title')).toBeFocused();
  await page.keyboard.type(title);
  await page.keyboard.press('Enter');
  await expect(body(page)).toBeFocused();
  return ULID.exec(new URL(page.url()).pathname)![1]!;
}

/** The notebook's sync dot: synced, nothing waiting to be pushed (A860). */
async function expectSynced(page: Page) {
  const dot = page.getByTestId('section-sync');
  await expect(dot).toHaveAttribute('data-state', 'synced', { timeout: 60_000 });
  await expect(dot).toHaveAttribute('data-pending', '0', { timeout: 60_000 });
}

/** Resolves once the page's main thread has been idle (background work after a step done). */
async function quiet(page: Page) {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        let idle = 0;
        const step = () =>
          requestIdleCallback(
            (deadline) => {
              // Three idle periods in a row with time to spare: nothing queued behind them.
              idle = deadline.timeRemaining() > 10 ? idle + 1 : 0;
              if (idle >= 3) resolve();
              else setTimeout(step, 20);
            },
            { timeout: 1000 },
          );
        step();
      }),
  );
}

/** The notes, made once and shared by both budgets (the long one takes a while to make). */
async function makeNotes(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.getByTestId('app-root')).toBeVisible();
  await newNote(page, SHORT_TITLE);
  await page.keyboard.type(SHORT_TEXT);
  for (const other of OTHERS) {
    await newNote(page, other.title);
    await page.keyboard.type(other.text);
  }
  await expectSynced(page);

  // The long note, pasted as markdown through the clipboard (as from a plain-text app).
  const { markdown, words } = longNoteMarkdown();
  await newNote(page, LONG_TITLE);
  await page.evaluate(async (text) => {
    await navigator.clipboard.write([
      new ClipboardItem({ 'text/plain': new Blob([text], { type: 'text/plain' }) }),
    ]);
  }, markdown);
  await page.keyboard.press('ControlOrMeta+v');
  await expect(body(page)).toContainText(LONG_END, { timeout: 30_000 });
  // Every text node, not innerText: blocks off screen skip rendering (content-visibility),
  // and innerText leaves out text that is not rendered.
  const shown = await body(page).evaluate((element) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    const texts: string[] = [];
    while (walker.nextNode()) texts.push(walker.currentNode.nodeValue ?? '');
    return texts.join(' ').split(/\s+/).filter(Boolean).length;
  });
  report('long note', { markdownWords: words, editorWords: shown, chars: markdown.length });
  expect(words).toBeGreaterThanOrEqual(10_000);
  expect(words).toBeLessThan(10_500);
  expect(shown).toBeGreaterThanOrEqual(10_000);
  await expect(body(page).locator('h2').first()).toBeVisible();
  await expect(body(page).locator('ul li').first()).toBeVisible();
  await expect(body(page).locator('ol li').first()).toBeVisible();
  // T44: the note's line symbols are drawn (in the margin) while the budgets are measured.
  const symbolLines = markdown
    .split('\n')
    .filter((line) => /^(## \? |- → |- \[[ x]\] ! ★ )/.test(line)).length;
  expect(symbolLines).toBeGreaterThan(30);
  await expect(body(page).locator('.pm-symbols')).toHaveCount(symbolLines);
  // Every note stored on this device and pushed before anything is measured: no sync runs
  // while the budgets are measured.
  await expectSynced(page);
}

/**
 * Typing latency, measured in the page per keystroke: from the key event's own timestamp
 * (`event.timeStamp`, taken when the input reached the browser, so a wait for a main thread
 * still busy with earlier work counts) to the end of the work the keystroke does before the
 * browser can draw it. That end is taken after the keystroke's last event (keydown, then
 * keypress and input for text; Enter is handled at keydown) has run every listener, in a
 * window listener of the bubble phase, after the microtasks queued meanwhile have run
 * (ProseMirror's DOM observer flush, the Yjs binding and its observers, React's synchronous
 * updates from external stores): a chain of microtasks, then forced style and layout
 * (`offsetHeight`), then `performance.now()`.
 *
 * Painting and the wait for the next frame (vsync) are left out: they depend on the
 * display's refresh, not on Penmoss, and a 16 ms budget that included up to a frame of
 * waiting could never be met. That is also why the end is not a later task: after a key
 * event Chrome holds ordinary tasks (setTimeout, MessageChannel) until the frame is drawn,
 * so such a probe measures vsync. Work an editor defers to later tasks is not dropped: keys
 * come every 40 ms (faster than a fast typist), so deferred work that is still running
 * when the next key arrives delays that key, which counts from its own timestamp.
 */
function installKeyProbe(page: Page): Promise<void> {
  return page.evaluate(() => {
    interface Key {
      key: string;
      start: number;
      end: number;
    }
    const keys: Key[] = [];
    let current: Key | null = null;
    /** Runs `done` after `hops` microtask turns: after microtasks queued before or meanwhile. */
    const afterMicrotasks = (hops: number, done: () => void) => {
      if (hops === 0) done();
      else queueMicrotask(() => afterMicrotasks(hops - 1, done));
    };
    // First in: the capture phase on window, before the app's own listeners run.
    window.addEventListener(
      'keydown',
      (event) => {
        current = { key: event.key, start: event.timeStamp, end: 0 };
        keys.push(current);
      },
      true,
    );
    // Last out: the bubble phase on window, after the editor's handlers.
    for (const type of ['keydown', 'keypress', 'input'] as const) {
      window.addEventListener(type, () => {
        const key = current;
        if (!key) return;
        afterMicrotasks(20, () => {
          void document.body.offsetHeight;
          key.end = Math.max(key.end, performance.now());
        });
      });
    }
    (window as unknown as { penmossKeys: unknown }).penmossKeys = {
      reset: () => {
        keys.length = 0;
        current = null;
      },
      /** Resolves once the last keystroke was handled and `gap` ms have passed since it. */
      settled: (gap: number) =>
        new Promise<void>((resolve) => {
          const check = () => {
            const last = keys.at(-1);
            const since = performance.now() - (last?.start ?? 0);
            // A key whose events never reached the probe resolves too, and fails on its 0 end.
            if (!last || (last.end > 0 && since >= gap) || since > 2000) resolve();
            else setTimeout(check, Math.max(1, gap - since));
          };
          check();
        }),
      latencies: () => keys.map((key) => ({ key: key.key, ms: key.end - key.start })),
    };
  });
}

interface KeyProbe {
  reset(): void;
  settled(gap: number): Promise<void>;
  latencies(): { key: string; ms: number }[];
}

/**
 * ~`length` keystrokes of prose: letters, spaces and punctuation, with Backspace (a typo
 * fixed) and Enter (a new paragraph) mixed in. No `#`, `[` or `/`, which open pickers.
 */
function keystrokes(length: number, offset: number): string[] {
  const text =
    'then we walked along the river, past the old mill and the orchard where ' +
    'the pears were nearly ripe. later that evening the harbor lights came on one by one ' +
    'and the wind turned cold. ';
  const keys: string[] = [];
  let i = offset;
  while (keys.length < length) {
    const char = text[i % text.length]!;
    i++;
    keys.push(char === ' ' ? 'Space' : char);
    if (keys.length % 23 === 0) keys.push('x', 'q', 'Backspace', 'Backspace');
    if (keys.length % 37 === 0) keys.push('z', 'Backspace');
    if (char === '.' || keys.length % 51 === 0) keys.push('Enter');
  }
  return keys.slice(0, length);
}

/** Types `keys` at a brisk pace (one keystroke at most every `gap` ms); returns latencies. */
async function typeMeasured(page: Page, keys: readonly string[], gap: number) {
  await page.evaluate(() => (window as unknown as { penmossKeys: KeyProbe }).penmossKeys.reset());
  for (const key of keys) {
    await page.keyboard.press(key);
    await page.evaluate(
      (ms) => (window as unknown as { penmossKeys: KeyProbe }).penmossKeys.settled(ms),
      gap,
    );
  }
  const latencies = await page.evaluate(() =>
    (window as unknown as { penmossKeys: KeyProbe }).penmossKeys.latencies(),
  );
  expect(latencies).toHaveLength(keys.length);
  return latencies;
}

/**
 * Note switching, measured in the page: from the click on the note in the sidebar (the
 * click event's timestamp) until the note view shows the target note ready: `data-ready`,
 * its title in the title field and its text in the editor, with style and layout done
 * (`offsetHeight`). As above, paint and the wait for the next frame are left out.
 */
function armSwitch(page: Page, title: string, text: string): Promise<void> {
  return page.evaluate(
    ({ title, text }) => {
      const state: { start: number | null; done: Promise<number> } = {
        start: null,
        done: Promise.resolve(0),
      };
      state.done = new Promise<number>((resolve) => {
        const onClick = (event: MouseEvent) => {
          state.start = event.timeStamp;
          window.removeEventListener('click', onClick, true);
        };
        window.addEventListener('click', onClick, true);
        const shown = () => {
          const view = document.querySelector<HTMLElement>('[data-testid="note-view"]');
          if (state.start === null || view?.dataset['ready'] !== 'true') return false;
          const field = view.querySelector<HTMLInputElement>('[data-testid="note-title"]');
          const editor = view.querySelector('[data-testid="note-body"] .ProseMirror');
          return field?.value === title && (editor?.textContent ?? '').includes(text);
        };
        const observer = new MutationObserver(() => {
          if (!shown()) return;
          observer.disconnect();
          void document.body.offsetHeight;
          resolve(performance.now() - state.start!);
        });
        observer.observe(document.body, {
          subtree: true,
          childList: true,
          attributes: true,
          characterData: true,
        });
      });
      (window as unknown as { penmossSwitch: typeof state }).penmossSwitch = state;
    },
    { title, text },
  );
}

async function switchTo(page: Page, title: string, text: string): Promise<number> {
  await armSwitch(page, title, text);
  await page.getByTestId('note-list').getByRole('link', { name: title }).click();
  const ms = await page.evaluate(
    () => (window as unknown as { penmossSwitch: { done: Promise<number> } }).penmossSwitch.done,
  );
  // Then wait for the rest of the open (sync connect, backlinks) before the next switch.
  await expect(page.getByTestId('note-view')).toHaveAttribute('data-ready', 'true');
  await expect(page.getByTestId('note-title')).toHaveValue(title);
  await quiet(page);
  return ms;
}

// Not serial: one budget failing still measures the other (a new worker makes the notes again).
test.describe('performance budgets with a 10,000-word note', () => {
  // A breach always shows: CI retries other specs once, never these.
  test.describe.configure({ retries: 0 });
  let mac: GitHost;
  let page: Page;
  let errors: string[];

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(120_000);
    // The production build (`vite preview`, as the Mac app ships it): the dev server runs
    // React's development build and unbundled modules, several times slower than what ships.
    // A stand-in Mac with one notebook, as the Mac app runs the page (T59).
    mac = new GitHost();
    await mac.seed();
    const context = await macContext(browser, mac, {
      baseURL: PREVIEW,
      permissions: ['clipboard-read', 'clipboard-write'],
      viewport: { width: 1280, height: 800 },
    });
    page = await context.newPage();
    errors = collectErrors(page);
    await makeNotes(page);
    // T45: two note windows beside the main window, on the long note and the short one.
    for (const title of [LONG_TITLE, SHORT_TITLE]) {
      await page.getByTestId('note-list').getByRole('link', { name: title }).click();
      await expect(page.getByTestId('note-title')).toHaveValue(title);
      const [popup] = await Promise.all([
        context.waitForEvent('page'),
        noteAction(page, 'open-in-window'),
      ]);
      await expect(popup.getByTestId('note-title')).toHaveValue(title);
      await expect(popup.getByTestId('note-view')).toHaveAttribute('data-ready', 'true');
      collectErrors(popup, errors);
    }
    await page.bringToFront();
    report('windows open', { pages: context.pages().length });
    expect(context.pages()).toHaveLength(3);
  });

  test.afterAll(async () => {
    await page.context().close();
    await mac.close();
  });

  test('T31: typing latency p95 < 16 ms in a 10,000-word note @budget', async () => {
    test.setTimeout(180_000);
    await page.getByTestId('note-list').getByRole('link', { name: LONG_TITLE }).click();
    await expect(page.getByTestId('note-view')).toHaveAttribute('data-ready', 'true');
    await expect(page.getByTestId('note-title')).toHaveValue(LONG_TITLE);

    // The caret mid-document: the end of the middle paragraph.
    const paragraphs = body(page).locator(':scope > p');
    const count = await paragraphs.count();
    expect(count).toBeGreaterThan(100);
    const middle = paragraphs.nth(Math.floor(count / 2));
    await middle.scrollIntoViewIfNeeded();
    await middle.click();
    await page.keyboard.press(LINE_END);
    await expect(body(page)).toBeFocused();
    await installKeyProbe(page);
    await quiet(page);

    // Warm-up (discarded): JIT, first-use code paths, caches.
    await typeMeasured(page, keystrokes(60, 0), 40);
    await quiet(page);

    const runs: { p50: number; p95: number; max: number; keys: number }[] = [];
    for (let run = 0; run < 3; run++) {
      const latencies = await typeMeasured(page, keystrokes(150, 40 + run * 61), 40);
      const ms = latencies.map((entry) => entry.ms);
      // Every keystroke reached the probe (a 0 end would read as a negative latency).
      expect(Math.min(...ms)).toBeGreaterThan(0);
      runs.push({
        p50: round(quantile(ms, 0.5)),
        p95: round(quantile(ms, 0.95)),
        max: round(Math.max(...ms)),
        keys: ms.length,
      });
      const byKind = (kind: (key: string) => boolean) =>
        round(
          quantile(
            latencies.filter((entry) => kind(entry.key)).map((entry) => entry.ms),
            0.95,
          ),
        );
      report(`typing run ${run + 1}`, {
        ...runs.at(-1),
        p95Enter: byKind((key) => key === 'Enter'),
        p95Backspace: byKind((key) => key === 'Backspace'),
        p95Text: byKind((key) => key.length === 1),
      });
      await quiet(page);
    }
    const p95 = quantile(
      runs.map((run) => run.p95),
      0.5,
    );
    report('typing', { medianP95: round(p95), budget: TYPING_BUDGET_MS });

    // Everything typed landed in the note, once.
    await expect(body(page)).toContainText('harbor lights came on');
    expect(p95).toBeLessThan(TYPING_BUDGET_MS);
    expect(errors).toEqual([]);
  });

  const summary = (samples: number[]) => ({
    median: round(quantile(samples, 0.5)),
    p95: round(quantile(samples, 0.95)),
    samples: samples.map(round),
  });

  test('T31: switching back to a note shown a moment ago takes < 150 ms @budget', async () => {
    test.setTimeout(120_000);
    const longText = LONG_END;
    // Start on the short note; the long one is in the local replica (synced above).
    await switchTo(page, SHORT_TITLE, SHORT_TEXT);
    await expectSynced(page);

    // Warm-up (discarded), then alternate: each note was shown a moment ago, so its
    // editor is kept and shows again without reading or binding the note.
    for (let i = 0; i < 2; i++) {
      await switchTo(page, LONG_TITLE, longText);
      await switchTo(page, SHORT_TITLE, SHORT_TEXT);
    }
    const toLong: number[] = [];
    const toShort: number[] = [];
    for (let i = 0; i < SAMPLES; i++) {
      toLong.push(await switchTo(page, LONG_TITLE, longText));
      toShort.push(await switchTo(page, SHORT_TITLE, SHORT_TEXT));
    }
    report('switch back to the long note', summary(toLong));
    report('switch back to the short note', summary(toShort));
    expect(quantile(toLong, 0.5)).toBeLessThan(SWITCH_BUDGET_MS);
    expect(quantile(toShort, 0.5)).toBeLessThan(SWITCH_BUDGET_MS);
    expect(errors).toEqual([]);
  });

  test('T31: opening the long note from the local replica takes < 150 ms @budget', async () => {
    test.setTimeout(180_000);
    const longText = LONG_END;
    // Between two opens of the long note, three others: its kept editor is closed by then
    // (kept-editors.ts keeps two), so each open reads, decodes and binds the note again.
    const others = [{ title: SHORT_TITLE, text: SHORT_TEXT }, ...OTHERS];
    const cycle = async () => {
      for (const other of others) await switchTo(page, other.title, other.text);
      return switchTo(page, LONG_TITLE, longText);
    };
    await expectSynced(page);

    // Warm-up (discarded).
    for (let i = 0; i < 2; i++) await cycle();
    const toLong: number[] = [];
    for (let i = 0; i < SAMPLES; i++) toLong.push(await cycle());
    report('open the long note from the local replica', summary(toLong));
    expect(quantile(toLong, 0.5)).toBeLessThan(SWITCH_BUDGET_MS);
    expect(errors).toEqual([]);
  });
});
