/**
 * The proof manifest: which files show which test, on which platform, recorded by whom. Built
 * from the harness's own runs (Playwright's JSON report), never from files the agent hands over;
 * the agent's own stills are labelled as such and never count toward R9.
 */
import type { Platform } from '../config.ts';

export interface ProofItem {
  readonly platform: Platform;
  readonly title: string;
  readonly status: 'passed' | 'failed' | 'other';
  /** `before` is the failing test on the base commit, for a bug. */
  readonly phase: 'before' | 'after';
  readonly source: 'harness' | 'agent';
  /** Source recordings, before conversion. */
  readonly video?: string;
  readonly screenshot?: string;
}

interface PwAttachment {
  readonly name: string;
  readonly path?: string;
  readonly contentType?: string;
}
interface PwResult {
  readonly status?: string;
  readonly attachments?: readonly PwAttachment[];
}
interface PwSpec {
  readonly title: string;
  readonly tests?: readonly { readonly results?: readonly PwResult[] }[];
}
interface PwSuite {
  readonly title: string;
  readonly specs?: readonly PwSpec[];
  readonly suites?: readonly PwSuite[];
}

/** Every test in a Playwright JSON report with its last run's video and final screenshot. */
export function fromPlaywrightReport(
  report: { readonly suites?: readonly PwSuite[] },
  platform: Platform,
  phase: ProofItem['phase'],
): ProofItem[] {
  const items: ProofItem[] = [];
  const walk = (suite: PwSuite, path: readonly string[]) => {
    const here = suite.title && !suite.title.endsWith('.ts') ? [...path, suite.title] : path;
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests ?? []) {
        const last = test.results?.at(-1);
        if (!last) continue;
        const attachment = (name: string, type: string) =>
          last.attachments
            ?.filter((a) => a.name === name && a.path && (a.contentType ?? '').startsWith(type))
            .at(-1)?.path;
        const video = attachment('video', 'video/');
        const screenshot = attachment('screenshot', 'image/');
        items.push({
          platform,
          title: [...here, spec.title].join(' › '),
          status:
            last.status === 'passed'
              ? 'passed'
              : last.status === 'failed' || last.status === 'timedOut'
                ? 'failed'
                : 'other',
          phase,
          source: 'harness',
          ...(video ? { video } : {}),
          ...(screenshot ? { screenshot } : {}),
        });
      }
    }
    for (const child of suite.suites ?? []) walk(child, here);
  };
  for (const suite of report.suites ?? []) walk(suite, []);
  return items;
}

/** R9: every in-scope platform has at least one passing harness recording. */
export function missingProof(
  items: readonly ProofItem[],
  platforms: readonly Platform[],
): Platform[] {
  return platforms.filter(
    (p) =>
      !items.some(
        (i) =>
          i.platform === p &&
          i.source === 'harness' &&
          i.phase === 'after' &&
          i.status === 'passed' &&
          (i.video || i.screenshot),
      ),
  );
}
