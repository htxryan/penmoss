/**
 * Fidelity (F19, #268): the independent reviewer's verdict on each acceptance criterion, from
 * the validation captures beside the agreed mockups, and the table the PR shows them in.
 *
 * - `match`: the capture shows the criterion met, as designed.
 * - `mismatch`: it doesn't, and the agent should fix it (a fix round).
 * - `deviation`: it differs for a reason the agent can't or shouldn't fix; the PR says why.
 */
import type { Platform } from './config.ts';

export type Verdict = 'match' | 'mismatch' | 'deviation';

export interface FidelityRow {
  readonly criterion: string;
  readonly verdict: Verdict;
  readonly note: string;
  /** File names: in `.factory/validation/` as the reviewer writes them, in the proof folder after. */
  readonly mockup?: string;
  readonly screenshot?: string;
  /** Where the screenshot was taken: the web build, the Mac app in the VM, or the emulator. */
  readonly platform?: Platform;
}

const VERDICTS: readonly Verdict[] = ['match', 'mismatch', 'deviation'];
const PLATFORMS: readonly Platform[] = ['web', 'mac', 'android'];
/** A plain PNG name in the validation folder: no folders, no way out of it. */
const FILE = /^[\w.-]+\.png$/;

export function parseReview(
  text: string,
): { ok: true; rows: FidelityRow[] } | { ok: false; error: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: 'review.json is not JSON' };
  }
  const rows = (raw as { rows?: unknown } | null)?.rows;
  if (!Array.isArray(rows) || rows.length === 0)
    return { ok: false, error: 'review.json has no rows' };
  const out: FidelityRow[] = [];
  for (const [i, r] of rows.entries()) {
    const row = r as Partial<Record<keyof FidelityRow, unknown>>;
    if (typeof row.criterion !== 'string' || !row.criterion.trim())
      return { ok: false, error: `row ${i + 1} has no criterion` };
    if (!VERDICTS.includes(row.verdict as Verdict))
      return { ok: false, error: `row ${i + 1}'s verdict must be match, mismatch or deviation` };
    if (row.verdict !== 'match' && (typeof row.note !== 'string' || !row.note.trim()))
      return {
        ok: false,
        error: `row ${i + 1} (${String(row.verdict)}) needs a note saying what differs`,
      };
    const file = (v: unknown) => (typeof v === 'string' && FILE.test(v) ? v : undefined);
    const mockup = file(row.mockup);
    const screenshot = file(row.screenshot);
    const platform = PLATFORMS.find((p) => p === row.platform);
    out.push({
      criterion: row.criterion.trim(),
      verdict: row.verdict as Verdict,
      note: typeof row.note === 'string' ? row.note.trim() : '',
      ...(mockup ? { mockup } : {}),
      ...(screenshot ? { screenshot } : {}),
      ...(platform ? { platform } : {}),
    });
  }
  return { ok: true, rows: out };
}

/** What the implementing agent hears in a fix round. */
export function fidelityFeedback(rows: readonly FidelityRow[]): string {
  return [
    'An independent reviewer compared your change with the agreed plan and mockups and found these criteria not met:',
    '',
    ...rows.map((r) => `- **${r.criterion}**: ${r.note}`),
    '',
    "Fix them. If one can't be met, say why in `.factory/result.json` under `risks`; the reviewer then records it as a deviation.",
  ].join('\n');
}

/** On the last round, what's still a mismatch goes in the PR as a deviation. */
export function settle(rows: readonly FidelityRow[]): FidelityRow[] {
  return rows.map((r) =>
    r.verdict === 'mismatch'
      ? { ...r, verdict: 'deviation', note: `Not fixed in the rounds allowed: ${r.note}` }
      : r,
  );
}

const cell = (s: string) => s.replaceAll('|', '\\|').replaceAll('\n', ' ');
const MARK: Record<Verdict, string> = {
  match: '✅ Match',
  mismatch: '❌ Mismatch',
  deviation: '⚠️ Deviation',
};

/** The label over a screenshot the Mac or Android walkthrough took (PEN-94). */
const OWN: Partial<Record<Platform, string>> = {
  mac: 'Mac app, in the test VM',
  android: "Android app, on the factory's emulator",
};

const MAC = /(?:^|[-_.])mac(?:os)?(?:[-_.]|$)/i;
const ANDROID = /(?:^|[-_.])android(?:[-_.]|$)/i;

/**
 * The app a row's mockup or criterion is about, when it isn't the web app and its screenshot is
 * the web build anyway: the table then says the web build stands in for that app (A1256). A
 * screenshot the Mac or Android walkthrough took is that app's own (PEN-94).
 */
export function standIn(row: FidelityRow): 'the Mac app' | 'the Android app' | undefined {
  if (row.platform === 'mac' || row.platform === 'android') return undefined;
  const files = [row.mockup, row.screenshot].filter((f): f is string => Boolean(f));
  if (files.some((f) => MAC.test(f)) || /\b(?:Mac|macOS)\b/.test(row.criterion))
    return 'the Mac app';
  if (files.some((f) => ANDROID.test(f)) || /\bAndroid\b/.test(row.criterion))
    return 'the Android app';
  return undefined;
}

/** The PR's fidelity table: mockup and screenshot side by side, files beside the body. */
export function renderFidelity(rows: readonly FidelityRow[]): string {
  if (rows.length === 0) return '';
  const img = (alt: string, f?: string) => (f ? `![${alt}](./${f})` : '—');
  const shot = (r: FidelityRow) => {
    const app = standIn(r);
    const own = r.platform ? OWN[r.platform] : undefined;
    if (r.screenshot && own) return `${own}<br>${img(own, r.screenshot)}`;
    if (!r.screenshot || !app) return img('screenshot', r.screenshot);
    return `Web build, standing in for ${app}<br>${img(`web build, standing in for ${app}`, r.screenshot)}`;
  };
  const lines = [
    '## Fidelity',
    '',
    'An independent reviewer walked each acceptance criterion and compared it with the agreed mockup.',
    ...(rows.some((r) => standIn(r))
      ? [
          '',
          "A row for the Mac or Android app that its own walkthrough didn't capture shows the web build in headless Chromium standing in for it (the Mac app bundles it); that app's proof recording, above, shows the real thing.",
        ]
      : []),
    '',
    '| Criterion | Verdict | Mockup | Screenshot |',
    '| --- | --- | --- | --- |',
    ...rows.map(
      (r) =>
        `| ${cell(r.criterion)}${r.note ? `<br>${cell(r.note)}` : ''} | ${MARK[r.verdict]} | ${img('mockup', r.mockup)} | ${shot(r)} |`,
    ),
  ];
  const deviations = rows.filter((r) => r.verdict === 'deviation');
  if (deviations.length > 0)
    lines.push(
      '',
      '### Deviations',
      '',
      ...deviations.map((r) => `- **${cell(r.criterion)}**: ${r.note}`),
    );
  return lines.join('\n');
}
