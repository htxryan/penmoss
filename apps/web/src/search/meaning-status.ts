/**
 * Semantic Search's status in the page (T78, A1158): main's, kept current, and how it reads.
 * Settings → Semantic Search (MeaningSettings.tsx) shows it.
 */
import { useEffect, useState } from 'react';
import { desktop, type DesktopMeaning, type DesktopMeaningStatus } from '../desktop/bridge';
import { counted, formatBytes } from '@penmoss/core/words';

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

/** `embeddinggemma-300m-q4@5090578d/768/p1` as people read it. */
export function modelName(model: string | undefined): string {
  if (!model) return 'the model';
  const name = model.split('@')[0] ?? model;
  return name === 'embeddinggemma-300m-q4' ? 'EmbeddingGemma 300M' : name;
}

/** One sentence for each state (A1158): Not Downloaded, Downloading, Indexing, Ready, Off. */
export function meaningStatusText(status: DesktopMeaningStatus): string {
  const size = status.totalBytes ? formatBytes(status.totalBytes) : 'about 219 MB';
  switch (status.state) {
    case 'off':
      // The model stays when it is switched off; Delete Model… removes it (A1566).
      return (status.modelBytes ?? 0) > 0 && status.modelBytes === status.totalBytes
        ? 'Off. Search matches your words. The model stays on this Mac for when you turn it on.'
        : `Off. Search matches your words. Turning it on downloads ${modelName(status.model)} (${size}) once.`;
    case 'absent':
      return `Not downloaded. ${modelName(status.model)} (${size}) downloads when Penmoss starts.`;
    case 'downloading': {
      const received = status.received ?? status.modelBytes ?? 0;
      const total = status.totalBytes ?? 0;
      const percent = total > 0 ? Math.floor((received / total) * 100) : 0;
      return `Downloading ${modelName(status.model)}… ${percent}% (${formatBytes(received)} of ${size}).`;
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
      return 'Semantic Search stopped unexpectedly. Starting it again…';
    case 'stopped':
      return 'Stopped.';
    case 'failed':
      return `Semantic Search could not start: ${status.error ?? 'unknown error'}.`;
  }
}

/**
 * Another Penmoss app on this Mac holds the indexing lease (A1350): this one searches with what is
 * indexed, so it says how many notes wait and that Semantic Search can miss them. Nothing once
 * every note is indexed.
 */
export function waitingText(status: DesktopMeaningStatus): string | null {
  if (!('leaseElsewhere' in status) || !status.leaseElsewhere) return null;
  const waiting = status.total - status.indexed;
  if (waiting <= 0) return null;
  return ` Another copy of Penmoss on this Mac is indexing, so ${counted(waiting, 'note waits', 'notes wait')} here; Semantic Search can miss ${waiting === 1 ? 'it' : 'them'} until then.`;
}

/** How far along the service is, 0–100, with its words; null when nothing is under way. */
export function meaningProgress(
  status: DesktopMeaningStatus,
): { readonly percent: number; readonly text: string } | null {
  if (status.state === 'downloading') {
    const received = status.received ?? status.modelBytes ?? 0;
    const total = status.totalBytes ?? 0;
    if (total <= 0) return null;
    const percent = Math.min(100, Math.floor((received / total) * 100));
    return { percent, text: `${formatBytes(received)} of ${formatBytes(total)}` };
  }
  if (status.state === 'indexing' || status.state === 'ready') {
    if (status.total <= 0) return null;
    const percent = Math.min(100, Math.floor((status.indexed / status.total) * 100));
    return {
      percent,
      text: `${status.indexed.toLocaleString('en-GB')} of ${status.total.toLocaleString('en-GB')} notes`,
    };
  }
  return null;
}
