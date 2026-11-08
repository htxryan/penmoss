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

// T78 (A1158): Settings → Search by Meaning, the Mac app only: what the service is doing, in
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

describe('what Search by Meaning says (A1158)', () => {
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
    expect(text({ state: 'off', enabled: false })).toBe(
      'Off. Search matches your words. Turning it on downloads EmbeddingGemma 300M (219 MB) once.',
    );
    expect(text({ state: 'failed', error: 'a file failed its checksum' })).toBe(
      'Search by meaning could not start: a file failed its checksum.',
    );
    expect(text({ state: 'restarting' })).toMatch(/Starting it again/);
  });
});

describe('Settings → Search by Meaning (T78)', () => {
  let root: Root | null = null;
  let host: HTMLDivElement;
  let status: DesktopMeaningStatus;
  let listeners: Array<(status: DesktopMeaningStatus) => void>;
  let asked: boolean[];

  const meaning: DesktopMeaning = {
    status: () => Promise.resolve(status),
    update: () => Promise.resolve([]),
    close: () => Promise.resolve(),
    search: () => Promise.resolve(null),
    setEnabled: (on) => {
      asked.push(on);
      status = on
        ? { ...base, state: 'absent', modelBytes: 0 }
        : { ...base, state: 'off', enabled: false, indexed: 0, total: 0 };
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

  it('shows the service’s state as it changes, and switches it off and on', async () => {
    await act(async () => {
      root!.render(<MeaningSettings />);
      await Promise.resolve();
    });
    expect(shown()).toBe('Indexing: 3 of 40 notes.');
    expect(toggle().checked).toBe(true);
    act(() => {
      for (const listener of listeners) listener({ ...base, leaseElsewhere: true });
    });
    expect(shown()).toBe(
      'Ready: EmbeddingGemma 300M (219 MB), on this Mac. All 40 notes are indexed. An agent’s penmoss mcp is indexing for now.',
    );
    expect(host.querySelector('a')?.getAttribute('href')).toBe('https://ai.google.dev/gemma/terms');
    await act(async () => {
      toggle().click();
      await Promise.resolve();
    });
    expect(asked).toEqual([false]);
    expect(toggle().checked).toBe(false);
    expect(shown()).toMatch(/^Off\. Search matches your words\./);
    await act(async () => {
      toggle().click();
      await Promise.resolve();
    });
    expect(asked).toEqual([false, true]);
    expect(shown()).toMatch(/^Not downloaded\./);
  });

  it('is not there outside the Mac app', () => {
    delete (window as { penmossDesktop?: unknown }).penmossDesktop;
    act(() => root!.render(<MeaningSettings />));
    expect(host.innerHTML).toBe('');
  });
});
