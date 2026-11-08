/** The running Factory UI's link, for notifications that open a card (F20). */
import { readFileSync } from 'node:fs';
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
