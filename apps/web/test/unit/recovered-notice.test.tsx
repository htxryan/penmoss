import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { WorkspaceContext } from '../../src/workspace/hooks';
import { recoveredText } from '../../src/workspace/recovered';
import { RecoveredNotice } from '../../src/workspace/RecoveredNotice';
import type { Workspace, WorkspaceState } from '../../src/workspace/service';

// #116, review S2 (A676): folder changes a closed window kept could not be merged. The server's
// recovery of refused changes (A581) went with the server (T59).

function render(recovered: WorkspaceState['recovered']): string {
  const state = {
    snapshot: { folders: [], notes: [], rootSortMode: 'manual' },
    loaded: true,
    recovered,
  } as WorkspaceState;
  const workspace = { subscribe: () => () => undefined, getState: () => state } as unknown;
  return renderToString(
    <WorkspaceContext.Provider value={workspace as Workspace}>
      <RecoveredNotice />
    </WorkspaceContext.Provider>,
  );
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
    expect(html).toContain('role="status"');
    expect(html).toContain('data-testid="folders-recovered"');
    expect(html).toContain('3 folder changes from a window that closed could not be kept.');
    expect(html).toContain('aria-label="Dismiss"');
  });
});
