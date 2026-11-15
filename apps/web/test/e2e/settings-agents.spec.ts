// Settings → Agents (A1578): every agent in one table, its setup in a drawer.
import { expect, test } from './fixtures';
import { collectErrors } from './support/app';

const SHOTS = process.env['PENMOSS_EVIDENCE'];

test.describe('in Quanta', () => {
  test.use({ seed: { name: 'Quanta', notes: [{ title: 'Current' }] } });

  test('a row opens its drawer; Esc closes it and gives the row the focus back', async ({
    page,
  }) => {
    const errors = collectErrors(page);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto('/settings/agents');
    const agents = page.getByTestId('agents-settings');
    const row = agents.getByTestId('agents-row').filter({ hasText: 'Quanta' });
    await expect(row).toHaveText(/^Any Agent\s*Shared\s*Quanta\s*Ready$/);
    await expect(row.getByTestId('notebook-badge')).toBeVisible();

    // From the keyboard: the row is a button.
    await row.focus();
    await page.keyboard.press('Enter');
    const drawer = page.getByRole('complementary', { name: 'Any Agent on Quanta' });
    await expect(drawer).toBeVisible();
    await expect(row).toHaveAttribute('aria-expanded', 'true');
    await expect(row).toHaveAttribute('data-selected', 'true');
    // Focus is in the drawer, on its title.
    await expect(drawer.getByRole('heading', { name: /Any Agent/ })).toBeFocused();
    await expect(drawer.getByTestId('agents-drawer-sub')).toHaveText(
      'Quanta · shared by every agent on this Mac · named “Agent” in History',
    );
    // Its setup, a tab per client: Claude Code's command, Codex's lines, any other client's.
    await expect(drawer.getByRole('tab')).toHaveText(['Claude Code', 'Codex', 'Other']);
    await expect(drawer.getByTestId('git-local-agent-claude').locator('code')).toHaveText(
      /^claude mcp add penmoss-quanta-agent -- .* mcp --notebook quanta-agent$/,
    );
    await expect(drawer.getByRole('switch', { name: /Receive Comments Sent to It/ })).toBeVisible();
    await drawer.getByRole('tab', { name: 'Codex' }).click();
    await expect(drawer.getByTestId('git-local-agent-codex')).toContainText(
      '[mcp_servers."penmoss-quanta-agent"]',
    );
    await expect(drawer.getByRole('switch')).toHaveCount(0);
    await drawer.getByRole('tab', { name: 'Other' }).click();
    await expect(drawer.getByTestId('git-local-agent-other').locator('code')).toHaveText(
      /mcp --notebook quanta-agent$/,
    );
    await expect(drawer.getByTestId('git-local-agent-server')).toHaveText('penmoss-quanta-agent');
    await expect(drawer).toContainText('penmoss mcp --notebook Quanta');
    // The copy every agent shares goes only with the notebook: no Disconnect.
    await expect(drawer.getByRole('button', { name: 'Disconnect…' })).toHaveCount(0);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/agents-drawer.png` });

    // Esc closes it, and the row has the focus again.
    await page.keyboard.press('Escape');
    await expect(drawer).toHaveCount(0);
    await expect(row).toBeFocused();
    await expect(row).toHaveAttribute('aria-expanded', 'false');
    expect(errors).toEqual([]);
  });

  test('Connect an Agent… in the drawer, then its setup; Disconnect… asks first', async ({
    page,
  }) => {
    const errors = collectErrors(page);
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto('/settings/agents');
    const agents = page.getByTestId('agents-settings');
    await expect(agents.getByTestId('agents-row')).toHaveCount(1);
    const connect = agents.getByRole('button', { name: 'Connect an Agent…' });
    await connect.click();
    const form = page.getByRole('complementary', { name: 'Connect an Agent' });
    const name = form.getByRole('textbox', { name: 'Agent Name' });
    await expect(name).toBeFocused();
    await expect(name).toHaveValue('Claude Code');
    await form.getByRole('combobox', { name: 'Agent', exact: true }).selectOption('codex');
    await expect(name).toHaveValue('Codex');
    await expect(form.getByTestId('agents-connect-notebook')).toHaveText('Quanta');
    await form.getByRole('button', { name: 'Connect' }).click();

    // The new agent's drawer, on the Codex tab it was connected for.
    const drawer = page.getByRole('complementary', { name: 'Codex on Quanta' });
    await expect(drawer.getByTestId('git-local-agent-message')).toContainText('Connected “Codex”');
    await expect(drawer.getByRole('tab', { name: 'Codex' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(drawer.getByTestId('agents-drawer-sub')).toHaveText(
      'Quanta · its own copy · named “Codex” in History',
    );
    const rows = agents.getByTestId('agents-row');
    await expect(rows).toHaveCount(2);
    await expect(rows.first()).toHaveText(/^Codex\s*Quanta\s*Ready$/);
    await expect(rows.first()).toHaveAttribute('data-selected', 'true');

    // Disconnect… asks, and Cancel leaves it.
    await drawer.getByRole('button', { name: 'Disconnect…' }).click();
    const confirm = page.getByRole('dialog', { name: 'Disconnect “Codex”?' });
    await expect(confirm).toContainText('Removes its copy of Quanta from this Mac.');
    // Esc cancels the confirm only, not the drawer under it.
    await page.keyboard.press('Escape');
    await expect(confirm).toHaveCount(0);
    await expect(drawer).toBeVisible();
    await drawer.getByRole('button', { name: 'Disconnect…' }).click();
    await confirm.getByRole('button', { name: 'Disconnect', exact: true }).click();
    await expect(drawer).toHaveCount(0);
    await expect(rows).toHaveCount(1);
    await expect(agents.getByTestId('agents-notice')).toHaveText(
      'Disconnected “Codex”. Remove penmoss-quanta-codex from its MCP servers too.',
    );
    await expect(connect).toBeFocused();
    expect(errors).toEqual([]);
  });

  test('on a narrow window the drawer covers the page', async ({ page }) => {
    await page.setViewportSize({ width: 600, height: 800 });
    await page.goto('/settings/agents');
    await page.getByTestId('agents-row').click();
    const drawer = page.getByTestId('agents-drawer');
    await expect(drawer).toBeVisible();
    const box = (await drawer.boundingBox())!;
    expect(Math.round(box.x)).toBe(0);
    expect(Math.round(box.width)).toBe(600);
    await drawer.getByRole('button', { name: 'Close' }).click();
    await expect(drawer).toHaveCount(0);
  });
});
