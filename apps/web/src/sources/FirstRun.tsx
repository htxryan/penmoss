/**
 * The first run (T59, A1030; T69, A1146; Ryan's review of #192, findings 2–4): with no git
 * notebook on this Mac the app has nothing to open, since git notebooks are the only kind (D48,
 * D49). Until one is added or made, the window shows this guide, one step per screen (First Run
 * C): a short welcome; Create or Open Notebook; Pick Repository (Create New Repo, Use Existing
 * Repo or Paste a URL), with GitHub's sign-in on the way when it is needed; Name Your Notebook
 * when a new one is made; then Setting Up, until the first sync. Every screen but the first and
 * the last has the "Step n of 3" bar and a footer with Back and its button. The app's views are
 * mounted only once a notebook is set up, so their root and Journal notebook are never missing.
 *
 * Settings → All Notebooks → Add Notebook… (A1562) is this same flow, its screens and their state,
 * in a sheet over Settings (`AddNotebook`): it starts at Create or Open Notebook with Cancel in
 * Back's place, writes no welcome note, and ends on the notebook's page in Settings.
 *
 * The first run ends with the consent question (PEN-137), "Last Step", when this Mac has no answer
 * yet: the app opens once it is answered. Add Notebook never asks it. Each step the first run
 * leaves is recorded by name (`firstrun` events: done or back), on this Mac whatever the answer.
 */
import { BrandMark } from '@penmoss/ui/icons';
import { ConsentAnswers, ConsentQuestion, ExistingInstallConsent } from '../analytics/Consent';
import { record } from '../analytics/record';
import { analyticsBridge, copy } from '../analytics/status';
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  desktop,
  type DesktopGit,
  type GitHubAccountChoice,
  type GitHubRepo,
} from '../desktop/bridge';
import { GitHubSettings } from '../feedback/GitHubSettings';
import { gitNotebookPath, navigate } from '../router';
import {
  asAccount,
  FIRST_RUN_DOCS,
  placeIn,
  type AddNotebook,
  type Goal,
  type Hub,
  type RepoRead,
  type Screen,
} from './first-run-flow';
import { Action, Frame, Options } from './FirstRunFrame';
import { GitHubAccess } from './FirstRunGitHub';
import { AccountSwitcher } from './FirstRunAccountSwitcher';
import { CreateRepo } from './FirstRunCreateRepo';
import { FolderPick } from './FirstRunFolderPick';
import { GitMissing } from './FirstRunGitMissing';
import { NameNotebook } from './FirstRunNameNotebook';
import { PasteUrl } from './FirstRunPasteUrl';
import { RepoPicked } from './FirstRunRepoPicked';
import { RepoTree } from './FirstRunRepos';
import { AiProviderStep, AiQuestion } from './FirstRunAi';
import { SettingUp } from './FirstRunSetup';
import { useAllSources } from './hooks';
import { isOpen } from './registry';
import './sources.css';
import { hostWords } from './host-words';

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
  /** A notebook is being set up (7.1): the first run stays until its first sync. */
  const [held, setHeld] = useState(false);
  if (isOpen(state) && !held) {
    return (
      <>
        {children}
        {/* An install with notebooks and no answer is asked once, over the app (PEN-137, ac8). */}
        {capture ? null : <ExistingInstallConsent />}
      </>
    );
  }
  if (!state.loaded) {
    return (
      <BareWindow>
        <p className="boot" role="status">
          Opening Penmoss…
        </p>
      </BareWindow>
    );
  }
  return <BareWindow>{capture ? <CaptureFirstRun /> : <FirstRun onHold={setHeld} />}</BareWindow>;
}

/**
 * A window with none of the app in it yet (the wait for the notebooks, the first run): with the
 * Mac's compact title bar, a strip across the top drags the window (Ryan's review of #192, finding
 * 1), whatever the screen under it holds. That screen scrolls in its own box below the strip, so
 * nothing it holds is ever in the strip.
 */
function BareWindow({ children }: { children: ReactNode }) {
  return (
    <>
      <div className="window-drag" aria-hidden="true" data-testid="window-drag" />
      <div className="window-bare">{children}</div>
    </>
  );
}

