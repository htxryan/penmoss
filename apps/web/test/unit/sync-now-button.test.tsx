// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Every git notebook this window holds, as `useAllSources` gives them.
const sources = [{ syncNow: vi.fn() }, { syncNow: vi.fn() }];
vi.mock('../../src/sources/hooks', () => ({
  useAllSources: () => ({ all: sources }),
  useSource: () => null,
}));

const { SyncNowButton } = await import('../../src/notes/NoteInfo');

let root: Root | null = null;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  document.body.replaceChildren();
});

describe('Sync Now beside Saved Locally (A1629)', () => {
  it('is an icon button called Sync Now that syncs every notebook, not only the note’s', () => {
    const host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    act(() => root!.render(<SyncNowButton />));
    const button = host.querySelector<HTMLButtonElement>('[data-testid="status-sync-now"]')!;
    expect(button.getAttribute('aria-label')).toBe('Sync Now');
    expect(button.dataset['tip']).toBe('Sync Now');
    expect(button.querySelector('svg')).not.toBeNull();
    act(() => button.click());
    for (const source of sources) expect(source.syncNow).toHaveBeenCalledTimes(1);
  });
});
