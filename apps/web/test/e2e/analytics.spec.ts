// PEN-137: opt-in usage analytics, as the Mac app's page shows it. The first run ends with the
// consent question; an install with a notebook and no answer is asked once over the app;
// Settings → Privacy has its rows in order with Advanced closed; Advanced's limits refuse a
// value out of range and ask before a lowering deletes; Analytics Data pages the record; Delete
// My Shared Data asks first. The stand-in Mac's analytics (support/fake-bridge.ts) keep the
// answer, the record and the limits in the page.
import type { Locator, Page } from '@playwright/test';
import { expect, test } from './fixtures';
import { collectErrors, holdForProof } from './support/app';

const nav = (page: Page) => page.getByRole('navigation', { name: /settings sections/i });
const fake = (page: Page) => page.evaluate(() => window.__penmossFakeAnalytics!);

/** `inner` sits within `outer`, its right edge (and its last button's) clear of `outer`'s border. */
async function expectInside(inner: Locator, outer: Locator) {
  const box = (await inner.boundingBox())!;
  const group = (await outer.boundingBox())!;
  const last = (await inner.getByRole('button').last().boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(group.x);
  expect(box.x + box.width).toBeLessThanOrEqual(group.x + group.width - 1);
  expect(last.x + last.width).toBeLessThan(group.x + group.width - 4);
}

/**
 * The two answers are the same button (ac1, ac8): same classes, neither focused, neither primary,
 * each half of the row, with the same border and weight (the pointer moved off first, so neither
 * shows its hover).
 */
async function expectEqualAnswers(scope: Locator) {
  const share = scope.getByRole('button', { name: 'Share Usage Data' });
  const dont = scope.getByRole('button', { name: 'Don’t Share' });
  await expect(share).toBeVisible();
  await expect(dont).toBeVisible();
  expect(await share.getAttribute('class')).toBe(await dont.getAttribute('class'));
  await expect(share).not.toHaveClass(/primary/);
  await expect(share).not.toBeFocused();
  await expect(dont).not.toBeFocused();
  await scope.page().mouse.move(0, 0);
  const look = (button: Locator) =>
    button.evaluate((element) => {
      const style = getComputedStyle(element);
      return [style.borderColor, style.borderWidth, style.fontWeight, style.backgroundColor];
    });
  // A hover leaving runs its transition: the two are compared once it has ended.
  await expect
    .poll(async () => JSON.stringify(await look(share)) === JSON.stringify(await look(dont)))
    .toBe(true);
  const row = (await scope.locator('.consent-answers').boundingBox())!;
  const shareBox = (await share.boundingBox())!;
  const dontBox = (await dont.boundingBox())!;
  expect(Math.abs(shareBox.width - dontBox.width)).toBeLessThan(1);
  // Halves of the row: together, with the gap between them, they fill it.
  expect(shareBox.width).toBeGreaterThan(row.width / 2 - 8);
  expect(shareBox.x).toBeCloseTo(row.x, 0);
  expect(dontBox.x + dontBox.width).toBeCloseTo(row.x + row.width, 0);
}

/** What the question says, wherever it is asked (ac1, ac8). */
async function expectQuestion(scope: Locator) {
  await expect(scope.getByRole('heading', { name: 'Share How You Use Penmoss?' })).toBeVisible();
  await expect(scope.getByTestId('consent-question')).toContainText(
    'Share Usage Data sends it, this setup included, to Penmoss’s developer.',
  );
  await expect(scope.getByRole('heading', { name: 'What Is Recorded' })).toBeVisible();
  await expect(scope.getByRole('heading', { name: 'Never Recorded' })).toBeVisible();
  await expect(scope.getByTestId('consent-recorded')).toContainText(
    'CLI commands and agents’ MCP calls, by name',
  );
  // The window's size and its layout (PEN-174's ac12, ac13): in view, where the proof holds.
  const versions = scope
    .getByTestId('consent-recorded')
    .getByText(
      'The app’s and the system’s versions, the window’s size and layout, and how far you scroll',
      {
        exact: true,
      },
    );
  await versions.scrollIntoViewIfNeeded();
  await expect(versions).toBeInViewport();
  // Session detail (PEN-177's AC20): core's one line, after the CLI's.
  const shape = scope
    .getByTestId('consent-recorded')
    .getByText('The shape of your notes and how much you type, never the words', { exact: true });
  await expect(shape).toBeVisible();
  await expect(scope.getByTestId('consent-never')).toContainText(
    'What you write: notes, titles, tags, links and searches',
  );
  await expect(scope.getByRole('link', { name: 'Privacy Policy' })).toHaveAttribute(
    'href',
    'https://penmoss.app/privacy/',
  );
}

test.describe('the first run (ac1)', () => {
  test.use({ seed: null, analytics: { consent: null } });

  test('ends with the consent question, Last Step, whose answer opens the app', async ({
    page,
    host,
  }) => {
    test.setTimeout(90_000);
    const errors = collectErrors(page);
    await page.goto('/');
    const firstRun = page.getByTestId('first-run');
    await firstRun.getByTestId('first-run-start').click();
    await firstRun.getByTestId('first-run-continue').click();
    await firstRun.getByTestId('first-run-way-url').click();
    await firstRun.getByTestId('first-run-continue').click();
    await firstRun.getByTestId('first-run-url-input').fill(host.bare('fresh'));
    await firstRun.getByTestId('first-run-continue').click();
    await firstRun.getByTestId('first-run-name-input').fill('Field Notes');
    await firstRun.getByTestId('first-run-make').click();

    // Set up and synced: the question, not yet the app.
    const consent = firstRun.getByTestId('first-run-consent');
    await expect(consent).toBeVisible({ timeout: 30_000 });
    await expect(
      consent.getByRole('heading', { name: 'Share How You Use Penmoss?' }),
    ).toBeFocused();
    await expect(consent.locator('.fr-step')).toHaveText('Last Step');
    await expect(consent).not.toContainText('Step 3 of 3');
    await expectQuestion(consent);
    await expectEqualAnswers(consent);
    await expect(consent.getByTestId('first-run-back')).toHaveCount(0);
    // No band of empty card between the closing words and the answers.
    const words = (await consent.getByTestId('consent-question').boundingBox())!;
    const foot = (await consent.locator('.fr-foot').boundingBox())!;
    expect(foot.y - (words.y + words.height)).toBeLessThan(40);
    // Escape answers nothing.
    await page.keyboard.press('Escape');
    await expect(consent).toBeVisible();
    await expect(page.getByTestId('note-title')).toHaveCount(0);
    expect((await fake(page)).consent).toBeNull();
    await holdForProof(page, 2_000);

    await consent.getByRole('button', { name: 'Don’t Share' }).click();
    await expect(page.getByTestId('first-run')).toHaveCount(0);
    await expect(page.getByTestId('note-title')).toHaveValue('Welcome to Penmoss', {
      timeout: 20_000,
    });
    const after = await fake(page);
    expect(after.consent).toBe('no');
    expect(after.calls).toContain('answer:no');
    // The first run's steps were recorded by name, and kept on this Mac (No: never sent).
    await expect
      .poll(async () =>
        (await fake(page)).events
          .filter((event) => event.kind === 'firstrun')
          .map((event) => `${event.name}:${String(event.props.result)}:${event.state}`),
      )
      .toEqual(
        expect.arrayContaining([
          'welcome:done:local',
          'goal:done:local',
          'way:done:local',
          'url:done:local',
          'name:done:local',
          'setup:done:local',
          'consent:done:local',
        ]),
      );
    await holdForProof(page, 2_000);
    expect(errors).toEqual([]);
  });
});

test.describe('an install with a notebook and no answer (ac8)', () => {
  test.use({ analytics: { consent: null, events: 12 } });

  test('is asked once, in a dialog over the app', async ({ page }) => {
    const errors = collectErrors(page);
    await page.goto('/');
    const dialog = page.getByTestId('consent-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAttribute('open', '');
    await expectQuestion(dialog);
    await expectEqualAnswers(dialog);
    // Escape does not close it.
    await page.keyboard.press('Escape');
    await expect(dialog).toBeVisible();
    await holdForProof(page, 2_000);

    await dialog.getByRole('button', { name: 'Share Usage Data' }).click();
    await expect(dialog).toHaveCount(0);
    const answered = await fake(page);
    expect(answered.consent).toBe('yes');
    // What waited for the answer goes with Yes.
    expect(answered.events.filter((event) => event.state === 'pending')).toEqual([]);

    // Never again: not after a reload either.
    await page.reload();
    await expect(page.locator('button[data-command="note.new"]').first()).toBeVisible();
    await expect(page.getByTestId('consent-dialog')).toHaveCount(0);
    await page.goto('/settings/privacy');
    await expect(page.getByRole('switch', { name: 'Share Usage Data' })).toBeChecked();
    await holdForProof(page, 2_000);
    expect(errors).toEqual([]);
  });
});

test.describe('Settings → Privacy', () => {
  test.use({ analytics: { consent: 'no', events: 255 } });

  test('puts Analytics Data under Privacy, flush with the other entries', async ({ page }) => {
    await page.goto('/settings/privacy');
    const mac = nav(page).getByRole('group', { name: /This Mac/ });
    const privacy = mac.getByRole('link', { name: 'Privacy', exact: true });
    const data = mac.getByTestId('settings-privacy-data-entry');
    await expect(data).toBeVisible();
    await data.scrollIntoViewIfNeeded();
    const privacyIcon = (await privacy.locator('svg').boundingBox())!;
    const icon = (await data.locator('svg').boundingBox())!;
    // Ryan, 21 Nov 2026: flush with the other entries, its icon in their column.
    expect(Math.abs(icon.x - privacyIcon.x)).toBeLessThanOrEqual(1);
    await holdForProof(page, 2000);
    await expect(data).toBeInViewport();
  });

  test('is last in This Mac with its shield, its rows in order and Advanced closed (ac2)', async ({
    page,
  }) => {
    const errors = collectErrors(page);
    await page.goto('/settings');
    const mac = nav(page).getByRole('group', { name: /This Mac/ });
    await expect(mac.getByRole('link')).toHaveText([
      'GitHub',
      'Updates',
      'Privacy',
      'Analytics Data',
    ]);
    await mac.getByRole('link', { name: 'Privacy', exact: true }).click();
    await expect(page).toHaveURL(/\/settings\/privacy$/);
    // Its icon: the outline shield with a tick.
    await expect(
      mac
        .getByRole('link', { name: 'Privacy', exact: true })
        .locator('svg path[d^="M12 3.5 19 6"]'),
    ).toHaveCount(1);
    await expect(mac.getByRole('link', { name: 'Privacy', exact: true })).toHaveAttribute(
      'aria-current',
      'page',
    );
    // Analytics Data sits under it, set in.
    await expect(mac.getByTestId('settings-privacy-data-entry')).not.toHaveAttribute(
      'aria-current',
    );

    const section = page.getByTestId('privacy-settings');
    await expect(section.getByRole('heading', { level: 1 })).toHaveText('Privacy');
    await expect(section.getByTestId('settings-intro')).toHaveCount(0);
    await expect(section.locator('.lf-group > [data-setting]')).toHaveCount(4);
    expect(
      await section
        .locator('.lf-group > [data-setting], [data-setting="advanced"]')
        .evaluateAll((all) => all.map((row) => row.getAttribute('data-setting'))),
    ).toEqual(['share-usage-data', 'view-analytics-data', 'analytics-id', 'logs', 'advanced']);
    await expect(page.getByRole('switch', { name: 'Share Usage Data' })).not.toBeChecked();
    await expect(section.getByTestId('privacy-counts')).toHaveText(/^Not Shared \d+$/);
    await expect(section.getByTestId('privacy-id')).toHaveText(/^[0-9a-f]{8}…[0-9a-f]{4}$/);
    await expect(section.getByRole('button', { name: 'Reset My Analytics ID' })).toBeVisible();
    await expect(section.getByRole('button', { name: 'Delete My Shared Data' })).toBeVisible();
    await expect(section.getByRole('button', { name: 'Show Log File' })).toBeVisible();
    await expect(section.locator('[data-setting="logs"]')).toContainText(
      'The last 7 days, on this Mac. They leave only when you attach them to a bug report.',
    );
    await expect(section.getByTestId('privacy-advanced')).not.toHaveAttribute('open');
    // Closed, Advanced says what is inside it.
    await expect(section.getByTestId('privacy-advanced-hint')).toHaveText(
      'How long and how much Penmoss keeps on this Mac',
    );
    // Delete My Shared Data is the app's quiet destructive button: red words, no fill.
    const forget = section.getByRole('button', { name: 'Delete My Shared Data' });
    await expect(forget).toHaveClass(/\bquiet\b/);
    await expect(forget).toHaveClass(/\bdanger\b/);
    const danger = await forget.evaluate((element) => {
      const probe = document.createElement('span');
      probe.style.color = 'var(--pm-danger)';
      element.parentElement!.append(probe);
      const red = getComputedStyle(probe).color;
      probe.remove();
      return [getComputedStyle(element).color, red];
    });
    expect(danger[0]).toBe(danger[1]);
    await expect(section.getByLabel('Keep Events For')).toBeHidden();
    await expect(section.getByRole('link', { name: 'Privacy Policy' })).toHaveAttribute(
      'href',
      'https://penmoss.app/privacy/',
    );

    // Show Log File reveals it in Finder (main's).
    await section.getByRole('button', { name: 'Show Log File' }).click();
    await expect.poll(async () => (await fake(page)).calls).toContain('showLogFile');
    // Sharing on, from the switch.
    await page.getByRole('switch', { name: 'Share Usage Data' }).click();
    await expect(page.getByRole('switch', { name: 'Share Usage Data' })).toBeChecked();
    await expect.poll(async () => (await fake(page)).consent).toBe('yes');
    await section.getByTestId('privacy-advanced-summary').scrollIntoViewIfNeeded();
    await holdForProof(page, 2_000);
    expect(errors).toEqual([]);
  });

  test('Advanced opens in place; a limit out of range is refused, a lowering asks first (ac25, ac27, ac39)', async ({
    page,
  }) => {
    const errors = collectErrors(page);
    await page.goto('/settings/privacy');
    const section = page.getByTestId('privacy-settings');
    await section.getByTestId('privacy-advanced-summary').click();
    await expect(page).toHaveURL(/\/settings\/privacy$/);
    const advanced = section.getByTestId('privacy-advanced');
    await expect(advanced).toHaveAttribute('open', '');
    // Open, the intro says it in full and the subhead's hint steps aside.
    await expect(section.getByTestId('privacy-advanced-hint')).toBeHidden();
    await expect(advanced).toContainText(
      'How much Penmoss keeps on this Mac. Lowering a limit asks first, then deletes what falls outside it.',
    );
    await expect(advanced.locator('.privacy-limit-group-title')).toHaveText([
      'Usage Record',
      'Logs',
      'Bug Reports',
    ]);
    await expect(advanced.locator('.privacy-limit-label')).toHaveText([
      'Keep Events For',
      'Keep at Most',
      'Log File Size',
      'Log Files Kept',
      'Keep Log Lines For',
      'Attach Logs from the Last',
      'At Most',
      'At Most',
    ]);
    const days = advanced.locator('[data-setting="keep-events-for"]');
    await expect(days.getByRole('textbox')).toHaveValue('7');
    await expect(days).toContainText('days');
    await expect(days.getByTestId('privacy-limit-range')).toHaveText('1–360 days');
    await expect(days.getByTestId('privacy-limit-default')).toHaveCount(0);
    // Keep at Most's default and range (PEN-177's AC16), digits grouped.
    const most = advanced.locator('[data-setting="keep-at-most"]');
    await expect(most.getByRole('textbox')).toHaveValue('200,000');
    await expect(most.getByTestId('privacy-limit-range')).toHaveText('500–2,000,000 events');
    // How much each may take (core's estimate: 200,000 events, 2 files of 1 MB).
    await expect(advanced.getByTestId('privacy-space-usage')).toHaveText(
      'About 100 MB of events at most on this Mac',
    );
    await expect(advanced.getByTestId('privacy-space-logs')).toHaveText(
      'Up to 2 MB of logs on this Mac (at most 400 MB)',
    );
    await expect(advanced.getByTestId('privacy-space-report')).toHaveText(
      'A bug report attaches the last 24 hours, at most 300 lines and 16 KB.',
    );
    await expect(advanced.getByTestId('privacy-limits-reset')).toBeVisible();
    await expect(advanced.getByTestId('privacy-limits-foot')).toContainText(
      'Or run penmoss analytics limits in a terminal.',
    );

    // Out of range: said, not saved.
    const field = days.getByRole('textbox');
    await field.fill('400');
    await field.press('Enter');
    await expect(days.getByRole('alert')).toHaveText('Between 1 and 360');
    expect((await fake(page)).limits['events.days']).toBe(7);

    // Lowering that deletes asks first, under the field; Cancel puts the old value back.
    const count = await page.evaluate(
      async () => (await window.penmossDesktop!.analytics!.preview({ 'events.days': 3 })).events,
    );
    expect(count).toBeGreaterThan(0);
    const title = `Delete ${count.toLocaleString('en-US')} Events?`;
    await field.fill('3');
    await field.press('Enter');
    const confirm = days.getByRole('alertdialog', { name: title });
    await expect(confirm).toBeVisible();
    await expect(confirm.locator('.confirm-block-title')).toHaveText(title);
    await expect(confirm).toContainText(
      'They’re older than 3 days. They’re deleted from this Mac now, and raising the limit later won’t bring them back.',
    );
    await expect(confirm.getByRole('button', { name: 'Cancel' })).toBeFocused();
    await expect(confirm.getByRole('button', { name: 'Delete' })).toHaveClass(/danger/);
    await expectInside(confirm, advanced.getByTestId('privacy-limits-usage'));
    await confirm.getByRole('button', { name: 'Cancel' }).click();
    await expect(confirm).toHaveCount(0);
    await expect(field).toHaveValue('7');
    expect((await fake(page)).limits['events.days']).toBe(7);

    // Escape cancels too.
    await field.fill('3');
    await field.press('Enter');
    await expect(confirm).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(confirm).toHaveCount(0);
    await expect(field).toHaveValue('7');

    // Delete saves it, and what fell outside is gone.
    const before = (await fake(page)).events.length;
    await field.fill('3');
    await field.press('Enter');
    await confirm.getByRole('button', { name: 'Delete' }).click();
    await expect(confirm).toHaveCount(0);
    await expect(field).toHaveValue('3');
    await expect(days.getByTestId('privacy-limit-default')).toHaveText('Default: 7');
    const saved = await fake(page);
    expect(saved.limits['events.days']).toBe(3);
    const cutoff = Date.now() - 3 * 86_400_000;
    expect(saved.events.filter((event) => event.at < cutoff)).toEqual([]);
    expect(saved.events.length).toBeLessThan(before);

    // Reset to Defaults puts the field back (raising deletes nothing, so it doesn't ask).
    await advanced.getByTestId('privacy-limits-reset').click();
    await expect(field).toHaveValue('7');
    await expect(days.getByTestId('privacy-limit-default')).toHaveCount(0);
    expect((await fake(page)).limits['events.days']).toBe(7);
    // Lowered again, the field shows it.
    await field.fill('3');
    await field.press('Enter');
    await expect(advanced.getByRole('alertdialog')).toHaveCount(0);
    await expect(days.getByTestId('privacy-limit-default')).toHaveText('Default: 7');
    await expect(field).toHaveValue('3');
    await days.scrollIntoViewIfNeeded();
    await holdForProof(page, 2_000);
    expect(errors).toEqual([]);
  });

  test('Delete My Shared Data asks first, naming the ID; only Delete forgets (ac37)', async ({
    page,
  }) => {
    const errors = collectErrors(page);
    await page.goto('/settings/privacy');
    const row = page.locator('[data-setting="analytics-id"]');
    const id = (await row.getByTestId('privacy-id').textContent())!;
    const button = row.getByRole('button', { name: 'Delete My Shared Data' });
    const confirm = row.getByRole('alertdialog', { name: 'Delete Your Shared Data?' });

    await button.click();
    await expect(confirm).toBeVisible();
    await expect(confirm).toContainText(
      `Penmoss’s server deletes everything this Mac shared under ID ${id}, and this Mac gets a new ID. The record on this Mac stays.`,
    );
    await expect(confirm.getByRole('button', { name: 'Cancel' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(confirm).toHaveCount(0);
    await button.click();
    await confirm.getByRole('button', { name: 'Cancel' }).click();
    await expect(confirm).toHaveCount(0);
    expect((await fake(page)).calls).not.toContain('forget');

    // Inside the group, inset from its edges as main's other confirmations are.
    await button.click();
    await expectInside(confirm, page.getByTestId('privacy-settings').locator('.lf-group').first());
    await confirm.scrollIntoViewIfNeeded();
    await page.mouse.move(0, 0);
    await holdForProof(page, 2_000);
    await confirm.getByRole('button', { name: 'Delete' }).click();
    await expect(row.getByTestId('privacy-id-note')).toHaveText(
      'Your shared data was deleted, and this Mac has a new ID.',
    );
    expect((await fake(page)).calls).toContain('forget');
    await expect(row.getByTestId('privacy-id')).not.toHaveText(id);
    await row.scrollIntoViewIfNeeded();
    await holdForProof(page, 2_000);
    expect(errors).toEqual([]);
  });
});

test.describe('Analytics Data (ac36)', () => {
  test.use({
    analytics: { consent: 'yes', events: 255 },
    permissions: ['clipboard-read', 'clipboard-write'],
  });

  test('keeps each name whole beside long props, which wrap, and never scrolls sideways (PEN-177)', async ({
    page,
  }) => {
    const errors = collectErrors(page);
    await page.setViewportSize({ width: 1100, height: 720 });
    await page.goto('/settings/privacy/data');
    const data = page.getByTestId('analytics-data');
    await expect(data.getByRole('heading', { level: 1 })).toHaveText('Analytics Data');
    // Events of session detail whose props run long, as the Mac records them.
    const ref = 'a1b2c3d4e5f60718';
    const shape = Array.from({ length: 40 }, (_, index) => `p:${100 + index}`);
    await page.evaluate(
      ({ ref, shape }) => {
        const at = Date.now();
        window.penmossDesktop!.analytics!.record([
          {
            kind: 'command',
            name: 'app.palette',
            props: { source: 'key', keys: 'Mod+Shift+P' },
            at,
          },
          {
            kind: 'tree',
            name: 'open',
            props: { note: ref, folder: ref, depth: 3, source: 'click' },
            at,
          },
          { kind: 'tree', name: 'collapse', props: { folder: ref, depth: 2, source: 'key' }, at },
          {
            kind: 'click',
            name: 'privacy.data.filter-client',
            props: { source: 'pointer' },
            at,
          },
          // A name of 28 characters with a hyphen, which the Mac's font once broke after its hyphen.
          {
            kind: 'click',
            name: 'firstrun.welcome.get-started',
            props: { source: 'pointer' },
            at,
          },
          // The catalogue's longest name, which can only break between its words.
          {
            kind: 'click',
            name: 'settings.git-notebooks.signing-key.new-ed25519',
            props: { source: 'pointer' },
            at,
          },
          {
            kind: 'note',
            name: 'open',
            props: { note: ref, folder: ref, how: 'open', titleChars: 24, shape },
            at,
          },
        ]);
      },
      { ref, shape },
    );
    // The viewer reads the record when it opens.
    await page.reload();
    await expect(data.getByRole('heading', { level: 1 })).toHaveText('Analytics Data');
    const rows = data.getByTestId('analytics-data-row');
    const open = rows
      .filter({ has: page.locator('td:nth-child(3)', { hasText: /^note$/ }) })
      .filter({ hasText: ref })
      .first();
    await expect(open).toBeVisible();
    // How many lines a cell's text takes on screen.
    const linesOf = (cells: Locator) =>
      cells.evaluateAll((all) =>
        all.map((cell) => {
          const range = document.createRange();
          range.selectNodeContents(cell);
          return new Set([...range.getClientRects()].map((rect) => Math.round(rect.top))).size;
        }),
      );
    /** Where a cell's text breaks onto its next line: the text before each break. */
    const breaksOf = (cell: Locator) =>
      cell.evaluate((element) => {
        const text = element.textContent ?? '';
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
        const tops: number[] = [];
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          for (let index = 0; index < (node.textContent ?? '').length; index += 1) {
            const range = document.createRange();
            range.setStart(node, index);
            range.setEnd(node, index + 1);
            tops.push(Math.round(range.getBoundingClientRect().top));
          }
        }
        return tops.flatMap((top, index) =>
          index > 0 && top > tops[index - 1]! ? [text.slice(0, index)] : [],
        );
      });
    const longest = rows
      .filter({ hasText: 'settings.git-notebooks.signing-key.new-ed25519' })
      .locator('td:nth-child(4)');
    const whole = rows.filter({ hasText: 'privacy.data.filter-client' }).locator('td:nth-child(4)');
    // At every width the Mac's window takes, from its narrowest (480) up: nothing scrolls sideways,
    // and a name breaks, if it must, only after a dot or a hyphen, never inside a word.
    for (let width = 480; width <= 1280; width += 20) {
      await page.setViewportSize({ width, height: 720 });
      const sideways = await data.evaluate((element) => {
        const wrap = element.querySelector<HTMLElement>('.privacy-table-wrap')!;
        const root = document.documentElement;
        return {
          table: wrap.scrollWidth - wrap.clientWidth,
          page: root.scrollWidth - root.clientWidth,
        };
      });
      expect({ width, ...sideways }).toEqual({ width, table: 0, page: 0 });
      for (const cell of [longest, whole]) {
        for (const before of await breaksOf(cell)) expect(before).toMatch(/[.-]$/);
      }
    }
    // At the proofs' widths (the Mac's window is 1280), every name of up to 29 characters is whole
    // on one line, measured in the name's own font; the longest breaks between its words.
    for (const width of [1280, 1100]) {
      await page.setViewportSize({ width, height: 720 });
      await expect(whole).toHaveText('privacy.data.filter-client');
      expect(await linesOf(whole)).toEqual([1]);
      expect((await breaksOf(longest)).length).toBeGreaterThan(0);
      const nameTexts = await rows.locator('td:nth-child(4)').allTextContents();
      const names = await linesOf(rows.locator('td:nth-child(4)'));
      expect(names.length).toBeGreaterThanOrEqual(6);
      expect(nameTexts).toContain('firstrun.welcome.get-started');
      expect({
        width,
        broken: nameTexts.filter((name, index) => name.length <= 29 && names[index] !== 1),
      }).toEqual({ width, broken: [] });
    }
    await expect(open.locator('td:nth-child(4)')).toHaveText('open');
    // The props beside it wrap instead.
    const [props] = await linesOf(open.locator('td:nth-child(5)'));
    expect(props).toBeGreaterThan(1);
    await open.scrollIntoViewIfNeeded();
    await page.mouse.move(0, 0);
    await holdForProof(page, 2_000);
    await expect(open).toBeInViewport();
    expect(errors).toEqual([]);
  });

  test('pages the record newest first under Privacy, filtered by state and client', async ({
    page,
  }) => {
    const errors = collectErrors(page);
    await page.goto('/settings/privacy');
    await page.getByRole('link', { name: /View Analytics Data/ }).click();
    await expect(page).toHaveURL(/\/settings\/privacy\/data$/);
    const entry = nav(page).getByRole('link', { name: 'Analytics Data' });
    await expect(entry).toHaveAttribute('aria-current', 'page');
    await expect(nav(page).getByRole('link', { name: 'Privacy', exact: true })).not.toHaveAttribute(
      'aria-current',
    );

    const data = page.getByTestId('analytics-data');
    await expect(data.getByRole('heading', { level: 1 })).toHaveText('Analytics Data');
    await expect(data.getByTestId('settings-intro')).toHaveText(
      /^On this Mac, kept 7 days\. ID [0-9a-f]{8}…[0-9a-f]{4}\. Sharing since \d+ \w+ \d{4}\.$/,
    );
    // The counts by state, under the summary, as the Privacy row says them.
    const record = await fake(page);
    const tally = (state: string) => record.events.filter((event) => event.state === state).length;
    await expect(data.getByTestId('analytics-data-counts')).toHaveText(
      new RegExp(`Waiting to Send \\d+ · Sent ${tally('sent')}`),
    );
    await expect(data.getByRole('columnheader')).toHaveText([
      'Time',
      'Client',
      'Kind',
      'Name',
      'Props',
      'State',
    ]);
    const rows = data.getByTestId('analytics-data-row');
    await expect(rows).toHaveCount(100);
    const showing = data.getByTestId('analytics-data-showing');
    await expect(showing).toHaveText(/^Showing 1–100 of \d+$/);
    const total = Number(/of (\d+)/.exec((await showing.textContent())!)![1]);
    expect(total).toBeGreaterThanOrEqual(255);
    await expect(data.getByRole('button', { name: 'Later' })).toBeDisabled();
    // Later and Earlier are an equal pair (PEN-182).
    const later = (await data.getByRole('button', { name: 'Later' }).boundingBox())!;
    const earlier = (await data.getByRole('button', { name: 'Earlier' }).boundingBox())!;
    expect(Math.abs(later.width - earlier.width)).toBeLessThanOrEqual(1);

    // Sent: a set nothing new joins while the test runs (new events wait to be sent).
    const sent = (await fake(page)).events.filter((event) => event.state === 'sent').length;
    expect(sent).toBeGreaterThan(100);
    await data.getByTestId('analytics-data-state').getByText('Sent', { exact: true }).click();
    await expect(showing).toHaveText(`Showing 1–100 of ${sent}`);
    await expect(rows.locator('td:nth-child(6)')).toHaveText(Array(100).fill('Sent'));
    await data.getByRole('button', { name: 'Earlier' }).click();
    await expect(showing).toHaveText(`Showing 101–${sent} of ${sent}`);
    await expect(rows).toHaveCount(sent - 100);
    await expect(data.getByRole('button', { name: 'Earlier' })).toBeDisabled();
    await data.getByRole('button', { name: 'Later' }).click();
    await expect(showing).toHaveText(`Showing 1–100 of ${sent}`);
    await expect(data.getByRole('button', { name: 'Later' })).toBeDisabled();

    // By client: the CLI's alone, then those of them waiting to be sent.
    await data.getByTestId('analytics-data-state').getByText('All', { exact: true }).click();
    await data.getByTestId('analytics-data-client').getByText('CLI', { exact: true }).click();
    await expect(showing).toHaveText('Showing 1–85 of 85');
    await expect(rows.locator('td:nth-child(2)')).toHaveText(Array(85).fill('CLI'));
    await data.getByTestId('analytics-data-state').getByText('Waiting to Send').click();
    await expect(showing).toHaveText(/^Showing 1–\d+ of \d+$/);
    const waiting = await rows.count();
    expect(waiting).toBeGreaterThan(0);
    expect(waiting).toBeLessThan(85);
    await expect(rows.locator('td:nth-child(2)')).toHaveText(Array(waiting).fill('CLI'));
    await expect(rows.locator('td:nth-child(6)')).toHaveText(
      Array(waiting).fill('Waiting to Send'),
    );
    // Each state a tinted chip: waiting amber, sent green.
    const tint = (row: Locator) =>
      row.locator('.chip.privacy-state').evaluate((chip) => getComputedStyle(chip).backgroundColor);
    const amber = await tint(rows.first());
    await data.getByTestId('analytics-data-client').getByText('All', { exact: true }).click();
    await data.getByTestId('analytics-data-state').getByText('Sent', { exact: true }).click();
    await expect(showing).toHaveText(`Showing 1–100 of ${sent}`);
    const green = await tint(rows.first());
    expect(green).not.toBe(amber);

    // Copy as JSON: the events on the page, with nothing sent yet.
    await data.getByRole('button', { name: 'Copy as JSON' }).click();
    const copied = JSON.parse(await page.evaluate(() => navigator.clipboard.readText())) as Array<{
      state: string;
    }>;
    expect(copied.length).toBe(await rows.count());
    expect(new Set(copied.map((event) => event.state))).toEqual(new Set(['sent']));
    // Ends on every state: the summary, the counts under it, and amber and green chips.
    await data.getByTestId('analytics-data-state').getByText('All', { exact: true }).click();
    await expect(rows.locator('.chip.privacy-state[data-state="waiting"]').first()).toBeVisible();
    await expect(rows.locator('.chip.privacy-state[data-state="sent"]').first()).toBeVisible();
    await data.getByRole('heading', { level: 1 }).scrollIntoViewIfNeeded();
    await page.mouse.move(0, 0);
    await holdForProof(page, 2_000);
    expect(errors).toEqual([]);
  });
});
