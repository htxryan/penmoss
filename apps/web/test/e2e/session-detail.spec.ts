// PEN-177: session detail, as the page records it (AC1, AC5, AC8–AC11, AC14, AC15). A nested
// folder is opened and closed in the sidebar tree by click and key, a fixture note with a block
// of every common kind is opened from it, its cursor moved, 40 characters typed, a block split
// and a selection made across two blocks; then the palette and Search Settings are typed in.
// Each step's events are read from the page's memory sink (window.__penmossAnalytics), which
// keeps the real ids in `refs` apart from the props: only the Mac's main process makes refs, so
// no prop may hold the note's id, title or folder. The events go in the report as JSON.
import { replayShape, type Props } from '@penmoss/core/analytics';
import type { Page } from '@playwright/test';
import { expect, seeded, test } from './fixtures';
import { body, collectErrors, holdForProof } from './support/app';

const RUN = `d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
const NOTE = `Session Note ${RUN}`;

/** A block of each common kind; its tokens are SHAPE. */
const MARKDOWN = [
  '## Steps',
  '',
  'Alpha line',
  '',
  'Beta line',
  '',
  'Gamma line',
  '',
  'Delta line',
  '',
  '- one',
  '  - two',
  '',
  'Then a list of numbers.',
  '',
  '1. first',
  '',
  'And a checklist.',
  '',
  '- [x] done',
  '',
  '> quoted',
  '',
  '```ts',
  'let a = 1;',
  '```',
  '',
  '| A | B |',
  '| --- | --- |',
  '| 1 | 2 |',
  '',
  '---',
  '',
  'End.',
  '',
].join('\n');

const SHAPE = [
  'h2:5',
  'p:10',
  'p:9',
  'p:10',
  'p:10',
  'li.b.1:3',
  'li.b.2:3',
  'p:23',
  'li.n.1:5',
  'p:16',
  'li.t.1:4',
  'quote:6',
  'code:10',
  'table.2x2:4',
  'hr',
  'p:4',
];

test.use({
  seed: {
    name: 'Notes',
    folders: ['Projects', 'Projects/Work'],
    notes: [{ title: NOTE, markdown: MARKDOWN, folder: 'Projects/Work' }],
  },
});

interface Recorded {
  readonly kind: string;
  readonly name: string;
  readonly props: Props;
  /** When the page recorded it (ms). */
  readonly at: number;
  readonly refs?: { readonly note?: string | undefined; readonly folder?: string | undefined };
}

/** The page's session detail so far, oldest first. */
async function detail(page: Page): Promise<Recorded[]> {
  const events = await page.evaluate(() => window.__penmossAnalytics ?? []);
  return events
    .filter((event) => ['note', 'input', 'tree'].includes(event.kind))
    .map(({ kind, name, props, at, refs }) => ({
      kind,
      name,
      props: props ?? {},
      at,
      ...(refs ? { refs } : {}),
    }));
}

const of = (events: readonly Recorded[], kind: string, name?: string) =>
  events.filter((event) => event.kind === kind && (name === undefined || event.name === name));

