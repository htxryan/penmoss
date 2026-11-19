/**
 * The analytics screens' words (PEN-137, AC41): every title, label, button and state name in
 * Title Case on both platforms, "ID" never "Id", and the Mac's string the phone's twin with
 * "Mac" for "phone", except the planned differences. Then the copy Android reads,
 * `apps/android/contract/analytics-copy-v1.json`.
 *
 * After changing the copy, write the contract again:
 * `PENMOSS_WRITE_CONTRACTS=1 pnpm --filter @penmoss/core exec vitest run test/analytics-copy`,
 * then `pnpm exec prettier --write apps/android/contract/analytics-copy-v1.json`.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ANALYTICS_COPY,
  analyticsCopy,
  copyContract,
  isTitleKey,
  type CopyKey,
  type CopyPlatform,
} from '../src/analytics/copy';
import { STATE_LABELS, STATE_NAMES } from '../src/analytics/events';
import { titleCaseProblem } from '../src/title-case';

const KEYS = Object.keys(ANALYTICS_COPY) as CopyKey[];
const PLATFORMS: readonly CopyPlatform[] = ['mac', 'android'];

/** The plan's differences between the Mac and the phone, beyond "Mac" and "phone". */
const PLANNED_DIFFERENCES: readonly CopyKey[] = [
  'consent.recorded.4',
  'privacy.logs.button',
  'privacy.logs.hint',
  'limits.reset.hint',
];

describe('ANALYTICS_COPY', () => {
  it('writes every title, label, button and state name in Title Case', () => {
    const problems = KEYS.filter(isTitleKey).flatMap((key) =>
      PLATFORMS.flatMap((platform) => {
        const text = analyticsCopy(key, platform);
        if (text === '') return [];
        const problem = titleCaseProblem(text);
        return problem ? [`${key} (${platform}): ${problem}`] : [];
      }),
    );
    expect(problems).toEqual([]);
    expect(KEYS.filter(isTitleKey).length).toBeGreaterThan(40);
  });

  it('writes ID, never Id', () => {
    const wrong = KEYS.flatMap((key) =>
      PLATFORMS.filter((platform) => /\bId\b/.test(analyticsCopy(key, platform))).map(
        (platform) => `${key} (${platform})`,
      ),
    );
    expect(wrong).toEqual([]);
    expect(analyticsCopy('privacy.id.label')).toBe('Analytics ID');
    expect(analyticsCopy('privacy.resetId.button')).toBe('Reset My Analytics ID');
  });

  it('says the same on both platforms, with Mac for phone, but for the planned differences', () => {
    const differ = KEYS.filter(
      (key) =>
        analyticsCopy(key, 'mac').replace(/\bMac\b/g, 'phone') !== analyticsCopy(key, 'android'),
    );
    expect(differ).toEqual(PLANNED_DIFFERENCES);
  });

  it('keeps the Mac’s extra lines off the phone', () => {
    expect(analyticsCopy('consent.recorded.4', 'mac')).toBe(
      'CLI commands and agents’ MCP calls, by name',
    );
    expect(analyticsCopy('consent.recorded.4', 'android')).toBe('');
    expect(analyticsCopy('limits.reset.hint', 'android')).toBe('');
    expect(analyticsCopy('privacy.logs.button', 'mac')).toBe('Show Log File');
    expect(analyticsCopy('privacy.logs.button', 'android')).toBe('Share Log File');
  });

  it('names the device and fills in values, numbers in en-US', () => {
    expect(analyticsCopy('privacy.lead', 'mac')).toBe(
      'Penmoss records what you do in it, by name, on this Mac, and never anything you write or name.',
    );
    expect(analyticsCopy('consent.body', 'android')).toContain('on this phone');
    expect(analyticsCopy('consent.body', 'android')).not.toContain('Mac');
    expect(analyticsCopy('prune.events.title', 'mac', { count: 41_206 })).toBe(
      'Delete 41,206 Events?',
    );
    expect(analyticsCopy('prune.logs.title', 'mac', { size: '38 MB' })).toBe(
      'Delete 38 MB of Logs?',
    );
    expect(
      analyticsCopy('prune.body', 'mac', {
        reason: analyticsCopy('prune.reason.age', 'mac', { days: 3 }),
      }),
    ).toBe(
      'They’re older than 3 days. They’re deleted from this Mac now, and raising the limit later won’t bring them back.',
    );
    expect(analyticsCopy('forget.body', 'mac', { id: '5c0e8f6a…7a96' })).toBe(
      'Penmoss’s server deletes everything this Mac shared under ID 5c0e8f6a…7a96, and this Mac gets a new ID. The record on this Mac stays.',
    );
    expect(analyticsCopy('feedback.logs.summary', 'mac', { lines: 184, size: '9.6 KB' })).toBe(
      'Anonymised Logs · 184 lines · 9.6 KB',
    );
  });

  it('leaves a placeholder it was not given', () => {
    expect(analyticsCopy('prune.events.title')).toBe('Delete {count} Events?');
  });

  it('names the states as the viewers do', () => {
    for (const name of STATE_NAMES) {
      expect(analyticsCopy(`state.${name}` as CopyKey)).toBe(STATE_LABELS[name]);
    }
  });

  it('has the consent question’s words from the plan', () => {
    expect(analyticsCopy('consent.title')).toBe('Share How You Use Penmoss?');
    expect(analyticsCopy('consent.share.button')).toBe('Share Usage Data');
    expect(analyticsCopy('consent.dontShare.button')).toBe('Don’t Share');
    expect(analyticsCopy('forget.title')).toBe('Delete Your Shared Data?');
    expect(analyticsCopy('feedback.context.title')).toBe('Captured Context');
  });
});

