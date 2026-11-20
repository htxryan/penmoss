/**
 * Every string the analytics screens show (PEN-137, Copy and Title Case): the consent question,
 * Settings → Privacy, Advanced, the viewer, the confirmations and Send Feedback's logs box. Kept
 * once, here, with `{device}` for "Mac" or "phone", and exported to Android as
 * `apps/android/contract/analytics-copy-v1.json`, so the two clients say the same words. The
 * planned differences are keyed by platform: the Mac's extra consent line about the CLI and
 * MCP, and the Logs row's button and hint.
 *
 * Keys ending `.title`, `.label` or `.button` (and the `state.*` names) are Title Case
 * (`copy.test.ts` checks them against A938's rule); the rest are sentences.
 */
import { STATE_LABELS } from './events';

export type CopyPlatform = 'mac' | 'android';
export type CopyText = string | { readonly mac: string; readonly android: string };

export const ANALYTICS_COPY = {
  'consent.title': 'Share How You Use Penmoss?',
  'consent.lastStep.label': 'Last Step',
  'consent.body':
    'Penmoss keeps a record of what you do in it, by name, on this {device}, and Settings → Privacy shows it. Share Usage Data sends it, this setup included, to Penmoss’s developer. Don’t Share keeps it on this {device}.',
  'consent.recorded.title': 'What Is Recorded',
  'consent.recorded.1': 'The commands, shortcuts, buttons and menus you use, by name',
  'consent.recorded.2': 'The screens and dialogs you open, and the settings you change',
  'consent.recorded.3': 'The app’s version, the system’s version and the window’s size',
  'consent.recorded.4': {
    mac: 'CLI commands and agents’ MCP calls, by name',
    android: '',
  },
  'consent.never.title': 'Never Recorded',
  'consent.never.1': 'What you write: notes, titles, tags, links and searches',
  'consent.never.2': 'The names of notebooks, folders, files and repositories',
  'consent.never.3': 'Your GitHub account, email address or tokens',
  'consent.share.button': 'Share Usage Data',
  'consent.dontShare.button': 'Don’t Share',
  'consent.policy.label': 'Privacy Policy',
  'consent.later':
    'You can change this at any time in Settings → Privacy, and see what is recorded there.',

  'privacy.title': 'Privacy',
  'privacy.lead':
    'Penmoss records what you do in it, by name, on this {device}, and never anything you write or name.',
  'privacy.share.label': 'Share Usage Data',
  'privacy.share.hint':
    'Sends the record to Penmoss’s developer from now on. Off, it stays on this {device}.',
  'privacy.viewData.label': 'View Analytics Data',
  'privacy.id.label': 'Analytics ID',
  'privacy.id.hint': 'A random ID you can reset. It says nothing about you.',
  'privacy.resetId.button': 'Reset My Analytics ID',
  'privacy.resetId.done': 'A new ID is in use. Events not yet sent stay on this {device}.',
  'privacy.forget.button': 'Delete My Shared Data',
  'privacy.logs.label': 'Logs',
  'privacy.logs.button': { mac: 'Show Log File', android: 'Share Log File' },
  'privacy.logs.hint': {
    mac: 'The last {days} days, on this Mac. They leave only when you attach them to a bug report.',
    android:
      'The last {days} days, on this phone. They leave only when you attach them to a bug report or share them.',
  },
  'privacy.advanced.label': 'Advanced',
  'privacy.advanced.hint': 'How long and how much Penmoss keeps on this {device}',
  'privacy.advanced.intro':
    'How much Penmoss keeps on this {device}. Lowering a limit asks first, then deletes what falls outside it.',
  'privacy.policy.label': 'Privacy Policy',

  'limits.usage.title': 'Usage Record',
  'limits.logs.title': 'Logs',
  'limits.report.title': 'Bug Reports',
  'limits.events.days.label': 'Keep Events For',
  'limits.events.max.label': 'Keep at Most',
  'limits.logs.fileKb.label': 'Log File Size',
  'limits.logs.files.label': 'Log Files Kept',
  'limits.logs.days.label': 'Keep Log Lines For',
  'limits.report.hours.label': 'Attach Logs from the Last',
  'limits.report.lines.label': 'At Most',
  'limits.report.kb.label': 'At Most',
  'limits.default': 'Default: {value}',
  'limits.range': 'Between {min} and {max}',
  'limits.usage.space': 'About {size} of events at most on this {device}',
  'limits.logs.space': 'Up to {size} of logs on this {device} (at most 400 MB)',
  'limits.report.space':
    'A bug report attaches the last {hours} hours, at most {lines} lines and {kb} KB.',
  'limits.reset.button': 'Reset to Defaults',
  'limits.reset.hint': { mac: 'Or run penmoss analytics limits in a terminal.', android: '' },

  'confirm.cancel.button': 'Cancel',
  'confirm.delete.button': 'Delete',
  'forget.title': 'Delete Your Shared Data?',
  'forget.body':
    'Penmoss’s server deletes everything this {device} shared under ID {id}, and this {device} gets a new ID. The record on this {device} stays.',
  'forget.offline': 'You’re offline, so nothing was deleted. Try again when you’re online.',
  'forget.failed': 'Penmoss’s server didn’t answer, so nothing was deleted. Try again later.',
  'forget.done': 'Your shared data was deleted, and this {device} has a new ID.',
  'prune.events.title': 'Delete {count} Events?',
  'prune.logs.title': 'Delete {size} of Logs?',
  'prune.body':
    'They’re {reason}. They’re deleted from this {device} now, and raising the limit later won’t bring them back.',
  'prune.reason.age': 'older than {days} days',
  'prune.reason.cap': 'beyond the newest {max}',
  'prune.reason.size': 'beyond the new size',

  'viewer.title': 'Analytics Data',
  'viewer.summary': 'On this {device}, kept {days} days. ID {id}. {sharing}',
  'viewer.sharing.on': 'Sharing since {date}.',
  'viewer.sharing.off': 'Not shared.',
  'viewer.sharing.unanswered': 'Waiting for your answer.',
  'viewer.filter.all.label': 'All',
  'viewer.filter.app.label': 'App',
  'viewer.filter.cli.label': 'CLI',
  'viewer.filter.mcp.label': 'MCP',
  'viewer.copyJson.button': 'Copy as JSON',
  'viewer.earlier.button': 'Earlier',
  'viewer.later.button': 'Later',
  'viewer.showing': 'Showing {from}–{to} of {total}',
  'viewer.empty.title': 'Nothing Recorded Yet',
  'viewer.col.time.label': 'Time',
  'viewer.col.client.label': 'Client',
  'viewer.col.kind.label': 'Kind',
  'viewer.col.name.label': 'Name',
  'viewer.col.props.label': 'Props',
  'viewer.col.state.label': 'State',

  'feedback.logs.label': 'Attach Anonymised Logs',
  'feedback.logs.summary': 'Anonymised Logs · {lines} lines · {size}',
  'feedback.logs.hint':
    'The app’s logs from the last {hours} hours, at most {maxLines} lines and {kb} KB, with names, paths, IDs and secrets replaced. This is exactly what is attached.',
  'feedback.logs.empty': 'There are no logs from the last {hours} hours.',
  'feedback.logs.block.title': 'Anonymised Logs',
  'feedback.context.title': 'Captured Context',

  'state.pending': STATE_LABELS.pending,
  'state.local': STATE_LABELS.local,
  'state.waiting': STATE_LABELS.waiting,
  'state.sent': STATE_LABELS.sent,
  'state.refused': STATE_LABELS.refused,
} as const satisfies Readonly<Record<string, CopyText>>;