test('the tree, a note’s shape, typing, splits, the cursor, a selection and typed lengths are recorded, never the words (PEN-177)', async ({
  page,
}, testInfo) => {
  test.setTimeout(90_000);
  const errors = collectErrors(page);
  await page.goto('/');

  // --- The sidebar tree (AC15): open Projects by click, Work by click, close and open it by key.
  const projects = page.getByRole('treeitem', { name: 'Projects', exact: true });
  await projects.click();
  await expect(projects).toHaveAttribute('aria-expanded', 'true');
  const work = page.getByRole('treeitem', { name: 'Work', exact: true });
  await work.click();
  await expect(work).toHaveAttribute('aria-expanded', 'true');
  await work.focus();
  await page.keyboard.press('ArrowLeft');
  await expect(work).toHaveAttribute('aria-expanded', 'false');
  await page.keyboard.press('ArrowRight');
  await expect(work).toHaveAttribute('aria-expanded', 'true');
  const noteRow = page.getByRole('treeitem', { name: NOTE });
  await holdForProof(page, 1_000);
  await noteRow.click();
  await expect(page.getByTestId('note-view')).toHaveAttribute('data-ready', 'true');
  await expect(body(page)).toContainText('Delta line');

  await expect.poll(async () => of(await detail(page), 'tree').length).toBeGreaterThanOrEqual(5);
  const tree = of(await detail(page), 'tree');
  expect(tree.map((event) => [event.name, event.props])).toEqual([
    ['expand', { depth: 0, source: 'click' }],
    ['expand', { depth: 1, source: 'click' }],
    ['collapse', { depth: 1, source: 'key' }],
    ['expand', { depth: 1, source: 'key' }],
    ['open', { depth: 2, source: 'click' }],
  ]);
  const workRef = tree[1]!.refs?.folder;
  expect(workRef).toBeTruthy();
  expect(tree[0]!.refs?.folder).not.toBe(workRef);
  expect(tree[4]!.refs).toEqual({ note: expect.any(String), folder: workRef });

  // --- The note's shape (AC5): its blocks in order, and its title's length.
  await expect.poll(async () => of(await detail(page), 'note', 'open').length).toBe(1);
  const [open] = of(await detail(page), 'note', 'open');
  expect(open!.props).toEqual({ how: 'open', titleChars: NOTE.length, shape: SHAPE });
  expect(open!.refs).toEqual({ note: tree[4]!.refs!.note, folder: workRef });
  await holdForProof(page, 1_000);

  // --- The cursor (AC10): into block 3, then the arrow down into block 4.
  const paragraph = (text: string) => body(page).locator('p', { hasText: text });
  await paragraph('Gamma line').click();
  await page.waitForTimeout(1_200);
  await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(1_200);
  await page.keyboard.press('End');
  await page.waitForTimeout(1_200);
  const cursors = of(await detail(page), 'note', 'cursor').map((event) => event.props);
  expect(cursors.slice(-2)).toEqual([{ block: 3 }, { block: 4 }]);

  // --- Typing (AC8): 40 characters in about 3 s, as at most one burst a second that add up to
  // 40: 3 or 4 bursts when the typing takes 3 s. A loaded runner types more slowly, so the most
  // allowed follows how long the typing took, and each burst is a second or more after the last.
  const before = of(await detail(page), 'note', 'typing').length;
  const started = Date.now();
  await page.keyboard.type('ж'.repeat(40), { delay: 75 });
  const typedFor = Date.now() - started;
  await page.waitForTimeout(1_500);
  const bursts = of(await detail(page), 'note', 'typing').slice(before);
  expect(bursts.length).toBeGreaterThanOrEqual(3);
  expect(bursts.length).toBeLessThanOrEqual(Math.floor(typedFor / 1_000) + 1);
  for (let i = 1; i < bursts.length; i += 1) {
    expect(bursts[i]!.at - bursts[i - 1]!.at).toBeGreaterThanOrEqual(950);
  }
  expect(bursts.every((burst) => burst.props['block'] === 4)).toBe(true);
  expect(bursts.reduce((sum, burst) => sum + (burst.props['typed'] as number), 0)).toBe(40);
  // No typing moved the cursor: nothing new for it.
  expect(of(await detail(page), 'note', 'cursor')).toHaveLength(cursors.length);
  await holdForProof(page, 1_000);

  // --- A split (AC9): Enter 20 characters from the block's end.
  for (let i = 0; i < 20; i++) await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('Enter');
  await expect
    .poll(async () => of(await detail(page), 'note', 'blocks').map((event) => event.props))
    .toEqual([{ block: 4, removed: 1, inserted: ['p:30', 'p:20'] }]);
  await holdForProof(page, 1_000);

  // --- A selection across two blocks (AC11): from Beta's start down a line.
  await paragraph('Beta line').click();
  await page.keyboard.press('Home');
  await page.keyboard.press('Shift+ArrowDown');
  await page.waitForTimeout(1_500);
  const [selected] = of(await detail(page), 'note', 'select');
  expect(selected!.props).toEqual({ block: 2, chars: 9, span: 2 });
  await holdForProof(page, 1_000);

  // The replay of the note's events ends at its blocks now (AC13).
  const events = await detail(page);
  const noteEvents = of(events, 'note');
  const replayed = replayShape(
    open!.props,
    noteEvents.slice(1).map((event) => ({ kind: 'note', name: event.name, props: event.props })),
  );
  expect(replayed).toEqual([...SHAPE.slice(0, 4), 'p:30', 'p:20', ...SHAPE.slice(5)]);

  // --- Typed lengths (AC14): the palette, by length only.
  // Out of the note first: ⌘K there is Insert Link.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('ControlOrMeta+KeyK');
  const palette = page.getByRole('dialog').last();
  await expect(palette).toBeVisible();
  await page.keyboard.type('zebra', { delay: 40 });
  await expect
    .poll(async () => of(await detail(page), 'input', 'palette').map((event) => event.props))
    .toEqual([{ field: 'query', chars: 5 }]);

  // Nothing of the note's words, its title, its id or its folder's in any prop.
  const all = await detail(page);
  const props = JSON.stringify(all.map((event) => event.props));
  for (const word of ['Steps', 'Alpha', 'Gamma', 'ж', 'zebra', NOTE, 'Projects', 'Work']) {
    expect(props).not.toContain(word);
  }
  for (const id of [open!.refs!.note!, workRef!]) expect(props).not.toContain(id);
  await testInfo.attach('session-detail-events.json', {
    body: JSON.stringify(all, null, 2),
    contentType: 'application/json',
  });
  await holdForProof(page, 2_000);
  await expect(palette).toBeVisible();
  expect(errors).toEqual([]);
});

