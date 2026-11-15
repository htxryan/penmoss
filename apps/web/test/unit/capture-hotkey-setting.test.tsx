// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CaptureHotkey, PenmossDesktop } from '../../src/desktop/bridge';
import { CaptureHotkeySetting } from '../../src/desktop/CaptureHotkeySetting';
import { acceleratorToCombo, comboToAccelerator } from '../../src/desktop/hotkey-keys';

// Settings → Quick Capture → Shortcut From Any App (T30, A226; PEN-146): the Mac app's capture
// hotkey is recorded by pressing the keys, as every other shortcut in Settings is, and the row
// says what main answered: the new keys, its refusal, or that nothing was saved.

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

const row = () => host.querySelector<HTMLElement>('[data-testid="capture-hotkey"]');
const change = () => row()!.querySelector<HTMLButtonElement>('button')!;
const note = () => row()!.querySelector('.wr-row-note');
/** A key press as a browser sends it (the tests' platform is not a Mac: Ctrl is Mod). */
const press = (init: KeyboardEventInit) =>
  window.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));

describe('the capture hotkey setting', () => {
  it('records the keys pressed after Change and saves them as an accelerator', async () => {
    const setHotkey = vi.fn((accelerator: string) =>
      Promise.resolve({ ...HOTKEY, accelerator, certain: true }),
    );
    install(setHotkey);
    await settle(() => root.render(<CaptureHotkeySetting />));
    expect(row()!.dataset.setting).toBe('shortcut-from-any-app');
    expect(row()!.dataset.accelerator).toBe('Control+Alt+Command+N');
    await settle(() => change().click());
    expect(row()!.textContent).toContain('Press keys… Esc cancels');
    expect(change().textContent).toBe('Cancel');
    // A lone modifier keeps it listening.
    await settle(() => press({ key: 'Control', code: 'ControlLeft', ctrlKey: true }));
    expect(setHotkey).not.toHaveBeenCalled();
    await settle(() => press({ key: 'J', code: 'KeyJ', ctrlKey: true, shiftKey: true }));
    expect(setHotkey).toHaveBeenCalledWith('Control+Shift+J');
    expect(row()!.dataset.accelerator).toBe('Control+Shift+J');
    expect(note()?.getAttribute('role')).toBe('status');
    expect(note()?.textContent).toBe('Quick Capture now opens with Ctrl+Shift+J.');
    expect(change().textContent).toBe('Change');
  });

  it('says why main refused the keys, and keeps the old ones', async () => {
    install(() =>
      Promise.resolve({
        ...HOTKEY,
        error: 'Control+Shift+Z copies, pastes, undoes or edits text: Penmoss keeps it free',
      }),
    );
    await settle(() => root.render(<CaptureHotkeySetting />));
    await settle(() => change().click());
    await settle(() => press({ key: 'Z', code: 'KeyZ', ctrlKey: true, shiftKey: true }));
    expect(note()?.getAttribute('role')).toBe('alert');
    expect(note()?.textContent).toContain('Penmoss keeps it free');
    expect(row()!.dataset.accelerator).toBe('Control+Alt+Command+N');
  });

  it('says a shortcut main would not take was not saved', async () => {
    install(() => Promise.resolve(null));
    await settle(() => root.render(<CaptureHotkeySetting />));
    await settle(() => change().click());
    await settle(() => press({ key: 'K', code: 'KeyK', ctrlKey: true, altKey: true }));
    // ⌃⌥⌘N off a Mac shows as Ctrl+Alt+N (Control and Command are both Ctrl there).
    expect(note()?.textContent).toBe(
      'That shortcut wasn’t saved: Quick Capture still opens with Ctrl+Alt+N.',
    );
  });

  it('Escape stops listening without a change', async () => {
    const setHotkey = vi.fn();
    install(setHotkey);
    await settle(() => root.render(<CaptureHotkeySetting />));
    await settle(() => change().click());
    await settle(() => press({ key: 'Escape', code: 'Escape' }));
    expect(setHotkey).not.toHaveBeenCalled();
    expect(change().textContent).toBe('Change');
  });

  it('shows nothing outside the Mac app', async () => {
    await settle(() => root.render(<CaptureHotkeySetting />));
    expect(row()).toBeNull();
  });
});

describe('the hotkey’s keys', () => {
  it('turn a combination into an accelerator on a Mac and elsewhere', () => {
    expect(comboToAccelerator('Mod+Ctrl+Alt+N', true)).toBe('Command+Control+Alt+N');
    expect(comboToAccelerator('Ctrl+Shift+F9', true)).toBe('Control+Shift+F9');
    expect(comboToAccelerator('Mod+Shift+J', false)).toBe('Control+Shift+J');
    expect(comboToAccelerator('Mod+Alt+Enter', false)).toBe('Control+Alt+Return');
  });

  it('turn an accelerator into a combination to show', () => {
    expect(acceleratorToCombo('Control+Alt+Command+N', true)).toBe('Mod+Ctrl+Alt+N');
    expect(acceleratorToCombo('Control+Shift+Space', false)).toBe('Mod+Shift+Space');
    expect(acceleratorToCombo('CommandOrControl+Alt+Plus', false)).toBe('Mod+Alt++');
  });
});
