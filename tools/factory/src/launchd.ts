/** The LaunchAgent (F10): rendered from launchd/app.penmoss.factory.plist.tmpl. */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const LABEL = 'app.penmoss.factory';
/** The Factory UI's LaunchAgent (F20). */
export const UI_LABEL = 'app.penmoss.factory-ui';
/** The updater's LaunchAgent: moves the factory to main when main changes it (A1293). */
export const UPDATER_LABEL = 'app.penmoss.factory-updater';

const xml = (s: string) =>
  s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

export function renderPlist(values: {
  /** The LaunchAgent's label, and the CLI command it runs. */
  label?: string;
  command?: string;
  node: string;
  cli: string;
  repo: string;
  path: string;
  log: string;
}): string {
  const template = readFileSync(
    new URL('../launchd/app.penmoss.factory.plist.tmpl', import.meta.url),
    'utf8',
  );
  return template
    .replaceAll('{{LABEL}}', xml(values.label ?? LABEL))
    .replaceAll('{{COMMAND}}', xml(values.command ?? 'daemon'))
    .replaceAll('{{NODE}}', xml(values.node))
    .replaceAll('{{CLI}}', xml(values.cli))
    .replaceAll('{{REPO}}', xml(values.repo))
    .replaceAll('{{PATH}}', xml(values.path))
    .replaceAll('{{LOG}}', xml(values.log));
}

export function plistPath(home: string, label: string = LABEL): string {
  return join(home, 'Library/LaunchAgents', `${label}.plist`);
}
