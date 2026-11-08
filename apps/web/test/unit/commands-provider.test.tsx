// @vitest-environment happy-dom
import { openLightbox, openLightboxNow } from '@penmoss/editor';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { CommandsProvider } from '../../src/commands/CommandsRoot';
import { navigate } from '../../src/router';
import { useCommand } from '../../src/commands/hooks';
import { WorkspaceContext } from '../../src/workspace/hooks';
import type { Workspace } from '../../src/workspace/service';

// A697: the Mac app's test pressed Alt+N as soon as the New note button showed and, 2
// launches in 40, got no note. The dispatcher listened from a passive effect, after the paint:
// a key in between found nothing listening. It now listens from the commit.

function NewNote({ made }: { made: string[] }) {
  useCommand('note.new', () => {
    made.push('note');
  });
  return <button type="button">New note</button>;
}

const workspace = {
  settings: () => ({}),
  setSetting: () => undefined,
  subscribe: () => () => undefined,
} as unknown as Workspace;

let unmount: (() => void) | null = null;

afterEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  if (unmount) act(unmount);
  unmount = null;
});

/** Alt+N, as a browser sends it. */
function altN(): KeyboardEvent {
  const key = new KeyboardEvent('keydown', {
    key: 'n',
    code: 'KeyN',
    altKey: true,
    bubbles: true,
    cancelable: true,
  });
  // happy-dom reports AltGraph held whenever Alt is; a browser does not (Alt+N is no AltGr).
  Object.defineProperty(key, 'getModifierState', { value: () => false });
  return key;
}

describe('CommandsProvider', () => {
  it('takes a shortcut pressed as soon as the button shows, before passive effects run', async () => {
    // No act(), no flushSync (which runs passive effects at once): as in the app, React commits,
    // and runs passive effects in a later task. The button showing is a DOM mutation, and its
    // observer runs right after the commit, before that task.
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = false;
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    unmount = () => {
      root.unmount();
      container.remove();
    };
    const made: string[] = [];
    const pressed = new Promise<KeyboardEvent>((resolve) => {
      const observer = new MutationObserver(() => {
        if (!container.querySelector('button')) return;
        observer.disconnect();
        const key = altN();
        window.dispatchEvent(key);
        resolve(key);
      });
      observer.observe(container, { childList: true, subtree: true });
    });
    root.render(
      <WorkspaceContext.Provider value={workspace}>
        <CommandsProvider>
          <NewNote made={made} />
        </CommandsProvider>
      </WorkspaceContext.Provider>,
    );
    const key = await pressed;
    expect(made).toEqual(['note']);
    expect(key.defaultPrevented).toBe(true);
  });

  it('waits while the image lightbox is open, and a change of page closes it (T51 review)', () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    unmount = () => {
      root.unmount();
      container.remove();
    };
    const made: string[] = [];
    act(() =>
      root.render(
        <WorkspaceContext.Provider value={workspace}>
          <CommandsProvider>
            <NewNote made={made} />
          </CommandsProvider>
        </WorkspaceContext.Provider>,
      ),
    );
    const box = openLightbox({ images: [{ src: 'blob:one', alt: '' }], index: 0 });
    window.dispatchEvent(altN());
    expect(made).toEqual([]);

    act(() => navigate('/elsewhere'));
    expect(box.open).toBe(false);
    expect(openLightboxNow()).toBeNull();
    // Closed: the shortcuts act again.
    window.dispatchEvent(altN());
    expect(made).toEqual(['note']);
  });
});
