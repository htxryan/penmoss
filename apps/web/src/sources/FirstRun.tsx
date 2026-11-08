/**
 * The first run (T59, A1030; T69, A1146): with no git notebook on this Mac the app has nothing to
 * open, since git notebooks are the only kind (D48, D49). Until one is added or made, the window
 * shows this guide (a welcome, then a new notebook or one that exists, each with Settings → Git
 * Notebooks' own Add form); once the list has one, the app opens it.
 * The app's views are mounted only then, so their root and Journal notebook are never missing.
 */
import { BrandMark, Icon } from '@penmoss/ui/icons';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { desktop } from '../desktop/bridge';
import { navigate, notePath } from '../router';
import { AddGitNotebook, type Added } from './GitNotebooksSettings';
import { useAllSources, useSourcesRegistry } from './hooks';
import { addWelcomeNote } from './welcome-note';
import { isOpen } from './registry';
import './sources.css';

/** Renders `children` once there is a notebook; the first run (or a wait) until then. */
export function FirstRunGate({
  children,
  capture = false,
}: {
  children: ReactNode;
  /** The Mac's capture window: it says where to add one rather than showing the form. */
  capture?: boolean;
}) {
  const state = useAllSources();
  // Without a registry (tests that render one source), there is nothing to wait for.
  if (!state) return children;
  if (isOpen(state)) return children;
  if (!state.loaded) {
    return (
      <p className="boot" role="status">
        Opening Penmoss…
      </p>
    );
  }
  return capture ? <CaptureFirstRun /> : <FirstRun />;
}

/** Where the first run is (T69, A1146): the welcome, then one of its two ways on. */
type Step = 'welcome' | 'new' | 'existing';

const GITHUB_NEW = 'https://github.com/new';

/**
 * Welcome, and add or make the first git notebook (T69, #228, A1146): what Penmoss keeps and
 * where, then a new notebook (an empty private repository, named) or one that exists.
 */
