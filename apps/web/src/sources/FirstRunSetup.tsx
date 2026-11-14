/**
 * The first run's last screen (First Run C, 7.1 and 7.3): the notebook is added (or made), then
 * its first sync runs while the screen says so, step by step. Once it syncs the app opens on it
 * (7.2: a new notebook on its welcome note). A failed first sync says why, with Retry and Open
 * Anyway: the notebook is on this Mac already, and nothing is lost.
 */
import { Icon } from '@penmoss/ui/icons';
import { useEffect, useRef, useState } from 'react';
import { navigate, notePath } from '../router';
import { refusalWords, type AddNotebook, type Place, type Setup } from './first-run-flow';
import { Action, Frame } from './FirstRunFrame';
import type { GitSource } from './git-source';
import { useSourcesRegistry } from './hooks';
import { addWelcomeNote } from './welcome-note';

type Phase =
  | { readonly at: 'adding' }
  | { readonly at: 'add-failed'; readonly message: string }
  | { readonly at: 'syncing'; readonly source: GitSource }
  | { readonly at: 'sync-failed'; readonly source: GitSource; readonly message: string };

type Mark = 'done' | 'doing' | 'failed' | 'todo';

/** How long the first sync runs before Open Now is offered (a large notebook takes a while). */
const SLOW_MS = 15_000;

export function SettingUp({
  setup,
  add,
  onDone,
  onNeedsName,
  back,
}: {
  setup: Setup;
  add: AddNotebook;
  /** The notebook is set up (or opened anyway): the app opens it. */
  onDone: () => void;
  /** The folder held no notebook after all: name the new one. */
  onNeedsName: (place: Place) => void;
  back: () => void;
}) {
  const registry = useSourcesRegistry();
  const [phase, setPhase] = useState<Phase>({ at: 'adding' });
  const [attempt, setAttempt] = useState(0);
  const [slow, setSlow] = useState(false);
  const ran = useRef(-1);
  const { place, name } = setup;

  useEffect(() => {
    // Once per attempt, StrictMode's second run included: a second add would clone again.
    if (ran.current === attempt) return;
    ran.current = attempt;
    const watch = async (notebookId: string, created: boolean) => {
      await registry?.refresh();
      const source = registry?.gitSource(notebookId) ?? null;
      if (created && source) {
        // A notebook made here starts with the welcome note, which opens with the app (T69).
        void addWelcomeNote(source)
          .then((id) => {
            // Only while the app is still at its start: a note opened meanwhile stays open.
            if (id && window.location.pathname === '/') navigate(notePath(id));
          })
          .catch((error: unknown) =>
            console.warn('[first run] could not write the welcome note', error),
          );
      }
      // Without a sync feed (tests that stand in a notebook) there is nothing to wait for.
      if (!source?.feed) {
        onDone();
        return;
      }
      setPhase({ at: 'syncing', source });
    };
    void (async () => {
      setPhase({ at: 'adding' });
      if (setup.kind === 'added') {
        await watch(setup.notebookId, false);
        return;
      }
      const result = await add({
        remote: place.remote,
        branch: place.branch,
        dir: place.dir,
        ...(setup.kind === 'open' ? {} : { name }),
        ...(place.githubSignIn ? { githubSignIn: true } : {}),
      });
      if (!result) setPhase({ at: 'add-failed', message: 'This window cannot add git notebooks.' });
      else if (!result.ok) setPhase({ at: 'add-failed', message: refusalWords(result.error) });
      else if (result.value.kind === 'needs-name') onNeedsName(place);
      else await watch(result.value.notebook.notebookId, result.value.created);
    })();
    // The setup is this screen's for good; a retry is a new attempt.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt]);

  // The first sync, as the notebook's engine tells it.
  const syncing = phase.at === 'syncing' || phase.at === 'sync-failed' ? phase.source : null;
  useEffect(() => {
    if (!syncing) return;
    const heard = () => {
      const status = syncing.feed.status;
      if (status.phase === 'synced') onDone();
      else if (status.phase === 'offline' || status.phase === 'stopped') {
        setPhase({
          at: 'sync-failed',
          source: syncing,
          message: status.detail ?? 'it stopped',
        });
      } else
        setPhase((now) => (now.at === 'sync-failed' ? now : { at: 'syncing', source: syncing }));
    };
    heard();
    const stop = syncing.feed.subscribe(heard);
    const timer = setTimeout(() => setSlow(true), SLOW_MS);
    return () => {
      stop();
      clearTimeout(timer);
    };
    // onDone is the flow's; the source is what matters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [syncing]);

  const clones = setup.kind === 'open' || setup.kind === 'added';
  const steps: Array<{ mark: Mark; words: string }> = [];
  if (setup.kind === 'create') steps.push({ mark: 'done', words: `Created ${place.label}` });
  if (phase.at === 'adding') {
    steps.push({
      mark: 'doing',
      words: clones ? `Cloning ${place.label}…` : 'Setting up the notebook…',
    });
  } else if (phase.at === 'add-failed') {
    steps.push({
      mark: 'failed',
      words: `${clones ? `Couldn’t clone ${place.label}` : 'Couldn’t set up the notebook'}: ${phase.message}`,
    });
  } else {
    steps.push({ mark: 'done', words: clones ? `Cloned ${place.label}` : 'Set up the notebook' });
  }
  steps.push(
    phase.at === 'syncing'
      ? { mark: 'doing', words: 'First sync…' }
      : phase.at === 'sync-failed'
        ? { mark: 'failed', words: `First sync failed: ${phase.message}` }
        : { mark: 'todo', words: 'First sync' },
  );

  const failed = phase.at === 'add-failed' || phase.at === 'sync-failed';
  return (
    <Frame
      name="setup"
      state={phase.at}
      title={failed ? 'Couldn’t Finish Setting Up' : clones ? `Opening ${name}` : `Making ${name}`}
      back={phase.at === 'add-failed' ? back : undefined}
      actions={
        phase.at === 'add-failed' ? (
          <Action
            primary
            icon="refresh"
            testId="first-run-retry"
            onClick={() => setAttempt((n) => n + 1)}
          >
            Retry
          </Action>
        ) : phase.at === 'sync-failed' ? (
          <>
            <Action testId="first-run-open-anyway" onClick={onDone}>
              Open Anyway
            </Action>
            <Action
              primary
              icon="refresh"
              testId="first-run-retry"
              onClick={() => {
                setPhase({ at: 'syncing', source: phase.source });
                phase.source.syncNow();
              }}
            >
              Retry
            </Action>
          </>
        ) : phase.at === 'syncing' && slow ? (
          <Action testId="first-run-open-now" onClick={onDone}>
            Open Now
          </Action>
        ) : undefined
      }
    >
      <ol className="fr-checklist" data-testid="first-run-steps">
        {steps.map((step) => (
          <li key={step.words} data-mark={step.mark} data-testid="first-run-step">
            {step.mark === 'doing' ? (
              <span className="fr-spin fr-spin-lg" aria-hidden="true" />
            ) : (
              <span className={`fr-mark fr-mark-${step.mark}`} aria-hidden="true">
                {step.mark === 'done' ? (
                  <Icon name="check" size={12} />
                ) : step.mark === 'failed' ? (
                  <Icon name="close" size={12} />
                ) : null}
              </span>
            )}
            <span role={step.mark === 'failed' ? 'alert' : undefined}>{step.words}</span>
          </li>
        ))}
      </ol>
      {phase.at === 'sync-failed' ? (
        <p className="fr-lead">The notebook is on this Mac. Nothing is lost.</p>
      ) : null}
    </Frame>
  );
}
