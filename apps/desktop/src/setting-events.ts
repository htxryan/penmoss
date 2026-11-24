/**
 * The settings the Mac's main process writes itself (PEN-175): the page never writes them through
 * `setSetting`, so the page's `recordSetting` never sees them. Main records each, by its catalogue
 * name, only once the write has succeeded; a write that fails records nothing. The value is what
 * core's `settingValueProps` lets an event say: a switch's on or off, a whole number, a listed
 * word, or `changed: true` (the capture hotkey's keys).
 */
import { settingValueProps } from '@penmoss/core/analytics';
import { analytics } from './services';

/** The settings main records, each written where its comment says. */
type MacSettingName =
  /** A git notebook's Push After, Pull Every and Sign Commits (`ipc/git.ts`, gitUpdate). */
  | 'git.pushAfter'
  | 'git.pullEvery'
  | 'git.signCommits'
  /** Settings → Updates (`updater.ts`, wired in `services.ts`). */
  | 'updates.auto'
  | 'updates.channel'
  /** Settings → Semantic Search (`ipc/meaning.ts`). */
  | 'meaning.enabled'
  /** Settings → Appearance → Compact Title Bar (`mac-window-control.ts`). */
  | 'titleBar.compact'
  /** Settings → Quick Capture → Show in the Menu Bar (`tray-control.ts`). */
  | 'menuBar.icon'
  /** Settings → Quick Capture's hotkey (`capture-hotkey.ts`): only that it changed. */
  | 'capture.hotkey';

/** Records `setting <name>` with what core lets `value` say. Call it after the write succeeds. */
export function recordSetting(name: MacSettingName, value: unknown): void {
  analytics.record('setting', name, settingValueProps(name, value));
}