export function FirstRun() {
  const git = desktop()?.git ?? null;
  const registry = useSourcesRegistry();
  const [step, setStep] = useState<Step>('welcome');
  const back = useRef<HTMLButtonElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  // Each step's heading takes focus, so a screen reader hears where it is.
  useEffect(() => {
    if (step === 'welcome') heading.current?.focus();
    else back.current?.focus();
  }, [step]);

  /** A notebook made here starts with the welcome note, which opens with the app. */
  const onAdded = (added: Added) => {
    if (!added.created || !registry) return;
    const source = registry.getState().all.find((each) => each.id === added.notebookId);
    if (!source) return;
    void addWelcomeNote(source)
      .then((id) => {
        // Only while the app is still at its start: a note opened meanwhile stays open.
        if (id && window.location.pathname === '/') navigate(notePath(id));
      })
      .catch((error: unknown) =>
        console.warn('[first run] could not write the welcome note', error),
      );
  };

  return (
    <main className="app-shell first-run" data-testid="first-run" data-step={step}>
      <h1 className="brand">
        <BrandMark />
        <span>Penmoss</span>
      </h1>
      {!git ? (
        <section className="settings-section" aria-labelledby="first-run-heading">
          <h2 id="first-run-heading">Add a git notebook</h2>
          <p data-testid="first-run-no-mac">
            Penmoss runs in its Mac app, which keeps your notes in git notebooks. Open the Mac app
            to add one.
          </p>
        </section>
      ) : step === 'welcome' ? (
        <section className="settings-section" aria-labelledby="first-run-heading">
          <h2 id="first-run-heading" ref={heading} tabIndex={-1}>
            Welcome to Penmoss
          </h2>
          <p>
            Penmoss keeps your notes as Markdown in a <strong>git notebook</strong>: a private
            repository you own, synced by this Mac’s own git. There is no Penmoss account, and your
            notes never go to a Penmoss server.
          </p>
          <div className="first-run-choices">
            <button
              type="button"
              className="first-run-choice"
              data-ui="item"
              data-testid="first-run-new"
              onClick={() => setStep('new')}
            >
              <Icon name="plus" />
              <span className="first-run-choice-text">
                <strong>Start a new notebook</strong>
                <span>In an empty private repository you make now.</span>
              </span>
            </button>
            <button
              type="button"
              className="first-run-choice"
              data-ui="item"
              data-testid="first-run-existing"
              onClick={() => setStep('existing')}
            >
              <Icon name="notebook" />
              <span className="first-run-choice-text">
                <strong>Open a notebook you already have</strong>
                <span>From a repository Penmoss has kept notes in before.</span>
              </span>
            </button>
          </div>
          <GitAccess />
        </section>
      ) : (
        <section className="settings-section" aria-labelledby="first-run-heading">
          <button
            ref={back}
            type="button"
            className="btn first-run-back"
            data-ui="item"
            data-testid="first-run-back"
            onClick={() => setStep('welcome')}
          >
            <Icon name="chevL" size={14} />
            Back
          </button>
          <h2 id="first-run-heading">
            {step === 'new' ? 'Start a new notebook' : 'Open a notebook you already have'}
          </h2>
          {step === 'new' && git.github ? (
            // T81 (B7): the repository is picked or created in the form below.
            <ol className="first-run-steps">
              <li>
                Create a <strong>private</strong> repository below, or pick an empty one you made.
                You can also{' '}
                <a href={GITHUB_NEW} target="_blank" rel="noreferrer">
                  create one on GitHub
                </a>{' '}
                yourself, or type the address of one anywhere this Mac’s git can push to.
              </li>
              <li>Name the notebook. Penmoss sets it up in the repository at its first sync.</li>
            </ol>
          ) : step === 'new' ? (
            <ol className="first-run-steps">
              <li>
                Make an empty <strong>private</strong> repository, with no README:{' '}
                <a href={GITHUB_NEW} target="_blank" rel="noreferrer">
                  create one on GitHub
                </a>
                , or anywhere this Mac’s git can push to.
              </li>
              <li>Copy its address (SSH or HTTPS) and paste it below.</li>
              <li>Name the notebook. Penmoss sets it up in the repository at its first sync.</li>
            </ol>
          ) : git.github ? (
            <p>
              Pick the repository that holds the notebook, then its folder, or type its address. If
              the folder holds none yet, you will be asked to name a new one.
            </p>
          ) : (
            <p>
              Paste the address of the repository that holds the notebook. If it holds none yet, you
              will be asked to name a new one.
            </p>
          )}
          <AddGitNotebook git={git} mode={step} onAdded={onAdded} />
          <GitAccess />
          <p className="muted">
            You can add more notebooks, and change how each syncs, in Settings → Git Notebooks.
          </p>
        </section>
      )}
    </main>
  );
}

/** How Penmoss reaches the repository (T69): this Mac's git, or a token later. */
function GitAccess() {
  return (
    <details className="first-run-more" data-testid="first-run-access">
      <summary>How Penmoss signs in to git</summary>
      <p>
        Penmoss uses this Mac’s own git and its sign-in: an SSH key, or the credential helper (such
        as GitHub Desktop’s or the macOS Keychain). If <code>git push</code> works in Terminal for
        the repository, Penmoss can sync it. If git isn’t signed in to GitHub, Sign In with GitHub
        here lets Penmoss list your repositories and sync the notebook it adds over HTTPS. You can
        also give a notebook a personal access token in Settings → Git Notebooks once it is added.
      </p>
      <p>Who can read the repository is up to you: keep it private to keep your notes private.</p>
    </details>
  );
}

/** The capture window with no notebook: nowhere to capture to yet. */
function CaptureFirstRun() {
  return (
    <main className="app-shell first-run" data-testid="first-run-capture">
      <p role="status">
        Add a git notebook in the Penmoss window first: captures go into your Primary Notebook.
      </p>
    </main>
  );
}
