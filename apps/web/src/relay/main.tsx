/**
 * The relay's Add Notebook page (A1701): the app's own Add Notebook (`AddNotebook`, the sheet
 * Settings → All Notebooks… opens), unchanged, over the relay's bridge (bridge.ts). The words that
 * name where it runs say "this relay" (host-words.ts). Setting Up's first sync is the relay's.
 * Bundled into the relay by apps/relay/scripts/add-flow.mjs; the styles are the app's
 * (apps/relay/scripts/app-css.mjs).
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { SourcesProvider } from '../sources/context';
import { AddNotebook } from '../sources/FirstRun';
import { RELAY_WORDS, setHostWords } from '../sources/host-words';
import { Sources } from '../sources/registry';
import { relayCall, relayDesktop, relaySource } from './bridge';

/** What the relay's page gives the script, in `<script type="application/json" id="relay-add">`. */
interface Start {
  readonly csrf: string;
  readonly login: string;
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
