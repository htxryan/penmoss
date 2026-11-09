/**
 * Git notebook helpers for specs (T59). Moving changes between two Macs on one git notebook, without waiting
 * for the push delay and the minute's pull (A1013): each side runs the palette's “Sync This Git
 * Notebook Now”, the command the Mac's File menu has too. And an agent on its own clone.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  GitNotebookEngine,
  MemorySecrets,
  MemoryStorage,
  NotebookOps,
} from '@penmoss/git-notebook';
import { LocalNotebook } from '@penmoss/git-notebook/local';
import { NodeGitTransport } from '@penmoss/git-notebook/node';
import { expect, type Page } from '@playwright/test';
import type { GitHost } from './git-host';

const SYNC_NOW = 'Sync This Git Notebook Now';

/** A file's bytes on the remote's branch (a picture, an attachment). */
export function remoteBytes(host: GitHost, remote: string, path: string): Buffer {
  const result = spawnSync('git', ['show', `main:${path}`], {
    cwd: remote.replace(/^file:\/\//, ''),
    env: { ...process.env, ...host.env },
  });
  if (result.status !== 0) throw new Error(`git show main:${path}: ${result.stderr.toString()}`);
  return result.stdout;
}

/**
 * Runs Sync Now from the palette, then waits for the notebook's dot to say Synced. First the open
 * note's last keys are stored on this device (its status bar no longer says Saving…): Sync Now
 * pushes what is stored, so on a slower machine (a hosted runner, A1235) a push right after
 * typing went without the last few characters, and the other Mac never saw them.
 */
export async function syncNow(page: Page): Promise<void> {
  const dot = page.getByTestId('section-sync').first();
  await expect(dot).not.toHaveAttribute('data-state', 'starting', { timeout: 30_000 });
  await expect(page.locator('[data-testid="save-status"][data-state="saving"]')).toHaveCount(0, {
    timeout: 30_000,
  });
  await page.keyboard.press('ControlOrMeta+KeyK');
  const palette = page.getByRole('dialog', { name: 'Command Palette' });
  await expect(palette).toBeVisible();
  await palette.getByRole('combobox', { name: 'Command Palette' }).fill(SYNC_NOW);
  await expect(palette.getByRole('option').first()).toContainText(SYNC_NOW);
  await page.keyboard.press('Enter');
  await expect(palette).toBeHidden();
  await expect(dot).toHaveAttribute('data-state', 'synced', { timeout: 30_000 });
}

/**
 * Pushes `from`'s changes, then pulls on `to` until `check` passes there: what a second device
 * shows once git has carried the change.
 */
export async function carried(
  from: Page,
  to: Page,
  check: () => Promise<void>,
  timeout = 90_000,
): Promise<void> {
  await syncNow(from);
  await expect(async () => {
    await syncNow(to);
    await check();
  }).toPass({ timeout, intervals: [1_000, 2_000, 4_000] });
}

/**
 * An agent on its own clone of the notebook (A993: `penmoss … --notebook`, the local MCP): it
 * makes its change through the local notes API as a writer of kind `agent`, and pushes it.
 */
export async function asAgent(
  host: GitHost,
  remote: string,
  label: string,
  change: (notebook: LocalNotebook) => void,
): Promise<void> {
  const dir = mkdtempSync(join(host.root, 'agent-'));
  try {
    const transport = new NodeGitTransport({
      gitDir: join(dir, 'repo.git'),
      remote,
      branch: 'main',
      root: '',
      author: { name: label, email: 'agent@example.invalid' },
      env: host.env,
      sign: false,
    });
    await transport.init();
    const engine = await GitNotebookEngine.open({
      transport,
      storage: new MemoryStorage(),
      secrets: new MemorySecrets(),
      writer: { kind: 'agent', label },
    });
    await engine.sync();
    change(new LocalNotebook(new NotebookOps(engine)));
    await engine.save();
    const report = await engine.sync();
    if (!report.commit) throw new Error(`${label} made no commit.`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
