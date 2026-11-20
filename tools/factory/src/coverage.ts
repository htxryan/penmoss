/**
 * Validation's coverage (A1650): every acceptance criterion the agreed plan names is captured,
 * on each app in scope that the criterion is about. PEN-137's validation captured the Mac's
 * criteria on the web build only and left the dashboard's out, so what Ryan then found there by
 * eye (columns missing, funnel steps in sentence case, Android's disclosure drawn as a row) was
 * never in front of the reviewer.
 */
import type { Platform } from './config.ts';
import { criterionLabel } from './fidelity.ts';

/** A criterion's id as plans write them: `AC12`, `ac3`, `AC-4b`. */
const ID = /\bAC[-\s]?(\d+[a-z]?)\b/gi;

const norm = (id: string) => `AC${id.toUpperCase().replace(/^0+(?=\d)/, '')}`;

/** The criterion ids the plan names, in order, each once. */
export function planCriteria(plan: string): string[] {
  const ids = new Set<string>();
  for (const m of plan.matchAll(ID)) ids.add(norm(m[1]!));
  return [...ids];
}

interface Capture {
  readonly criterion: string;
  readonly platform?: string;
  readonly screenshot?: string;
}

const MAC = /\b(?:Mac|macOS)\b/;
const ANDROID = /\bAndroid\b/;

/** The id a capture is for: its criterion's label when that is an AC id. */
function captureId(c: Capture): string | undefined {
  const label = criterionLabel(c.criterion);
  const m = /^AC[-\s]?(\d+[a-z]?)$/i.exec(label);
  return m ? norm(m[1]!) : undefined;
}

/** The platform a capture shows: as captures.json says, or by its screenshot's name. */
function capturePlatform(c: Capture): string {
  if (c.platform === 'mac' || c.platform === 'android') return c.platform;
  if (/(?:^|[-_.])android(?:[-_.]|$)/i.test(c.screenshot ?? '')) return 'android-standin';
  if (/(?:^|[-_.])mac(?:os)?(?:[-_.]|$)/i.test(c.screenshot ?? '')) return 'mac-standin';
  return 'web';
}

/**
 * What validation left out: each criterion of the plan with no capture, and each captured
 * criterion about the Mac or Android app (in scope) with no capture from that app's own
 * walkthrough. Empty when the plan names no ids, or `captures.json` can't be read (validation
 * fails on that elsewhere).
 */
export function missingCaptures(
  plan: string,
  capturesJson: string | null,
  platforms: readonly Platform[],
): string[] {
  const wanted = planCriteria(plan);
  if (wanted.length === 0 || capturesJson === null) return [];
  let captures: Capture[];
  try {
    const raw = (JSON.parse(capturesJson) as { captures?: unknown }).captures;
    if (!Array.isArray(raw)) return [];
    captures = raw.filter(
      (c): c is Capture =>
        typeof c === 'object' && c !== null && typeof (c as Capture).criterion === 'string',
    );
  } catch {
    return [];
  }
  const byId = new Map<string, Capture[]>();
  for (const c of captures) {
    const id = captureId(c);
    if (id) byId.set(id, [...(byId.get(id) ?? []), c]);
  }
  const missing: string[] = [];
  for (const id of wanted) {
    const got = byId.get(id);
    if (!got) {
      missing.push(`${id}: no capture at all`);
      continue;
    }
    const text = got.map((c) => c.criterion).join(' ');
    const shown = new Set(got.map(capturePlatform));
    if (platforms.includes('mac') && MAC.test(text) && !shown.has('mac'))
      missing.push(`${id}: it is about the Mac app, but no capture is from the Mac walkthrough`);
    if (platforms.includes('android') && ANDROID.test(text) && !shown.has('android'))
      missing.push(
        `${id}: it is about the Android app, but no capture is from the Android walkthrough`,
      );
  }
  return missing;
}
