import { expect, seeded, test, type Page } from './fixtures';
import { THIS_WEEK, LINE_END } from './keys';
import { storedSetting } from './stored';
import { syncNow } from './support/sync';
import { readRemote } from './support/remote';

// T19: daily and weekly notes. ⌘D and ⌘⌥W open the note for today and this week (in the
// synced time zone, America/Chicago by default), creating it from its template; the sidebar
// calendar marks the days that have a note; the bar above a periodic note moves to the
// previous and next period and between a day and its week; Settings → Daily notes changes
// the time zone and the templates, which are the git notebook's own settings (A827), pushed
// with it so every device builds the same daily notes (T59).

const ULID = /\/notes\/([0-9A-HJKMNP-TV-Z]{26})$/;

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(error.message));
  return errors;
}

const body = (page: Page) => page.getByTestId('note-body').locator('.ProseMirror');
const nav = (page: Page) => page.getByTestId('period-nav');
const calendar = (page: Page) => page.getByTestId('calendar');
const idOf = (page: Page) => ULID.exec(new URL(page.url()).pathname)![1]!;

/** `YYYY-MM-DD` in a zone, the way the app decides which day it is. */
function dayIn(timeZone: string, at = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone }).format(at);
}

async function ready(page: Page) {
  await expect(page.getByTestId('app-root')).toBeVisible();
  await expect(page.locator('button[data-command="note.new"]')).toBeVisible();
}

async function opened(page: Page, title: string) {
  await expect(page).toHaveURL(ULID);
  await expect(page.getByTestId('note-title')).toHaveValue(title);
  await expect(page.getByTestId('note-view')).toHaveAttribute('data-ready', 'true');
}

/**
 * Settings → Daily notes, once the notebook has synced: a value set before that is concurrent
 * with the stored one, and a Yjs map keeps either (by client id), so the change could be lost
 * on the next load.
 */
async function openJournalSettings(page: Page) {
  await page.goto('/');
  await ready(page);
  await expect(page.getByTestId('section-sync')).toHaveAttribute('data-state', 'synced', {
    timeout: 40_000,
  });
  await page.keyboard.press('ControlOrMeta+KeyK');
  const palette = page.getByRole('dialog', { name: 'Command Palette' });
  await palette.getByRole('combobox', { name: 'Command Palette' }).fill('Time Zone and Templates');
  await expect(palette.getByRole('option').first()).toContainText('Time Zone and Templates');
  await page.keyboard.press('Enter');
  const settings = page.getByTestId('journal-settings');
  await expect(settings).toBeVisible();
  return settings;
}