describe('isTitleKey', () => {
  it('picks titles, labels, buttons and states, never sentences', () => {
    expect(isTitleKey('consent.title')).toBe(true);
    expect(isTitleKey('privacy.share.label')).toBe(true);
    expect(isTitleKey('limits.reset.button')).toBe(true);
    expect(isTitleKey('state.sent')).toBe(true);
    expect(isTitleKey('consent.body')).toBe(false);
    expect(isTitleKey('privacy.share.hint')).toBe(false);
    expect(isTitleKey('limits.range')).toBe(false);
  });
});

const CONTRACT = fileURLToPath(
  new URL('../../../apps/android/contract/analytics-copy-v1.json', import.meta.url),
);

interface CopyContractFile {
  readonly $comment: string;
  readonly version: 1;
  /** The keys whose strings are Title Case. */
  readonly titleKeys: readonly string[];
  readonly copy: Readonly<Record<string, { readonly mac: string; readonly android: string }>>;
}

const COMMENT =
  'Every string of the analytics screens (PEN-137): consent, Settings → Privacy, Advanced, the viewer, the confirmations and Send Feedback’s logs box, as the Mac says it and as the phone does, `{device}` filled in; other `{name}`s are filled in by the client. Keys in `titleKeys` are Title Case (A938). Written and checked from packages/core/src/analytics/copy.ts by packages/core/test/analytics-copy.test.ts; read by the Kotlin AnalyticsCopyContractTest.';

function contract(): CopyContractFile {
  return {
    $comment: COMMENT,
    version: 1,
    titleKeys: KEYS.filter(isTitleKey),
    copy: copyContract(),
  };
}

if (process.env['PENMOSS_WRITE_CONTRACTS'] === '1') {
  writeFileSync(CONTRACT, `${JSON.stringify(contract(), null, 2)}\n`);
}

describe('apps/android/contract/analytics-copy-v1.json', () => {
  it('holds every key with its Mac and phone text', () => {
    const stored = JSON.parse(readFileSync(CONTRACT, 'utf8')) as CopyContractFile;
    expect(stored).toEqual(contract());
    expect(Object.keys(stored.copy)).toEqual(KEYS);
    expect(stored.copy['privacy.advanced.intro']!.android).toBe(
      'How much Penmoss keeps on this phone. Lowering a limit asks first, then deletes what falls outside it.',
    );
  });
});