test('Search Settings and Quick Open record what is typed by its length, also as they close (PEN-177 AC14)', async ({
  page,
}) => {
  await page.goto('/');
  // Search Settings.
  await page.getByTestId('sidebar-settings').click();
  const search = page.getByTestId('settings-search');
  await search.click();
  await page.keyboard.type('theme', { delay: 40 });
  await expect
    .poll(async () => of(await detail(page), 'input', 'settingsSearch').map((e) => e.props))
    .toEqual([{ field: 'query', chars: 5 }]);
  await expect(search).toHaveAttribute('data-typed', 'settingsSearch');
  // Quick Open.
  await page.keyboard.press('Escape');
  await page.keyboard.press('ControlOrMeta+KeyP');
  await expect(page.getByRole('dialog').last()).toBeVisible();
  await page.keyboard.type('sess', { delay: 40 });
  await expect
    .poll(async () => of(await detail(page), 'input', 'quickOpen').map((e) => e.props))
    .toEqual([{ field: 'query', chars: 4 }]);
  // Closing with a change still settling sends it at once.
  await page.keyboard.type('ion');
  await page.keyboard.press('Escape');
  await expect
    .poll(async () => of(await detail(page), 'input', 'quickOpen').map((e) => e.props))
    .toEqual([
      { field: 'query', chars: 4 },
      { field: 'query', chars: 7 },
    ]);
});

test('the selection toolbar’s link field and Send Feedback’s description record what is typed by its length (PEN-177 AC14)', async ({
  page,
  notebook,
}) => {
  const errors = collectErrors(page);
  await page.goto(`/notes/${seeded(notebook).noteIds[0]}`);
  // The link field, as Android's link dialog: its address by length, never the address.
  await body(page).locator('p', { hasText: 'Gamma line' }).click();
  await page.keyboard.press('Home');
  for (let i = 0; i < 'Gamma'.length; i++) await page.keyboard.press('Shift+ArrowRight');
  await expect(page.getByTestId('selection-toolbar')).toBeVisible();
  await expect.poll(() => page.evaluate(() => getSelection()?.toString())).toBe('Gamma');
  await page.keyboard.press('ControlOrMeta+KeyK');
  const address = page.getByRole('textbox', { name: 'Link address' });
  await expect(address).toBeFocused();
  await expect(address).toHaveAttribute('data-typed', 'link');
  await page.keyboard.type('penmoss.app', { delay: 40 });
  await expect
    .poll(async () => of(await detail(page), 'input', 'link').map((event) => event.props))
    .toEqual([{ field: 'url', chars: 11 }]);
  await page.keyboard.press('Escape');

  // Send Feedback's description, by length.
  await page.getByTestId('sidebar-feedback').click();
  const form = page.getByRole('dialog', { name: 'Send Feedback' });
  await expect(form).toBeVisible();
  const description = form.locator('.feedback-editor');
  await expect(description).toHaveAttribute('data-typed', 'feedback');
  await description.locator('.ProseMirror').click();
  await page.keyboard.type('It flickers', { delay: 40 });
  await expect
    .poll(async () => of(await detail(page), 'input', 'feedback').map((event) => event.props))
    .toEqual([{ field: 'body', chars: 11 }]);
  const props = JSON.stringify((await detail(page)).map((event) => event.props));
  for (const word of ['penmoss', 'flickers']) expect(props).not.toContain(word);
  await holdForProof(page, 1_500);
  await expect(description).toContainText('It flickers');
  expect(errors).toEqual([]);
});
