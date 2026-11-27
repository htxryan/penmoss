/**
 * The relay's Add Notebook page (A1701): the app's own Add Notebook (`AddNotebook`, the sheet
 * Settings → All Notebooks… opens), unchanged, over the relay's bridge (bridge.ts). The words that
 * name where it runs say "this relay" (host-words.ts). Setting Up's first sync is the relay's.
 * Bundled into the relay by apps/relay/scripts/add-flow.mjs; the styles are the app's
 * (apps/relay/scripts/app-css.mjs).
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import type { GitNotebookInfo } from '../desktop/bridge';
import { SourcesProvider } from '../sources/context';
import type { GitSyncStatus } from '../sources/engine-host';
import { AddNotebook } from '../sources/FirstRun';
import type { GitSource } from '../sources/git-source';
import { RELAY_WORDS, setHostWords } from '../sources/host-words';
import { Sources } from '../sources/registry';
import { relayCall, relayDesktop, type RelayNotebook } from './bridge';

/** What the relay's page gives the script, in `<script type="application/json" id="relay-add">`. */
interface Start {
  readonly csrf: string;
  readonly login: string;
}

/** How often Setting Up asks the relay whether the first sync is done. */
const POLL_MS = 1500;

/**
 * A notebook as Add Notebook's Setting Up watches it: its first sync is the relay's, asked for
 * until it lands or fails. Nothing else of the app's notebook is used here.
 */
function relaySource(notebooks: () => Promise<readonly RelayNotebook[]>) {
  return (info: GitNotebookInfo): GitSource => {
    const listeners = new Set<() => void>();
    let status = {
      phase: 'syncing',
      detail: null,
      hostMessage: null,
      code: null,
      lastSyncAt: null,
      nextRetryAt: null,
      pending: [],
    } as unknown as GitSyncStatus;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const ask = async () => {
      const found = (await notebooks()).find((each) => each.notebookId === info.notebookId);
      const phase: GitSyncStatus['phase'] | null = found?.problem
        ? 'offline'
        : found?.syncedAt
          ? 'synced'
          : null;
      if (phase) {
        status = {
          ...status,
          phase,
          detail: found?.problem ?? null,
          lastSyncAt: found?.syncedAt ?? null,
        };
        for (const listener of listeners) listener();
      }
      if (phase !== 'synced') timer = setTimeout(() => void ask(), POLL_MS);
    };
    return {
      kind: 'git',
      id: info.notebookId,
      name: info.name,
      info,
      feed: {
        get status() {
          return status;
        },
        subscribe: (listener: () => void) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
      syncNow: () => undefined,
      notes: { knows: () => false, list: () => [], onStored: () => () => undefined },
      start: () => void ask(),
      stop: () => {
        if (timer) clearTimeout(timer);
      },
      setInfo: () => undefined,
      storedElsewhere: () => Promise.resolve(),
    } as unknown as GitSource;
  };
}

const start = JSON.parse(
  document.getElementById('relay-add')?.textContent ?? 'null',
) as Start | null;
const root = document.getElementById('relay-add-root');
if (root && start) {
  setHostWords(RELAY_WORDS);
  const relay = relayDesktop(relayCall(start.csrf));
  window.penmossDesktop = relay.desktop;
  const sources = new Sources({ git: relay.git, makeGit: relaySource(relay.notebooks) });
  void sources.load();
  const toNotebooks = (added?: string) =>
    location.assign(added ? `/notebooks?added=${encodeURIComponent(added)}` : '/notebooks');
  createRoot(root).render(
    <StrictMode>
      <SourcesProvider sources={sources}>
        <AddNotebook
          git={relay.git}
          onClose={() => toNotebooks()}
          onAdded={(notebookId) =>
            toNotebooks((notebookId ? sources.gitSource(notebookId)?.name : undefined) ?? undefined)
          }
        />
      </SourcesProvider>
    </StrictMode>,
  );
}
