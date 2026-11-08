import { expect, test, type Page } from './fixtures';

// T17: the graph from the local link index. Opens from the sidebar and a note, shows the
// local graph by depth, opens a note by click and by keyboard, and filters unlinked notes.

const ULID = /\/notes\/([0-9A-HJKMNP-TV-Z]{26})$/;
// Titles start with the tag: type-ahead in the graph jumps to them.
const TAG = `g${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
const HUB = `${TAG} hub`;
const SUN = `${TAG} sun`;
const MOON = `${TAG} moon`;
const LONE = `${TAG} lone`;

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(error.message));
  return errors;
}

async function createNote(page: Page, title: string): Promise<string> {
  await page
    .getByTestId('sidebar-shortcuts')
    .getByRole('button', { name: 'New Note', exact: true })
    .click();
  await expect(page).toHaveURL(ULID);
  await expect(page.getByTestId('note-title')).toBeFocused();
  await page.keyboard.type(title);
  await page.keyboard.press('Enter');
  return ULID.exec(new URL(page.url()).pathname)![1]!;
}

async function linkTo(page: Page, title: string) {
  const menu = page.getByTestId('link-menu');
  await page.keyboard.type(`[[${title}`);
  await expect(menu.getByRole('option').first()).toContainText(title);
  await page.keyboard.press('Enter');
  await expect(menu).toBeHidden();
}

type Point = { x: number; y: number } | null;

/** Where a node is drawn, in page coordinates, once the layout has settled. */
async function nodePoint(page: Page, id: string): Promise<Point> {
  const canvas = page.getByTestId('graph-canvas');
  await expect
    .poll(() =>
      canvas.evaluate(
        (element) =>
          (element as unknown as { penmossGraph: { settled: boolean } }).penmossGraph.settled,
      ),
    )
    .toBe(true);
  const box = (await canvas.boundingBox())!;
  const at = await canvas.evaluate(
    (element, node) =>
      (
        element as unknown as { penmossGraph: { positionOf(id: string): Point } }
      ).penmossGraph.positionOf(node),
    id,
  );
  return at ? { x: box.x + at.x, y: box.y + at.y } : null;
}

test('T17: global and local graphs open notes by click and by keyboard', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/');
  const moon = await createNote(page, MOON);
  const lone = await createNote(page, LONE);
  const sun = await createNote(page, SUN);
  await page.keyboard.type('Orbited by ');
  await linkTo(page, MOON);
  const hub = await createNote(page, HUB);
  await page.keyboard.type('Start at ');
  await linkTo(page, SUN);

  // The sidebar's Graph opens the global graph, around the open note when asked.
  await page.getByTestId('open-graph').click();
  await expect(page).toHaveURL(`/graph?note=${hub}`);
  await expect(page.getByTestId('graph-canvas')).toBeVisible();
  expect(await nodePoint(page, lone)).not.toBeNull();

  // Unlinked notes can be hidden.
  await page.getByTestId('graph-orphans').uncheck();
  expect(await nodePoint(page, lone)).toBeNull();
  expect(await nodePoint(page, moon)).not.toBeNull();
  await page.getByTestId('graph-orphans').check();

  // The local graph: notes within 2 links (the default), then 1.
  await page.getByTestId('graph-local').click();
  await expect(page).toHaveURL(`/graph?note=${hub}&local=1`);
  await expect(page.getByTestId('graph-count')).toHaveText('3 notes · 2 links');
  await page.getByTestId('graph-depth').selectOption('1');
  await expect(page.getByTestId('graph-count')).toHaveText('2 notes · 1 link');

  // Clicking a node opens its note.
  const point = (await nodePoint(page, sun))!;
  await page.mouse.click(point.x, point.y);
  await expect(page).toHaveURL(`/notes/${sun}`);
  await expect(page.getByTestId('note-title')).toHaveValue(SUN);

  // A note's Local Graph: a tab of its side panel (T51, A936), the note staying open.
  await page.getByTestId('note-tab-graph').click();
  await expect(page).toHaveURL(`/notes/${sun}`);
  const local = page.getByTestId('note-graph');
  await expect(local.getByTestId('note-graph-count')).toHaveText('2 notes · 2 links');
  // Open Full Graph: the graph page, around the note.
  await local.getByTestId('open-full-graph').click();
  await expect(page).toHaveURL(`/graph?note=${sun}&local=1`);
  await expect(page.getByTestId('graph-count')).toHaveText('3 notes · 2 links');
  await page.goBack();
  await expect(page).toHaveURL(`/notes/${sun}`);
  // The tab is remembered; operated from the keyboard.
  const canvas = page.getByTestId('note-graph').getByTestId('graph-canvas');
  await canvas.focus();
  await page.keyboard.press('Home');
  await expect(page.getByTestId('graph-announcement')).toContainText(`${SUN}, 2 links`);
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowRight');
  await expect(page.getByTestId('graph-announcement')).toContainText(TAG);
  await page.keyboard.type(`${TAG} m`);
  await expect(page.getByTestId('graph-announcement')).toContainText(`${MOON}, 1 link`);
  await page.keyboard.press('+');
  await page.keyboard.press('0');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(`/notes/${moon}`);

  // Mod+Shift+G opens the graph around the open note.
  await page.keyboard.press('ControlOrMeta+Shift+G');
  await expect(page).toHaveURL(`/graph?note=${moon}`);
  await expect(page.getByTestId('graph-local')).toContainText(MOON);
  expect(errors).toEqual([]);
});
