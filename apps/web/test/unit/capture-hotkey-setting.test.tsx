// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CaptureHotkey, PenmossDesktop } from '../../src/desktop/bridge';
import { CaptureHotkeySetting } from '../../src/desktop/CaptureHotkeySetting';

// Settings → Keyboard Shortcuts' capture hotkey (T30, A226) when main refuses a change: it
// answers null to a shortcut over 100 characters, and the form says it wasn't saved.

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const HOTKEY: CaptureHotkey = {
  accelerator: 'Control+Alt+Command+N',
  registered: true,
  certain: false,
};

let root: Root;
let host: HTMLElement;

function install(setHotkey: PenmossDesktop['capture']['setHotkey']) {
  const capture: Partial<PenmossDesktop['capture']> = {
    hotkey: () => Promise.resolve(HOTKEY),
    setHotkey,
  };
  Object.assign(window, { penmossDesktop: { capture } as unknown as PenmossDesktop });
}

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  Reflect.deleteProperty(window, 'penmossDesktop');
});

/** Runs `step`, then lets the bridge's answers arrive. */
const settle = (step: () => void) =>
  act(async () => {
    step();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

const form = () => host.querySelector<HTMLFormElement>('[data-testid="capture-hotkey"]');
const status = () => host.querySelector('[role="status"]')?.textContent;

describe('the capture hotkey setting', () => {
  it('says a refused shortcut was not saved, and keeps the old one', async () => {
    install(() => Promise.resolve(null));
    await settle(() => root.render(<CaptureHotkeySetting />));
    expect(form()).not.toBeNull();
    await settle(() => form()!.requestSubmit());
    expect(status()).toBe(
      'That shortcut wasn’t saved: quick capture still opens with Control+Alt+Command+N.',
    );
    expect(form()).not.toBeNull();
  });

  it('says what a saved shortcut is', async () => {
    install((accelerator) => Promise.resolve({ ...HOTKEY, accelerator }));
    await settle(() => root.render(<CaptureHotkeySetting />));
    await settle(() => form()!.requestSubmit());
    expect(status()).toBe('Quick capture now opens with Control+Alt+Command+N.');
  });
});
