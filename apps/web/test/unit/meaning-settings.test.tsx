// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  DesktopMeaning,
  DesktopMeaningStatus,
  PenmossDesktop,
} from '../../src/desktop/bridge';
import { MeaningSettings } from '../../src/search/MeaningSettings';
import { meaningStatusText } from '../../src/search/meaning-status';

// T78 (A1158, A1566): Settings → Semantic Search, the Mac app only: what the service is doing, in
// one sentence, and the switch, which main takes after a click.

const MODEL = 'embeddinggemma-300m-q4@5090578d/768/p1';
const base: DesktopMeaningStatus = {
  state: 'ready',
  generation: 1,
  enabled: true,
  model: MODEL,
  modelBytes: 218_725_224,
  totalBytes: 218_725_224,
  license: { name: 'Gemma Terms of Use', url: 'https://ai.google.dev/gemma/terms' },
  indexed: 40,
  total: 40,
};

describe('what Semantic Search says (A1158)', () => {
  it('names each state', () => {
    const text = (status: Partial<DesktopMeaningStatus>) =>
      meaningStatusText({ ...base, ...status });
    expect(text({ state: 'absent', modelBytes: 0 })).toBe(
      'Not downloaded. EmbeddingGemma 300M (219 MB) downloads when Penmoss starts.',
    );
    expect(text({ state: 'downloading', received: 109_362_612 })).toBe(
      'Downloading EmbeddingGemma 300M… 50% (109 MB of 219 MB).',
    );
    expect(text({ state: 'indexing', indexed: 12 })).toBe('Indexing: 12 of 40 notes.');
    expect(text({})).toBe(
      'Ready: EmbeddingGemma 300M (219 MB), on this Mac. All 40 notes are indexed.',
    );
    // Off keeps the model (A1566); once it is deleted, On downloads it again.
    expect(text({ state: 'off', enabled: false })).toBe(
      'Off. Search matches your words. The model stays on this Mac for when you turn it on.',
    );
    expect(text({ state: 'off', enabled: false, modelBytes: 0 })).toBe(
      'Off. Search matches your words. Turning it on downloads EmbeddingGemma 300M (219 MB) once.',
    );
    expect(text({ state: 'failed', error: 'a file failed its checksum' })).toBe(
      'Semantic Search could not start: a file failed its checksum.',
    );
    expect(text({ state: 'restarting' })).toMatch(/Starting it again/);
  });
});

