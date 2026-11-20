// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { eventProblem, type Props } from '@penmoss/core/analytics';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushRecorded } from '../../src/analytics/record';
import {
  LAYOUT_SETTLE_MS,
  LayoutTracker,
  layoutProps,
  resetLayoutTracking,
  useLayoutPart,
  type LayoutParts,
} from '../../src/analytics/layout';

// PEN-174: `app layout` from the page.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const owner = {};

function tracker() {
  const sent: Props[] = [];
  return { sent, tracker: new LayoutTracker((props) => sent.push(props)) };
}

/** The app's own parts, as App.tsx gives them. */
function appParts(target: LayoutTracker, window: 'main' | 'note' = 'main') {
  target.set(owner, 'window', window);
  target.set(owner, 'fullWidth', false);
  target.set(owner, 'themeMode', 'system');
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('layoutProps', () => {
  const parts: LayoutParts = {
    window: 'main',
    sidebar: 'shown',
    sidebarWidth: 283.4,
    panel: 'open',
    fullWidth: true,
    themeMode: 'dark',
    tabs: 3,
  };

  it('rounds the sidebar’s width to 10 and sends the tabs as a bucket', () => {
    expect(layoutProps(parts)).toEqual({
      window: 'main',
      sidebar: 'shown',
      sidebarWidth: 280,
      panel: 'open',
      fullWidth: true,
      themeMode: 'dark',
      tabs: '2–4',
    });
  });

  it('sends the width only while the sidebar is shown, and no tabs where there are none', () => {
    expect(layoutProps({ ...parts, sidebar: 'rail' })).not.toHaveProperty('sidebarWidth');
    expect(layoutProps({ ...parts, sidebar: 'hidden' })).not.toHaveProperty('sidebarWidth');
    expect(layoutProps({ ...parts, tabs: null })).not.toHaveProperty('tabs');
  });

  it('gives props core’s check accepts', () => {
    for (const props of [
      layoutProps(parts),
      layoutProps({ ...parts, window: 'note', sidebar: 'hidden', panel: 'none', tabs: null }),
    ]) {
      const event = {
        session: '0123456789abcdef',
        seq: 0,
        at: 1,
        client: 'mac',
        actor: 'person',
        version: '1.4.0',
        channel: 'stable',
        os: 'macos',
        osVersion: '26.1',
        kind: 'app',
        name: 'layout',
        props,
      };
      expect(eventProblem(event)).toBeNull();
    }
  });
});

describe('the layout tracker (PEN-174)', () => {
  it('records once the app’s parts are known and the layout has held 500 ms', () => {
    const { sent, tracker: target } = tracker();
    target.set(owner, 'sidebar', 'shown');
    vi.advanceTimersByTime(LAYOUT_SETTLE_MS);
    // No window, Full Width or theme yet: nothing.
    expect(sent).toEqual([]);
    appParts(target);
    vi.advanceTimersByTime(LAYOUT_SETTLE_MS - 1);
    expect(sent).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(sent).toEqual([
      { window: 'main', sidebar: 'shown', panel: 'none', fullWidth: false, themeMode: 'system' },
    ]);
  });

  it('records one event after a run of changes, such as a sidebar drag', () => {
    const { sent, tracker: target } = tracker();
    appParts(target);
    target.set(owner, 'sidebar', 'shown');
    target.set(owner, 'sidebarWidth', 260);
    vi.advanceTimersByTime(LAYOUT_SETTLE_MS);
    expect(sent).toHaveLength(1);
    for (const width of [270, 290, 310, 333, 351]) {
      target.set(owner, 'sidebarWidth', width);
      vi.advanceTimersByTime(50);
    }
    expect(sent).toHaveLength(1);
    vi.advanceTimersByTime(LAYOUT_SETTLE_MS);
    expect(sent).toHaveLength(2);
    expect(sent[1]).toMatchObject({ sidebar: 'shown', sidebarWidth: 350 });
  });

  it('records nothing when the layout settles back to the last one recorded', () => {
    const { sent, tracker: target } = tracker();
    appParts(target);
    target.set(owner, 'tabs', 5);
    vi.advanceTimersByTime(LAYOUT_SETTLE_MS);
    expect(sent).toHaveLength(1);
    // Six tabs is still 5–9; and a theme changed and changed back is no change.
    target.set(owner, 'tabs', 6);
    target.set(owner, 'themeMode', 'dark');
    target.set(owner, 'themeMode', 'system');
    vi.advanceTimersByTime(LAYOUT_SETTLE_MS);
    expect(sent).toHaveLength(1);
    // Close Others: one event for the five tabs gone.
    for (const count of [5, 4, 3, 2, 1]) target.set(owner, 'tabs', count);
    vi.advanceTimersByTime(LAYOUT_SETTLE_MS);
    expect(sent).toHaveLength(2);
    expect(sent[1]).toMatchObject({ tabs: '1' });
  });

  it('records each input’s change: sidebar, panel, Full Width, theme mode and tabs', () => {
    const { sent, tracker: target } = tracker();
    appParts(target);
    vi.advanceTimersByTime(LAYOUT_SETTLE_MS);
    const panel = {};
    const steps: Array<[() => void, Props]> = [
      [() => target.set(owner, 'sidebar', 'rail'), { sidebar: 'rail' }],
      [() => target.set(panel, 'panel', 'open'), { panel: 'open' }],
      [() => target.set(panel, 'panel', 'closed'), { panel: 'closed' }],
      [() => target.set(owner, 'fullWidth', true), { fullWidth: true }],
      [() => target.set(owner, 'themeMode', 'dark'), { themeMode: 'dark' }],
      [() => target.set(owner, 'tabs', 2), { tabs: '2–4' }],
      // The note view goes (Settings, Home): no note, no panel.
      [() => target.set(panel, 'panel', undefined), { panel: 'none' }],
    ];
    for (const [step, expected] of steps) {
      const before = sent.length;
      step();
      vi.advanceTimersByTime(LAYOUT_SETTLE_MS);
      expect(sent).toHaveLength(before + 1);
      expect(sent.at(-1)).toMatchObject(expected);
    }
  });

  it('keeps a part another owner gives when an older owner lets go of it', () => {
    const { sent, tracker: target } = tracker();
    appParts(target);
    const before = {};
    const after = {};
    target.set(before, 'panel', 'open');
    target.set(after, 'panel', 'closed');
    target.set(before, 'panel', undefined);
    vi.advanceTimersByTime(LAYOUT_SETTLE_MS);
    expect(sent.at(-1)).toMatchObject({ panel: 'closed' });
  });
});

describe('useLayoutPart', () => {
  let root: Root | null = null;
  let host: HTMLElement;

  beforeEach(() => {
    window.__penmossAnalytics = [];
    host = document.createElement('div');
    document.body.append(host);
    resetLayoutTracking();
  });
  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    host.remove();
  });

  function Parts({ panel }: { panel?: 'open' | 'closed' | undefined }) {
    useLayoutPart('window', 'note');
    useLayoutPart('fullWidth', true);
    useLayoutPart('themeMode', 'light');
    return panel === undefined ? null : <Panel mode={panel} />;
  }
  function Panel({ mode }: { mode: 'open' | 'closed' }) {
    useLayoutPart('panel', mode);
    return null;
  }

  const layouts = () => {
    flushRecorded();
    return (window.__penmossAnalytics ?? []).filter(
      (event) => event.kind === 'app' && event.name === 'layout',
    );
  };

  it('records through the page’s recorder, and the part goes with its component', () => {
    root = createRoot(host);
    act(() => root!.render(<Parts panel="open" />));
    act(() => {
      vi.advanceTimersByTime(LAYOUT_SETTLE_MS);
    });
    act(() => root!.render(<Parts />));
    act(() => {
      vi.advanceTimersByTime(LAYOUT_SETTLE_MS);
    });
    expect(layouts().map((event) => event.props)).toEqual([
      { window: 'note', sidebar: 'hidden', panel: 'open', fullWidth: true, themeMode: 'light' },
      { window: 'note', sidebar: 'hidden', panel: 'none', fullWidth: true, themeMode: 'light' },
    ]);
  });
});