type Way = 'create' | 'existing' | 'url';

/** The first run, or, outside the Mac app's bridge, where to find it. */
function FirstRun({ onHold }: { onHold?: (hold: boolean) => void }) {
  const git = desktop()?.git ?? null;
  if (!git) {
    return (
      <main className="app-shell first-run-plain" data-testid="first-run">
        <h1 className="brand">
          <BrandMark />
          <span>Penmoss</span>
        </h1>
        <p data-testid="first-run-no-mac">
          Penmoss runs in its Mac app, which keeps your notes in git notebooks. Open the Mac app to
          add one.
        </p>
      </main>
    );
  }
  return (
    <main className="first-run" data-testid="first-run" data-flow="first-run">
      <NotebookSteps git={git} firstRun onHold={onHold} />
    </main>
  );
}

/**
 * Add Notebook from Settings (A1562): the first run's own screens and state, in a sheet over
 * Settings. Cancel (on its first screen) or Escape closes it, back on All Notebooks; once the
 * notebook is set up it closes on the notebook's page.
 */
export function AddNotebook({
  git,
  onClose,
  onAdded,
}: {
  git: DesktopGit;
  onClose: () => void;
  /** Where a set-up notebook opens; the notebook's page in Settings unless given (the relay's). */
  onAdded?: (notebookId: string | null) => void;
}) {
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener('keydown', escape);
    return () => window.removeEventListener('keydown', escape);
  }, [onClose]);
  return (
    <div className="fr-sheet" role="dialog" aria-modal="true" aria-label="Add Notebook">
      <div className="first-run" data-testid="add-notebook" data-flow="add">
        <NotebookSteps
          git={git}
          firstRun={false}
          onCancel={onClose}
          onDone={(notebookId) => {
            if (onAdded) {
              onAdded(notebookId);
              return;
            }
            onClose();
            if (notebookId) navigate(gitNotebookPath(notebookId));
          }}
        />
      </div>
    </div>
  );
}

/**
 * The flow's screens, as a stack: each step goes on to the next, Back goes to the one before. On
 * the first run it starts at the welcome, and `onHold` keeps it on screen while a notebook is set
 * up, past the moment the list has it, until its first sync. From Settings (`firstRun` false) it
 * starts at Create or Open Notebook, whose Cancel is `onCancel`, and `onDone` ends it.
 */
