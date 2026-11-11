// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import { ToastStack } from '../../src/toasts/ToastStack';
import { WorkspaceContext } from '../../src/workspace/hooks';
import { recoveredText } from '../../src/workspace/recovered';
import { RecoveredNotice } from '../../src/workspace/RecoveredNotice';
import type { Workspace, WorkspaceState } from '../../src/workspace/service';

// #116, review S2 (A676): folder changes a closed window kept could not be merged. The server's
// recovery of refused changes (A581) went with the server (T59).

/** The notice in the window's toast stack (PEN-63), as the app mounts both; its HTML. */
function render(recovered: WorkspaceState['recovered']): string {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const state = {
    snapshot: { folders: [], notes: [], rootSortMode: 'manual' },
    loaded: true,
    recovered,
  } as WorkspaceState;
  const workspace = { subscribe: () => () => undefined, getState: () => state } as unknown;
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  // The stack makes room for the notice once it holds a place: a second pass renders it there.
  act(() =>
    root.render(
      <WorkspaceContext.Provider value={workspace as Workspace}>
        <ToastStack />
        <RecoveredNotice />
      </WorkspaceContext.Provider>,
    ),
  );
  const html = host.innerHTML;
  act(() => root.unmount());
  host.remove();
  return html;
}

describe('RecoveredNotice', () => {
  it('says how many folder changes from a window that closed could not be kept', () => {
    expect(recoveredText({ closed: 1, at: 1 })).toBe(
      '1 folder change from a window that closed could not be kept.',
    );
    expect(recoveredText({ closed: 2, at: 1 })).toBe(
      '2 folder changes from a window that closed could not be kept.',
    );
  });

  it('shows only when something was lost, in a live region, with a way to dismiss it', () => {
    expect(render(undefined)).not.toContain('folders-recovered');
    const html = render({ closed: 3, at: 5 });
    // In the window's one live region.
    expect(html).toMatch(/role="status"[^>]*>.*data-testid="folders-recovered"/s);
    expect(html).toContain('data-testid="folders-recovered"');
    expect(html).toContain('3 folder changes from a window that closed could not be kept.');
    expect(html).toContain('aria-label="Dismiss"');
  });
});
