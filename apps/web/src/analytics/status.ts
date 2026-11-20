/**
 * Usage analytics' state in the page (PEN-137): the Mac's main process answers it over the
 * bridge (`DesktopAnalytics`), and says when it changes (an answer, the CLI turning sharing off,
 * a limit set in a terminal), so Settings → Privacy, the viewer and the consent question show it
 * as it is. Every string comes from core's copy (`analyticsCopy`), with "Mac" for `{device}`.
 */
import { analyticsCopy, type CopyKey } from '@penmoss/core/analytics';
import { useEffect, useState } from 'react';
import { desktop, type DesktopAnalytics, type DesktopAnalyticsStatus } from '../desktop/bridge';

/** The Mac's analytics bridge, or null (the web build, a Mac app before PEN-137). */
export function analyticsBridge(): DesktopAnalytics | null {
  return desktop()?.analytics ?? null;
}

/** A string of the analytics screens, as the Mac says it. */
export function copy(key: CopyKey, vars?: Readonly<Record<string, string | number>>): string {
  return analyticsCopy(key, 'mac', vars);
}

/** The status, read once and again on each change; null until main answers (or with no bridge). */
export function useAnalyticsStatus(): DesktopAnalyticsStatus | null {
  const [status, setStatus] = useState<DesktopAnalyticsStatus | null>(null);
  useEffect(() => {
    const analytics = analyticsBridge();
    if (!analytics) return;
    let live = true;
    const stop = analytics.onChange((next) => {
      if (live) setStatus(next);
    });
    void analytics
      .status()
      .then((next) => {
        if (live) setStatus(next);
      })
      .catch(() => undefined);
    return () => {
      live = false;
      stop();
    };
  }, []);
  return status;
}

/** An analytics ID as the page shows it: its first eight and last four characters. */
export function shortId(install: string): string {
  return install.length > 12 ? `${install.slice(0, 8)}…${install.slice(-4)}` : install;
}

/** The Privacy Policy on penmoss.app (site/src/pages/privacy.astro). */
export const PRIVACY_POLICY_URL = 'https://penmoss.app/privacy/';
