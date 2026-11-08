/**
 * The Mac app's window behaviours as the page sees them (T46, T47; A720–A725).
 *
 * - **Keep on top (A720):** the window's pin, as the main process says it is. View → Keep on
 *   top's tick, the pin button and the `window.keepOnTop` command all read it here, so they
 *   stay in step per window.
 * - **Compact title bar (A722, A723):** in a compact window `<html data-titlebar="compact">`
 *   leaves room for the traffic lights in the first row (styles.css) and makes the rows drag
 *   the window (`no-drag.ts` lists what never does); out of full screen only, as the lights
 *   hide in it. Double-clicking a row is Chromium's, not the page's (A723): a drag region gives
 *   the page no mouse events on a Mac.
 */
import { useSyncExternalStore } from 'react';
import { desktop, type MacWindow, type MacWindowState, type PenmossDesktop } from './bridge';

const UNPINNED: MacWindowState = { keepOnTop: false, fullScreen: false };

/** One window's state, kept from the main process's events. */
export class MacWindowStore {
  private state: MacWindowState = UNPINNED;
  private readonly listeners = new Set<() => void>();
  private stop: (() => void) | null = null;

  constructor(private readonly bridge: MacWindow) {}

  start(): void {
    if (this.stop) return;
    this.stop = this.bridge.onState((state) => this.set(state));
    void this.bridge
      .state()
      .then((state) => {
        if (state) this.set(state);
      })
      .catch(() => undefined);
  }

  get titleBar(): MacWindow['titleBar'] {
    return this.bridge.titleBar;
  }

  readonly get = (): MacWindowState => this.state;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Pins or unpins the window; the state comes back from the main process. */
  async setKeepOnTop(keepOnTop: boolean): Promise<void> {
    const state = await this.bridge.setKeepOnTop(keepOnTop).catch(() => null);
    if (state) this.set(state);
  }

  private set(state: MacWindowState): void {
    const next = { keepOnTop: state.keepOnTop === true, fullScreen: state.fullScreen === true };
    if (next.keepOnTop === this.state.keepOnTop && next.fullScreen === this.state.fullScreen) {
      return;
    }
    this.state = next;
    for (const listener of this.listeners) listener();
  }
}

let store: MacWindowStore | null = null;
let storeBridge: PenmossDesktop | null = null;

/** This window's store, or null outside the Mac app's main and note windows. */
export function macWindowStore(bridge: PenmossDesktop | null = desktop()): MacWindowStore | null {
  const mac = bridge?.macWindow;
  if (!bridge || !mac) return null;
  if (!store || storeBridge !== bridge) {
    store = new MacWindowStore(mac);
    storeBridge = bridge;
    store.start();
  }
  return store;
}

const NONE = () => () => undefined;
const unpinned = () => UNPINNED;

/** This window's pin and full screen (unpinned outside the Mac app's windows). */
export function useMacWindowState(): MacWindowState {
  const mac = macWindowStore();
  return useSyncExternalStore(mac?.subscribe ?? NONE, mac?.get ?? unpinned, mac?.get ?? unpinned);
}

/** Whether the layout leaves room for the lights now: a compact window out of full screen. */
export function compactNow(titleBar: MacWindow['titleBar'], state: MacWindowState): boolean {
  return titleBar === 'compact' && !state.fullScreen;
}

/** Keeps `<html data-titlebar>` in step with the window (compact, out of full screen). Returns the stop. */
export function startTitleBar(
  root: HTMLElement,
  mac: MacWindowStore | null = macWindowStore(),
): () => void {
  if (!mac || mac.titleBar !== 'compact') return () => undefined;
  const apply = () => {
    if (compactNow(mac.titleBar, mac.get())) root.dataset['titlebar'] = 'compact';
    else delete root.dataset['titlebar'];
  };
  apply();
  const unsubscribe = mac.subscribe(apply);
  return () => {
    unsubscribe();
    delete root.dataset['titlebar'];
  };
}