export type CopyKey = keyof typeof ANALYTICS_COPY;

const DEVICE: Readonly<Record<CopyPlatform, string>> = { mac: 'Mac', android: 'phone' };

/** A string for `platform`, with `{device}` and `vars` filled in. */
export function analyticsCopy(
  key: CopyKey,
  platform: CopyPlatform = 'mac',
  vars: Readonly<Record<string, string | number>> = {},
): string {
  const entry: CopyText = ANALYTICS_COPY[key];
  const text = typeof entry === 'string' ? entry : entry[platform];
  return text.replace(/\{(\w+)\}/g, (match, name: string) => {
    if (name === 'device') return DEVICE[platform];
    const value = vars[name];
    if (value === undefined) return match;
    return typeof value === 'number' ? value.toLocaleString('en-US') : value;
  });
}

/** Whether a key names a title, label, button or state, and so is Title Case. */
export function isTitleKey(key: string): boolean {
  return /\.(title|label|button)$/.test(key) || key.startsWith('state.');
}

/** The contract Android reads: every key with its Mac and Android text, `{device}` filled. */
export function copyContract(): Readonly<Record<string, { mac: string; android: string }>> {
  return Object.fromEntries(
    (Object.keys(ANALYTICS_COPY) as CopyKey[]).map((key) => [
      key,
      { mac: analyticsCopy(key, 'mac'), android: analyticsCopy(key, 'android') },
    ]),
  );
}