describe('Settings → Semantic Search (T78)', () => {
  let root: Root | null = null;
  let host: HTMLDivElement;
  let status: DesktopMeaningStatus;
  let listeners: Array<(status: DesktopMeaningStatus) => void>;
  let asked: boolean[];
  let removed: number;

  const meaning: DesktopMeaning = {
    status: () => Promise.resolve(status),
    update: () => Promise.resolve([]),
    close: () => Promise.resolve(),
    search: () => Promise.resolve(null),
    setEnabled: (on) => {
      asked.push(on);
      // Off keeps the model (A1566): On opens it again, unless Delete Model took it.
      status = on
        ? status.modelBytes
          ? { ...base, state: 'ready' }
          : { ...base, state: 'absent', modelBytes: 0 }
        : { ...status, state: 'off', enabled: false, indexed: 0, total: 0 };
      for (const listener of listeners) listener(status);
      return Promise.resolve(status);
    },
    removeModel: () => {
      removed++;
      status = { ...base, state: 'off', enabled: false, indexed: 0, total: 0, modelBytes: 0 };
      for (const listener of listeners) listener(status);
      return Promise.resolve(status);
    },
    onChange: (listener) => {
      listeners.push(listener);
      return () => undefined;
    },
  };

  const shown = () => host.querySelector('[data-testid="meaning-status"]')?.textContent ?? '';
  const toggle = () => host.querySelector<HTMLInputElement>('[data-testid="meaning-enabled"]')!;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    status = { ...base, state: 'indexing', indexed: 3 };
    listeners = [];
    asked = [];
    removed = 0;
    (window as { penmossDesktop?: Partial<PenmossDesktop> }).penmossDesktop = { meaning };
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root?.unmount());
    root = null;
    host.remove();
    delete (window as { penmossDesktop?: unknown }).penmossDesktop;
  });

  it('shows the service’s state as it changes, and switches it off and on, keeping the model', async () => {
    await act(async () => {
      root!.render(<MeaningSettings />);
      await Promise.resolve();
    });
    expect(shown()).toBe('Indexing: 3 of 40 notes.');
    expect(toggle().checked).toBe(true);
    // PEN-146: a switch named for what it does, and a real progress bar, not a slider.
    expect(toggle().getAttribute('role')).toBe('switch');
    expect(host.querySelector(`label[for="${toggle().id}"]`)?.textContent).toBe('Semantic Search');
    const bar = host.querySelector('[role="progressbar"]')!;
    expect(bar.getAttribute('aria-valuenow')).toBe('7');
    expect(bar.getAttribute('aria-valuetext')).toBe('3 of 40 notes');
    expect(host.querySelector('[data-testid="meaning-model"]')?.textContent).toBe(
      'ModelEmbeddingGemma 300M · 219 MB · Gemma Terms of UseDelete Model…',
    );
    // Another app holds the lease (A1350): the notes this one has not indexed wait, and it says so.
    act(() => {
      for (const listener of listeners)
        listener({ ...base, state: 'indexing', indexed: 34, leaseElsewhere: true });
    });
    expect(shown()).toBe(
      'Indexing: 34 of 40 notes. Another copy of Penmoss on this Mac is indexing, so 6 notes wait here; Semantic Search can miss them until then.',
    );
    act(() => {
      for (const listener of listeners) listener({ ...base, leaseElsewhere: true });
    });
    expect(shown()).toBe(
      'Ready: EmbeddingGemma 300M (219 MB), on this Mac. All 40 notes are indexed.',
    );
    expect(host.querySelector('a')?.getAttribute('href')).toBe('https://ai.google.dev/gemma/terms');
    // Off stops it at once, with no question: the model stays (A1566).
    await act(async () => {
      toggle().click();
      await Promise.resolve();
    });
    expect(asked).toEqual([false]);
    expect(toggle().checked).toBe(false);
    expect(shown()).toBe(
      'Off. Search matches your words. The model stays on this Mac for when you turn it on.',
    );
    expect(removed).toBe(0);
    await act(async () => {
      toggle().click();
      await Promise.resolve();
    });
    expect(asked).toEqual([false, true]);
    expect(shown()).toMatch(/^Ready:/);
  });

  it('deletes the model after asking, naming its size, and then says it is not downloaded (A1566)', async () => {
    status = { ...base };
    await act(async () => {
      root!.render(<MeaningSettings />);
      await Promise.resolve();
    });
    const button = () =>
      host.querySelector<HTMLButtonElement>('[data-testid="meaning-delete-model"]');
    const ask = () => host.querySelector('[data-testid="meaning-delete-ask"]');
    expect(button()?.textContent).toBe('Delete Model…');
    // Cancel keeps it all.
    act(() => button()!.click());
    expect(ask()?.textContent).toContain('Delete the Model?');
    expect(ask()?.textContent).toContain(
      'EmbeddingGemma 300M (219 MB) and the semantic index are deleted from this Mac, and Semantic Search turns off',
    );
    expect(ask()?.textContent).toContain('Turning it on again downloads the model again.');
    act(() =>
      host.querySelector<HTMLButtonElement>('[data-testid="meaning-delete-cancel"]')!.click(),
    );
    expect(ask()).toBeNull();
    expect(removed).toBe(0);
    // Delete Model: deleted, off, and the row says so.
    act(() => button()!.click());
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-testid="meaning-delete-confirm"]')!.click();
      await Promise.resolve();
    });
    expect(removed).toBe(1);
    expect(asked).toEqual([]);
    expect(ask()).toBeNull();
    expect(toggle().checked).toBe(false);
    expect(host.querySelector('[data-testid="meaning-model-state"]')?.textContent).toBe(
      'EmbeddingGemma 300M · Not downloaded',
    );
    expect(button()).toBeNull();
    expect(shown()).toBe(
      'Off. Search matches your words. Turning it on downloads EmbeddingGemma 300M (219 MB) once.',
    );
    // On again downloads it.
    await act(async () => {
      toggle().click();
      await Promise.resolve();
    });
    expect(asked).toEqual([true]);
    expect(shown()).toMatch(/^Not downloaded\./);
  });

  it('is not there outside the Mac app', () => {
    delete (window as { penmossDesktop?: unknown }).penmossDesktop;
    act(() => root!.render(<MeaningSettings />));
    expect(host.innerHTML).toBe('');
  });
});
