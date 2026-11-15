/**
 * The launch log (A904): how macOS says each launch started, so a Mac run can check that
 * `wasOpenedAtLogin` is reliable. A debug file beside the preferences; nothing shows it.
 */
import { readFileSync, renameSync, writeFileSync } from 'node:fs';

/** Launches kept in the launch log (A904). */
const LAUNCHES_KEPT = 20;

/**
 * The launch log with this launch added (A904): how macOS says the app started, from
 * `app.getLoginItemSettings()` (its plain values only), so a Mac run can check that
 * `wasOpenedAtLogin` is reliable. A debug log in the app's logs folder; the last 20 launches.
 */
export function launchLog(previous: string, settings: object, at: Date): string {
  const values = Object.entries(settings)
    .filter(([, value]) => ['boolean', 'string', 'number'].includes(typeof value))
    .map(([key, value]) => `${key}=${String(value)}`);
  const line = `${at.toISOString()} launch: ${values.join(' ')} (A904)`;
  const lines = [...previous.split('\n').filter((one) => one !== ''), line];
  return `${lines.slice(-LAUNCHES_KEPT).join('\n')}\n`;
}

/** Adds this launch to the launch log file (A904); a log that cannot be written is skipped. */
export function writeLaunchLog(file: string, settings: object, at: Date): void {
  let previous = '';
  try {
    previous = readFileSync(file, 'utf8');
  } catch {
    // The first launch with the log.
  }
  const temp = `${file}.tmp`;
  writeFileSync(temp, launchLog(previous, settings, at), { mode: 0o600 });
  renameSync(temp, file);
}