test('⌘D opens today from the template, and the bar walks days and weeks', async ({ page }) => {
  const errors = collectErrors(page);
  const today = dayIn('America/Chicago');
  await page.goto('/');
  await ready(page);
  await page.keyboard.press('ControlOrMeta+KeyD');
  await opened(page, today);
  const todayId = idOf(page);
  // The default daily template: two headings, and the cursor in the body.
  await expect(body(page).locator('h2')).toHaveText(['Plan', 'Notes']);
  await expect(body(page)).toBeFocused();

  // Filed under Journal/<year>/<month>, and marked in the calendar.
  const tree = page.getByRole('tree', { name: 'Folders and notes' });
  await expect(tree.getByRole('treeitem', { name: /^Journal/ })).toBeVisible();
  const day = calendar(page).locator(`[data-date="${today}"]`);
  await expect(day).toHaveAttribute('aria-current', 'date');
  await expect(day).toHaveAttribute('data-has-note', 'true');
  await expect(day).toHaveAttribute('aria-pressed', 'true');

  // ⌘D again opens the same note, with nothing added.
  await body(page).press(LINE_END);
  await page.keyboard.type('Water the herbs');
  await page.keyboard.press('ControlOrMeta+KeyD');
  await expect(page).toHaveURL(new RegExp(`/notes/${todayId}$`));
  await expect(body(page).locator('h2')).toHaveCount(2);
  await expect(body(page)).toContainText('Water the herbs');

  // Next day, then back.
  await nav(page).locator('[data-command="journal.next"]').click();
  const tomorrow = new Date(`${today}T12:00:00Z`);
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  await opened(page, tomorrow.toISOString().slice(0, 10));
  await expect(calendar(page).locator(`[data-date="${today}"]`)).toHaveAttribute(
    'aria-pressed',
    'false',
  );
  await nav(page).locator('[data-command="journal.previous"]').click();
  await expect(page).toHaveURL(new RegExp(`/notes/${todayId}$`));
  await expect(body(page)).toContainText('Water the herbs');

  // Day → its week, created from the weekly template, which lists the week's days.
  const weekButton = nav(page).locator('[data-command="journal.week"]');
  const week = /(\d{4}-W\d{2})/.exec((await weekButton.textContent()) ?? '')![1]!;
  await weekButton.click();
  await opened(page, week);
  await expect(body(page).locator('h2')).toHaveText(['Goals', 'Review']);
  const days = nav(page).getByRole('list', { name: 'Days of this week' }).getByRole('button');
  await expect(days).toHaveCount(7);
  // Today and tomorrow have notes; on a Sunday tomorrow is in the next ISO week.
  const sunday = new Date(`${today}T12:00:00Z`).getUTCDay() === 0;
  await expect(nav(page).locator('[data-has-note="true"]')).toHaveCount(sunday ? 1 : 2);
  // Week → one of its days.
  await nav(page).locator('.period-day[data-has-note="true"]').first().click();
  await expect(page).toHaveURL(ULID);
  await expect(nav(page).locator('[data-command="journal.week"]')).toHaveAttribute(
    'data-has-note',
    'true',
  );
  expect(errors).toEqual([]);
});

test('⌘⌥W opens this week; weeks step to their neighbours', async ({ page }) => {
  const errors = collectErrors(page);
  await page.goto('/');
  await ready(page);
  await page.keyboard.press(THIS_WEEK);
  await expect(page).toHaveURL(ULID);
  const title = page.getByTestId('note-title');
  await expect(title).toHaveValue(/^\d{4}-W\d{2}$/);
  const week = await title.inputValue();
  await expect(nav(page)).toHaveAttribute('aria-label', 'Weekly notes');
  const thisWeekId = idOf(page);

  await nav(page).locator('[data-command="journal.next"]').click();
  await expect(title).not.toHaveValue(week);
  await expect(title).toHaveValue(/^\d{4}-W\d{2}$/);
  await expect(body(page).locator('h2')).toHaveText(['Goals', 'Review']);
  await nav(page).locator('[data-command="journal.previous"]').click();
  await expect(page).toHaveURL(new RegExp(`/notes/${thisWeekId}$`));
  await expect(title).toHaveValue(week);

  // The calendar marks the week too.
  await expect(calendar(page).locator('.calendar-week[aria-pressed="true"]')).toHaveAttribute(
    'data-has-note',
    'true',
  );
  expect(errors).toEqual([]);
});