function NotebookSteps({
  git,
  firstRun,
  onHold,
  onCancel,
  onDone,
}: {
  git: DesktopGit;
  /** The first run: the welcome, the welcome note, and the first notebook's words. */
  firstRun: boolean;
  onHold?: ((hold: boolean) => void) | undefined;
  onCancel?: (() => void) | undefined;
  onDone?: ((notebookId: string | null) => void) | undefined;
}) {
  const github = git.github;
  const [stack, setStack] = useState<readonly Screen[]>([
    firstRun ? { at: 'welcome' } : { at: 'goal' },
  ]);
  const [goal, setGoal] = useState<Goal>('new');
  const [way, setWay] = useState<Way>('create');
  const [hub, setHub] = useState<Hub | null>(null);
  const [reads, setReads] = useState<ReadonlyMap<string, RepoRead>>(() => new Map());
  /** The notebooks on this Mac already (none on the first run): shown Already Added. */
  const [added, setAdded] = useState<ReadonlySet<string>>(() => new Set());
  useEffect(() => {
    let live = true;
    void git
      .list()
      .then((list) => {
        if (live) setAdded(new Set(list.map((each) => each.notebookId)));
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [git]);
  const asked = useRef(new Set<string>());
  const screen = stack[stack.length - 1]!;
  /** The first run's step left, by name (PEN-137): Add Notebook's steps are not the first run's. */
  const left = (result: 'done' | 'back') => {
    if (firstRun) record('firstrun', screen.at, { result });
  };
  const go = (next: Screen) => {
    left('done');
    setStack((now) => [...now, next]);
  };
  const replace = (next: Screen) => {
    left('done');
    setStack((now) => [...now.slice(0, -1), next]);
  };
  const back = () => {
    left('back');
    setStack((now) => (now.length > 1 ? now.slice(0, -1) : now));
  };
  /** The notebook set up, once Setting Up is done (the consent question may follow it). */
  const setUp = useRef<{ readonly notebookId: string | null } | null>(null);
  const end = (notebookId: string | null) => {
    onHold?.(false);
    onDone?.(notebookId);
  };
  /**
   * Setting Up is done: on the first run, the consent question when this Mac has no answer yet
   * (PEN-137, O3), the app held back until it is answered; else the flow ends. Once only, though
   * the first sync may say it is done more than once.
   */
  const finish = (notebookId: string | null) => {
    if (setUp.current) return;
    setUp.current = { notebookId };
    // Describe notes for agents? once, on the first run of a Mac that can reach an AI and has
    // not been asked (A1656).
    const ai = firstRun ? desktop()?.ai : undefined;
    if (!ai) {
      void lastStep();
      return;
    }
    void ai
      .status()
      .catch(() => null)
      .then((status) => {
        if (status && !status.asked) go({ at: 'ai' });
        else void lastStep();
      });
  };
  /** The AI question is answered: this Mac is not asked again. */
  const answeredAi = () => {
    void desktop()
      ?.ai?.asked()
      .catch(() => null);
  };
  /** After AI Descriptions' question: the consent question when unanswered, else the app. */
  const lastStep = async () => {
    const analytics = firstRun ? analyticsBridge() : null;
    const status = analytics ? await analytics.status().catch(() => null) : null;
    if (status && status.consent === null) {
      go({ at: 'consent' });
      return;
    }
    left('done');
    end(setUp.current?.notebookId ?? null);
  };
  /** GitHub as the account the switcher shows (A1618), else as main finds it. */
  const account = hub?.account;
  const browse = useMemo(() => asAccount(github, account), [github, account]);
  /** A new account's repositories: their folders are read afresh. */
  const forgetReads = () => {
    asked.current.clear();
    setReads(new Map());
  };

  /** GitHub's step again, for `then`: as `account`, or Add Another Account (A1617). */
  const githubAgain = (
    then: 'create' | 'list',
    next: { keep?: { account: GitHubAccountChoice | undefined }; add?: boolean },
  ) => {
    forgetReads();
    setHub(null);
    replace({ at: 'github', then, ...next });
  };
  /** Whose repositories these are, as a control above them (option 2, 17 Nov 2026; A1617). */
  const switcher = (then: 'create' | 'list', shown: Hub) => (
    <AccountSwitcher
      github={github}
      hub={shown}
      {...(then === 'create' ? { line: 'Making the repository in this account' } : {})}
      onPick={(picked) => githubAgain(then, { keep: { account: picked } })}
      onAdd={() => githubAgain(then, { keep: { account: shown.account }, add: true })}
      onManage={() => go({ at: 'accounts', then })}
      onRefresh={() => githubAgain(then, { keep: { account: shown.account } })}
    />
  );

  /** One repository's folders, read once (again on Try Again or Refresh). */
  const read = useCallback(
    (repo: GitHubRepo, again = false) => {
      if (!again && asked.current.has(repo.fullName)) return;
      asked.current.add(repo.fullName);
      setReads((now) => new Map(now).set(repo.fullName, { state: 'loading' }));
      void browse
        .folders(repo.fullName, repo.defaultBranch || 'main')
        .catch(() => null)
        .then((answer) => {
          const loaded: RepoRead = !answer
            ? { state: 'failed', message: 'This window cannot browse GitHub.' }
            : !answer.ok
              ? { state: 'failed', message: answer.error.message }
              : { state: 'ready', folders: answer.value };
          setReads((now) => new Map(now).set(repo.fullName, loaded));
        });
    },
    [browse],
  );

  /** git.add, holding the first run while it works and after it adds (until the first sync). */
  const add: AddNotebook = async (input) => {
    onHold?.(true);
    // The account picked gives the notebook its token (A1617).
    const withAccount =
      input.githubSignIn && account !== undefined ? { ...input, githubAccount: account } : input;
    const result = await git.add(withAccount).catch(() => null);
    if (!(result?.ok && result.value.kind === 'added')) onHold?.(false);
    return result;
  };

  /** GitHub's sign-in first when the flow has none yet (2.x), then `then`. */
  const viaGitHub = (then: 'create' | 'list') => go(hub ? { at: then } : { at: 'github', then });

  let body: ReactNode;
  switch (screen.at) {
    case 'welcome':
      body = (
        <Frame
          name="welcome"
          centered
          above={
            <span className="fr-brand" aria-hidden="true">
              <BrandMark size={52} />
            </span>
          }
          title="Welcome to Penmoss"
          start={
            <a
              data-event="firstrun.welcome.learn-more"
              className="fr-learn"
              href={FIRST_RUN_DOCS}
              target="_blank"
              rel="noreferrer"
            >
              Learn More
            </a>
          }
          actions={
            <Action
              data-event="firstrun.welcome.get-started"
              primary
              testId="first-run-start"
              onClick={() => go({ at: 'goal' })}
            >
              Get Started
            </Action>
          }
        >
          <p className="fr-lead fr-welcome">
            Notes in a git repository you own. Three short steps and you’re writing.
          </p>
        </Frame>
      );
      break;
    case 'goal':
      body = (
        <Frame
          name="goal"
          step={1}
          title="Create or Open Notebook"
          back={firstRun ? back : undefined}
          cancel={onCancel}
          actions={
            <Action
              data-event="firstrun.continue"
              primary
              testId="first-run-continue"
              onClick={() => (goal === 'new' ? go({ at: 'way' }) : viaGitHub('list'))}
            >
              Continue
            </Action>
          }
        >
          <Options
            label="Create or open"
            value={goal}
            onChange={setGoal}
            items={[
              {
                value: 'new',
                title: 'Start a New Notebook',
                line: firstRun ? 'Your first Penmoss notebook' : 'A new, empty notebook',
                testId: 'first-run-new',
                event: 'firstrun.goal.start-a-new-notebook',
              },
              {
                value: 'existing',
                title: 'Open an Existing Notebook',
                line: 'From a repository with Penmoss notes',
                testId: 'first-run-existing',
                event: 'firstrun.goal.open-an-existing-notebook',
              },
            ]}
          />
        </Frame>
      );
      break;
    case 'way':
      body = (
        <Frame
          name="way"
          step={2}
          title="Pick Repository"
          back={back}
          actions={
            <Action
              data-event="firstrun.continue"
              primary
              testId="first-run-continue"
              onClick={() =>
                way === 'url' ? go({ at: 'url' }) : viaGitHub(way === 'create' ? 'create' : 'list')
              }
            >
              Continue
            </Action>
          }
        >
          <Options
            label="Repository"
            value={way}
            onChange={setWay}
            items={[
              {
                value: 'create',
                title: 'Create New Repo',
                line: 'On GitHub, private',
                chip: 'Recommended',
                testId: 'first-run-way-create',
                event: 'firstrun.way.create-new-repo',
              },
              {
                value: 'existing',
                title: 'Use Existing Repo',
                line: 'An empty one you made',
                testId: 'first-run-way-existing',
                event: 'firstrun.way.use-existing-repo',
              },
              {
                value: 'url',
                title: 'Paste a URL',
                line: hostWords().urlLine,
                testId: 'first-run-way-url',
                event: 'firstrun.way.paste-a-url',
              },
            ]}
          />
        </Frame>
      );
      break;
    case 'github':
      body = (
        <GitHubAccess
          github={github}
          {...(screen.keep ? { keep: screen.keep } : {})}
          add={screen.add === true}
          onReady={(answer) => {
            forgetReads();
            setHub(answer);
            replace({ at: screen.then });
          }}
          onUrl={() => replace({ at: 'url' })}
          back={back}
        />
      );
      break;
    case 'create':
      body = hub ? (
        <CreateRepo
          github={browse}
          hub={hub}
          switcher={switcher('create', hub)}
          onCreated={(place, name) => go({ at: 'setup', setup: { kind: 'create', place, name } })}
          onUseExisting={() => replace({ at: 'list' })}
          back={back}
        />
      ) : null;
      break;
    case 'list':
      body = hub ? (
        <RepoTree
          hub={hub}
          goal={goal}
          added={added}
          reads={reads}
          read={read}
          onRepo={(repo) => go({ at: 'repo', repo })}
          onOpen={(repo, folder) =>
            go({
              at: 'setup',
              setup: {
                kind: 'open',
                place: placeIn(repo, hub.via, folder.path),
                name: folder.notebook?.name ?? repo.name,
              },
            })
          }
          onUrl={() => go({ at: 'url' })}
          onCreate={goal === 'new' ? () => replace({ at: 'create' }) : null}
          onRefresh={() => githubAgain('list', { keep: { account: hub.account } })}
          switcher={switcher('list', hub)}
          back={back}
        />
      ) : null;
      break;
    case 'repo':
      body = hub ? (
        <RepoPicked
          repo={screen.repo}
          via={hub.via}
          added={added}
          loaded={reads.get(screen.repo.fullName)}
          read={read}
          onOpen={(place, name) => go({ at: 'setup', setup: { kind: 'open', place, name } })}
          onName={(place) => go({ at: 'name', place })}
          onFolder={() => go({ at: 'folder', repo: screen.repo })}
          onUrl={() => go({ at: 'url' })}
          back={back}
        />
      ) : null;
      break;
    case 'folder': {
      const loaded = reads.get(screen.repo.fullName);
      body =
        hub && loaded?.state === 'ready' ? (
          <FolderPick
            repo={screen.repo}
            via={hub.via}
            folders={loaded.folders}
            beside
            onName={(place) => go({ at: 'name', place })}
            back={back}
          />
        ) : null;
      break;
    }
    case 'url':
      body = (
        <PasteUrl
          add={add}
          onAdded={(setup) => go({ at: 'setup', setup })}
          onName={(place) => go({ at: 'name', place })}
          onGitMissing={() => go({ at: 'git-missing' })}
          back={back}
        />
      );
      break;
    case 'accounts': {
      // Back from the accounts: the same account's repositories, or the first's if it went (A1618).
      const leave = () => {
        const was = hub ? { keep: { account: hub.account } } : {};
        forgetReads();
        setHub(null);
        setStack((now) => [...now.slice(0, -2), { at: 'github', then: screen.then, ...was }]);
      };
      body = (
        <Frame name="accounts" step={2} title="GitHub Accounts" back={leave}>
          <GitHubSettings embedded />
        </Frame>
      );
      break;
    }
    case 'git-missing':
      body = <GitMissing back={back} />;
      break;
    case 'name':
      body = (
        <NameNotebook
          place={screen.place}
          onMake={(name) => go({ at: 'setup', setup: { kind: 'make', place: screen.place, name } })}
          back={back}
        />
      );
      break;
    case 'setup':
      body = (
        <SettingUp
          setup={screen.setup}
          add={add}
          welcomeNote={firstRun}
          onDone={(notebookId) => finish(notebookId)}
          onNeedsName={(place) => replace({ at: 'name', place })}
          back={back}
        />
      );
      break;
    case 'ai':
      body = (
        <AiQuestion
          back={back}
          onNext={(on) => {
            if (on) {
              go({ at: 'ai-provider' });
              return;
            }
            answeredAi();
            void lastStep();
          }}
        />
      );
      break;
    case 'ai-provider':
      body = (
        <AiProviderStep
          back={back}
          onDone={() => {
            answeredAi();
            void lastStep();
          }}
        />
      );
      break;
    case 'consent':
      body = (
        <Frame
          name="consent"
          last
          title={copy('consent.title')}
          actions={
            <ConsentAnswers
              onAnswer={() => {
                left('done');
                end(setUp.current?.notebookId ?? null);
              }}
            />
          }
        >
          <ConsentQuestion />
        </Frame>
      );
      break;
  }

  return (
    <div className="fr-steps" data-step={screen.at}>
      {/* A new step is a new screen: its own fields, and its title takes focus. */}
      <Fragment key={stack.length}>{body}</Fragment>
    </div>
  );
}

/** The capture window with no notebook: nowhere to capture to yet. */
function CaptureFirstRun() {
  return (
    <main className="app-shell first-run-plain" data-testid="first-run-capture">
      <p role="status">
        Add a git notebook in the Penmoss window first: captures go into your Primary Notebook.
      </p>
    </main>
  );
}
