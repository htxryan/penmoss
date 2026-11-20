// @vitest-environment happy-dom
import { countsLine, DEFAULT_LIMITS, type LimitKey } from '@penmoss/core/analytics';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  DesktopAnalytics,
  DesktopAnalyticsStatus,
  LimitsPreview,
  PenmossDesktop,
} from '../../src/desktop/bridge';
import { PrivacySettings } from '../../src/analytics/PrivacySettings';
import { shortId } from '../../src/analytics/status';
import { SETTINGS_INDEX } from '../../src/pages/settings-index';

// PEN-137: Settings → Privacy. Its rows in order, each one Search Settings can open (and every
// Privacy entry in the index a row on the page); a limit out of range refused, a lowering that
// deletes asked first, and Delete My Shared Data asked first.

const STATUS: DesktopAnalyticsStatus = {
  consent: 'yes',
  ask: false,
  install: '5c0e8f6a0b1c2d3e4f50617283947a96',
  sharingSince: Date.UTC(2026, 10, 1),
  counts: { pending: 0, local: 212, waiting: 2, sent: 41, refused: 0 },
  limits: DEFAULT_LIMITS,
  logBytes: 6 * 1024 * 1024,
  lastBatch: null,
  optedOut: false,
};

describe('Settings → Privacy (PEN-137)', () => {
  let root: Root | null = null;
  let host: HTMLDivElement;
  let calls: string[];
  let preview: LimitsPreview;
  let status: DesktopAnalyticsStatus;

  const analytics: DesktopAnalytics = {
    record: () => undefined,
    log: () => undefined,
    status: () => Promise.resolve(status),
    onChange: () => () => undefined,
    answer: () => Promise.resolve(status),
    setSharing: (on) => {
      calls.push(`sharing:${on}`);
      return Promise.resolve(status);
    },
    resetId: () => {
      calls.push('resetId');
      return Promise.resolve(status);
    },
    forget: () => {
      calls.push('forget');
      return Promise.resolve({ outcome: 'ok' });
    },
    page: () => Promise.resolve({ events: [], total: 0, newer: 0 }),
    preview: (changes) => {
      calls.push(`preview:${JSON.stringify(changes)}`);
      return Promise.resolve(preview);
    },
    setLimits: (changes) => {
      calls.push(`setLimits:${JSON.stringify(changes)}`);
      return Promise.resolve(status);
    },
    showLogFile: () => {
      calls.push('showLogFile');
      return Promise.resolve(true);
    },
    reportLogs: () => Promise.resolve({ lines: [], bytes: 0 }),
  };

  const shown = async () => {
    await act(async () => {
      root!.render(<PrivacySettings />);
      await Promise.resolve();
      await Promise.resolve();
    });
  };
  const byTestId = (id: string) => host.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  const field = (key: LimitKey) => byTestId(`privacy-limit-${key}`) as HTMLInputElement;
  /** Types `value` into a field the way React hears it, then presses Enter. */
  const commit = async (key: LimitKey, value: string) => {
    const input = field(key);
    act(() => {
      Reflect.set(HTMLInputElement.prototype, 'value', value, input);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await Promise.resolve();
      await Promise.resolve();
    });
  };

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    calls = [];
    preview = { events: 0, logBytes: 0 };
    status = STATUS;
    (window as { penmossDesktop?: Partial<PenmossDesktop> }).penmossDesktop = {
      window: 'main',
      analytics,
    };
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    host.remove();
    delete (window as { penmossDesktop?: unknown }).penmossDesktop;
  });

  it('has its rows in order, then Advanced, closed', async () => {
    await shown();
    expect(host.querySelector('h1')?.textContent).toBe('Privacy');
    const top = [...host.querySelectorAll('[data-setting]')]
      .filter((row) => !row.parentElement?.closest('[data-setting]'))
      .map((row) => row.getAttribute('data-setting'));
    expect(top).toEqual([
      'share-usage-data',
      'view-analytics-data',
      'analytics-id',
      'logs',
      'advanced',
    ]);
    expect(byTestId('privacy-counts')?.textContent).toBe(countsLine(STATUS.counts));
    expect(byTestId('privacy-counts')?.textContent).toBe(
      'Waiting to Send 2 · Sent 41 · Not Shared 212',
    );
    expect(byTestId('privacy-id')?.textContent).toBe(shortId(STATUS.install));
    expect((byTestId('privacy-advanced') as HTMLDetailsElement).open).toBe(false);
    expect(byTestId('privacy-policy')?.getAttribute('href')).toBe('https://penmoss.app/privacy/');
  });

  it('has an index entry for every row, and a row for every Privacy entry', async () => {
    await shown();
    const rows = new Set(
      [...host.querySelectorAll('[data-setting]')].map((row) => row.getAttribute('data-setting')),
    );
    const entries = SETTINGS_INDEX.filter((entry) => entry.section === 'privacy');
    expect(new Set(entries.map((entry) => entry.id))).toEqual(rows);
    // The limits are under Advanced, the rest on the page itself.
    for (const entry of entries) {
      const inAdvanced = Boolean(
        host.querySelector(`[data-setting="advanced"] [data-setting="${entry.id}"]`),
      );
      expect(entry.group, entry.id).toBe(inAdvanced ? 'Advanced' : undefined);
    }
  });

  it('refuses a limit out of its range, and saves nothing', async () => {
    await shown();
    await commit('events.days', '400');
    expect(byTestId('privacy-limit-refused')?.textContent).toBe('Between 1 and 360');
    expect(field('events.days').getAttribute('aria-invalid')).toBe('true');
    expect(calls).toEqual([]);
  });

  it('asks before a lowering that deletes, and puts the old value back on Cancel', async () => {
    preview = { events: 41_206, logBytes: 0 };
    await shown();
    await commit('events.days', '3');
    expect(calls).toEqual(['preview:{"events.days":3}']);
    const confirm = byTestId('privacy-limit-confirm')!;
    expect(confirm.getAttribute('role')).toBe('alertdialog');
    expect(confirm.getAttribute('aria-label')).toBe('Delete 41,206 Events?');
    expect(confirm.textContent).toContain(
      'They’re older than 3 days. They’re deleted from this Mac now, and raising the limit later won’t bring them back.',
    );
    expect(document.activeElement).toBe(byTestId('privacy-limit-confirm-cancel'));
    act(() => byTestId('privacy-limit-confirm-cancel')!.click());
    expect(byTestId('privacy-limit-confirm')).toBeNull();
    expect(field('events.days').value).toBe('7');
    expect(calls).toEqual(['preview:{"events.days":3}']);

    await commit('events.days', '3');
    act(() => byTestId('privacy-limit-confirm-delete')!.click());
    expect(calls.at(-1)).toBe('setLimits:{"events.days":3}');
  });

  it('saves a lowering that deletes nothing, and a raise, without asking', async () => {
    await shown();
    await commit('report.lines', '100');
    expect(byTestId('privacy-limit-confirm')).toBeNull();
    expect(calls).toEqual(['preview:{"report.lines":100}', 'setLimits:{"report.lines":100}']);
    await commit('events.max', '10,000');
    expect(calls.at(-1)).toBe('setLimits:{"events.max":10000}');
  });

  it('asks before Delete My Shared Data, naming the ID; Escape and Cancel change nothing', async () => {
    await shown();
    act(() => byTestId('privacy-forget')!.click());
    const confirm = byTestId('privacy-forget-confirm')!;
    expect(confirm.getAttribute('aria-label')).toBe('Delete Your Shared Data?');
    expect(confirm.textContent).toContain(
      `everything this Mac shared under ID ${shortId(STATUS.install)}`,
    );
    act(() => {
      confirm.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(byTestId('privacy-forget-confirm')).toBeNull();
    act(() => byTestId('privacy-forget')!.click());
    act(() => byTestId('privacy-forget-confirm-cancel')!.click());
    expect(calls).toEqual([]);
    act(() => byTestId('privacy-forget')!.click());
    await act(async () => {
      byTestId('privacy-forget-confirm-delete')!.click();
      await Promise.resolve();
    });
    expect(calls).toEqual(['forget']);
    expect(byTestId('privacy-id-note')?.textContent).toBe(
      'Your shared data was deleted, and this Mac has a new ID.',
    );
  });
});