test('the time zone and templates in Settings decide the day and the new note', async ({
  page,
  host,
  notebook,
}) => {
  test.setTimeout(90_000);
  const errors = collectErrors(page);
  // 25 hours apart, so these two zones never share a date.
  const west = 'Pacific/Pago_Pago';
  const east = 'Pacific/Kiritimati';
  {
    const settings = await openJournalSettings(page);
    await expect(settings).toContainText('in America/Chicago');
    await settings.getByLabel('Time zone').selectOption(east);
    await expect(settings).toContainText(`Today is ${dayIn(east)} in ${east}`);
    const template = settings.getByLabel('Daily template');
    await template.fill('# Log for {{longDate}}\n\nWeek {{week}}\n');
    await settings.getByRole('button', { name: 'Save' }).first().click();
    await expect(settings.getByRole('status').first()).toHaveText('Saved');

    await page.goto('/');
    await ready(page);
    await expect(calendar(page).locator('[aria-current="date"]')).toHaveAttribute(
      'data-date',
      dayIn(east),
    );
    await page.keyboard.press('ControlOrMeta+KeyD');
    await opened(page, dayIn(east));

    // A day no test has opened (the 15th, three months on) is created from the new template.
    const later = new Date(`${dayIn(east)}T12:00:00Z`);
    later.setUTCDate(15);
    later.setUTCMonth(later.getUTCMonth() + 3);
    const date = later.toISOString().slice(0, 10);
    for (let step = 0; step < 3; step++) {
      await calendar(page).getByRole('button', { name: 'Next Month' }).click();
    }
    await calendar(page).locator(`[data-date="${date}"]`).click();
    await opened(page, date);
    await expect(body(page).locator('h1')).toContainText('Log for');
    await expect(body(page)).toContainText(/Week \d{4}-W\d{2}/);
    await expect(calendar(page).locator(`[data-date="${date}"]`)).toHaveAttribute(
      'data-has-note',
      'true',
    );

    // Another zone moves "today" in the calendar straight away.
    const again = await openJournalSettings(page);
    await again.getByLabel('Time zone').selectOption(west);
    await expect(again).toContainText(`in ${west}`);
    // Settings' back link: in the Mac app, to the note open before Settings (B13).
    await page.locator('.settings-bar .back-link').click();
    await ready(page);
    await expect(calendar(page).locator('[aria-current="date"]')).toHaveAttribute(
      'data-date',
      dayIn(west),
    );
  }
  // The notebook's own settings travel with it: another device reads them from the remote.
  await syncNow(page);
  await expect
    .poll(async () => (await readRemote(host, seeded(notebook).remote)).setting('timeZone'), {
      timeout: 40_000,
    })
    .toBe(west);
  const remote = await readRemote(host, seeded(notebook).remote);
  expect(remote.setting('template.daily')).toBe('# Log for {{longDate}}\n\nWeek {{week}}\n');
  expect(errors).toEqual([]);
});

// T51 item 19 (A947): Settings → Daily Notes chooses where Quick Capture starts; a choice in
// the capture form is for that capture only.
test('Quick Capture starts on the default from Settings every time', async ({ page }) => {
  const errors = collectErrors(page);
  const settings = await openJournalSettings(page);
  const quick = settings.getByTestId('capture-default-setting');
  try {
    await quick.getByText('New Note in Inbox').click();
    await expect(quick.getByRole('radio', { name: 'New Note in Inbox' })).toBeChecked();
    await page.keyboard.press('ControlOrMeta+Shift+KeyK');
    const dialog = page.getByTestId('capture-dialog');
    await expect(dialog.getByRole('radio', { name: 'New Note in Inbox' })).toBeChecked();
    await dialog.getByRole('radio', { name: 'Today’s Note' }).check();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    // Opened again: the default, not the last choice; Settings unchanged.
    await page.keyboard.press('ControlOrMeta+Shift+KeyK');
    await expect(dialog.getByRole('radio', { name: 'New Note in Inbox' })).toBeChecked();
    await page.keyboard.press('Escape');
    await expect(quick.getByRole('radio', { name: 'New Note in Inbox' })).toBeChecked();
    // Stored as this device's setting in the notebook (`device`, A827).
    await expect
      .poll(() => storedSetting(page, 'capture.destination'), { timeout: 10_000 })
      .toBe('inbox');
  } finally {
    await quick.getByText('Today’s Note').click();
    await expect(quick.getByRole('radio', { name: 'Today’s Note' })).toBeChecked();
    await expect
      .poll(() => storedSetting(page, 'capture.destination'), { timeout: 10_000 })
      .toBe('daily');
  }
  expect(errors).toEqual([]);
});
