/**
 * Search by meaning's status in the page (T78, A1158): main's, kept current, and how it reads.
 * Settings → Search by Meaning (MeaningSettings.tsx) shows it.
 */
import { useEffect, useState } from 'react';
import { desktop, type DesktopMeaning, type DesktopMeaningStatus } from '../desktop/bridge';

/** The service's status, kept current; null until read. Absent outside the Mac app. */
export function useMeaningStatus(): {
  meaning: DesktopMeaning;
  status: DesktopMeaningStatus | null;
} | null {
  const meaning = desktop()?.meaning ?? null;
  const [status, setStatus] = useState<DesktopMeaningStatus | null>(null);
  useEffect(() => {
    if (!meaning) return;
    let live = true;
    void meaning
      .status()
      .catch(() => null)
      .then((next) => {
        if (live && next) setStatus(next);
      });
    const off = meaning.onChange((next) => {
      if (live) setStatus(next);
    });
    return () => {
      live = false;
      off();
    };
  }, [meaning]);
  return meaning ? { meaning, status } : null;
}

const megabytes = (bytes: number) => `${Math.round(bytes / 1_000_000)} MB`;

/** `embeddinggemma-300m-q4@5090578d/768/p1` as people read it. */
export function modelName(model: string | undefined): string {
  if (!model) return 'the model';
  const name = model.split('@')[0] ?? model;
  return name === 'embeddinggemma-300m-q4' ? 'EmbeddingGemma 300M' : name;
}

/** One sentence for each state (A1158): Not Downloaded, Downloading, Indexing, Ready, Off. */
export function meaningStatusText(status: DesktopMeaningStatus): string {
  const size = status.totalBytes ? megabytes(status.totalBytes) : 'about 219 MB';
  switch (status.state) {
    case 'off':
      return `Off. Search matches your words. Turning it on downloads ${modelName(status.model)} (${size}) once.`;
    case 'absent':
      return `Not downloaded. ${modelName(status.model)} (${size}) downloads when Penmoss starts.`;
    case 'downloading': {
      const received = status.received ?? status.modelBytes ?? 0;
      const total = status.totalBytes ?? 0;
      const percent = total > 0 ? Math.floor((received / total) * 100) : 0;
      return `Downloading ${modelName(status.model)}… ${percent}% (${megabytes(received)} of ${size}).`;
    }
    case 'opening':
    case 'starting':
      return `Starting ${modelName(status.model)}…`;
    case 'indexing':
      return status.total > 0
        ? `Indexing: ${status.indexed} of ${status.total} notes.`
        : 'Indexing your notes…';
    case 'ready':
      return `Ready: ${modelName(status.model)} (${size}), on this Mac.${
        status.total > 0 ? ` All ${status.total} notes are indexed.` : ''
      }`;
    case 'restarting':
      return 'Search by meaning stopped unexpectedly. Starting it again…';
    case 'stopped':
      return 'Stopped.';
    case 'failed':
      return `Search by meaning could not start: ${status.error ?? 'unknown error'}.`;
  }
}
