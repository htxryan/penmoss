// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { navigate, useLocation } from '../../src/router';

// A1179: a shortcut that navigates as soon as the page shows (⌘⌥N at the Mac app's launch) was
// shown only once React ran the commit's passive effects, where useSyncExternalStore subscribes:
// the browser handles keys already queued before that task, so the keys typed next went to the
// page, not to the new note's title. The location is followed from the commit too.

function Path() {
  return <p>{useLocation().pathname}</p>;
}

let unmount: (() => void) | null = null;

afterEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  if (unmount) act(unmount);
  unmount = null;
  window.history.replaceState(null, '', '/');
});

describe('useLocation', () => {
  it('shows a navigation made in a key event after the commit, before passive effects run', async () => {
    // No act(), no flushSync (which runs passive effects at once): as in the app, React commits
    // and runs passive effects in a later task. The text showing is a DOM mutation, and its
    // observer runs right after the commit, before that task.
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
    window.history.replaceState(null, '', '/');
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    unmount = () => {
      root.unmount();
      container.remove();
    };
    const onKey = () => navigate('/settings');
    window.addEventListener('keydown', onKey);
    const pressed = new Promise<void>((resolve) => {
      const observer = new MutationObserver(() => {
        if (container.textContent !== '/') return;
        observer.disconnect();
        // A browser's `window.event` while the key is dispatched (happy-dom has none): React
        // gives the key's updates its priority from it.
        const key = new KeyboardEvent('keydown', { key: 'n', bubbles: true });
        Object.defineProperty(window, 'event', { configurable: true, get: () => key });
        try {
          window.dispatchEvent(key);
        } finally {
          Object.defineProperty(window, 'event', { configurable: true, get: () => undefined });
        }
        resolve();
      });
      observer.observe(container, { childList: true, subtree: true, characterData: true });
    });
    root.render(<Path />);
    await pressed;
    window.removeEventListener('keydown', onKey);
    // React renders a discrete event's update in a microtask: the next key (a task) finds it.
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(container.textContent).toBe('/settings');
  });
});
