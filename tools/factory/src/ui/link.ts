/** The running Factory UI's link, for notifications that open a card (F20). */
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expandHome, type FactoryConfig } from '../config.ts';

/** Where the UI writes its link (token included), mode 600, for the notifications to use. */
export const uiLinkPath = (config: FactoryConfig) => join(expandHome(config.stateDir), 'ui.url');

/** The UI's link to one card, if the UI is running; `undefined` otherwise. */
export function cardLink(config: FactoryConfig, issue: number): string | undefined {
  try {
    const base = readFileSync(uiLinkPath(config), 'utf8').trim();
    return base ? `${base}#issue-${issue}` : undefined;
  } catch {
    return undefined;
  }
}

/** Where the UI keeps its token, mode 600, so its link stays the same across restarts (A1264). */
export const uiTokenPath = (stateDir: string) => join(stateDir, 'ui-token');

const TOKEN = /^[0-9a-f]{48}$/;

/**
 * The UI's token: the one kept in the state folder, or a new one kept there. It stops anything
 * else on this Mac that can reach the UI's port (a factory agent among them) from pressing Ryan's
 * buttons; Tailscale only decides which devices reach the Mac. Delete the file and restart the UI
 * for a new link.
 */
export function uiToken(stateDir: string): string {
  const path = uiTokenPath(stateDir);
  try {
    const kept = readFileSync(path, 'utf8').trim();
    if (TOKEN.test(kept)) return kept;
  } catch {
    // None yet.
  }
  const token = randomBytes(24).toString('hex');
  writeFileSync(path, `${token}\n`, { mode: 0o600 });
  return token;
}
