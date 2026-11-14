/**
 * The first run (T59, A1030; T69, A1146; Ryan's review of #192, findings 2–4): with no git
 * notebook on this Mac the app has nothing to open, since git notebooks are the only kind (D48,
 * D49). Until one is added or made, the window shows this guide, one step per screen (First Run
 * C): a short welcome; Create or Open Notebook; Pick Repository (Create New Repo, Use Existing
 * Repo or Paste a URL), with GitHub's sign-in on the way when it is needed; Name Your Notebook
 * when a new one is made; then Setting Up, until the first sync. Every screen but the first and
 * the last has the "Step n of 3" bar and a footer with Back and its button. The app's views are
 * mounted only once a notebook is set up, so their root and Journal notebook are never missing.
 */
import { BrandMark } from '@penmoss/ui/icons';
import { Fragment, useCallback, useRef, useState, type ReactNode } from 'react';
import { desktop, type GitHubRepo } from '../desktop/bridge';
import {
  FIRST_RUN_DOCS,
  placeIn,
  type AddNotebook,
  type Goal,
  type Hub,
  type RepoRead,
  type Screen,
} from './first-run-flow';
import { Action, Frame } from './FirstRunFrame';
import { GitHubAccess } from './FirstRunGitHub';
import {
  CreateRepo,
  FolderPick,
  GitMissing,
  NameNotebook,
  PasteUrl,
  RepoPicked,
  RepoTree,
} from './FirstRunRepos';
import { SettingUp } from './FirstRunSetup';
import { useAllSources } from './hooks';
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
  /** A notebook is being set up (7.1): the first run stays until its first sync. */
  const [held, setHeld] = useState(false);
  // Without a registry (tests that render one source), there is nothing to wait for.
  if (!state) return children;
  if (isOpen(state) && !held) return children;
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

/** Radio choices drawn as wide rows (1.2, 1.3): one picked, Continue goes on with it. */
function Options<T extends string>({
  label,
  value,
  onChange,
  items,
}: {
  label: string;
  value: T;
  onChange: (value: T) => void;
  items: ReadonlyArray<{
    readonly value: T;
    readonly title: string;
    readonly line: string;
    readonly chip?: string;
    readonly testId: string;
  }>;
}) {
  return (
    <div className="fr-options" role="radiogroup" aria-label={label}>
      {items.map((item) => (
        <label key={item.value} className="fr-option" data-testid={item.testId}>
          <input
            type="radio"
            name={label}
            value={item.value}
            checked={value === item.value}
            onChange={() => onChange(item.value)}
          />
          <span className="fr-option-text">
            <strong>{item.title}</strong>
            <span>{item.line}</span>
          </span>
          {item.chip ? <span className="chip">{item.chip}</span> : null}
        </label>
      ))}
    </div>
  );
}

type Way = 'create' | 'existing' | 'url';

/**
 * The first run's screens, as a stack: each step goes on to the next, Back goes to the one before.
 * `onHold` keeps the first run on screen while a notebook is set up, past the moment the list has
 * it, until its first sync.
 */
export function FirstRun({ onHold }: { onHold?: (hold: boolean) => void }) {
  const git = desktop()?.git ?? null;
  const github = git?.github;
  const [stack, setStack] = useState<readonly Screen[]>([{ at: 'welcome' }]);
  const [goal, setGoal] = useState<Goal>('new');
  const [way, setWay] = useState<Way>('create');
  const [hub, setHub] = useState<Hub | null>(null);
  const [reads, setReads] = useState<ReadonlyMap<string, RepoRead>>(() => new Map());
  const asked = useRef(new Set<string>());
  const screen = stack[stack.length - 1]!;
  const go = (next: Screen) => setStack((now) => [...now, next]);
  const replace = (next: Screen) => setStack((now) => [...now.slice(0, -1), next]);
  const back = () => setStack((now) => (now.length > 1 ? now.slice(0, -1) : now));

  /** One repository's folders, read once (again on Try Again or Refresh). */
  const read = useCallback(
    (repo: GitHubRepo, again = false) => {
      if (!github || (!again && asked.current.has(repo.fullName))) return;
      asked.current.add(repo.fullName);
      setReads((now) => new Map(now).set(repo.fullName, { state: 'loading' }));
      void github
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
    [github],
  );

  /** git.add, holding the first run while it works and after it adds (until the first sync). */
  const add: AddNotebook = async (input) => {
    if (!git) return null;
    onHold?.(true);
    const result = await git.add(input).catch(() => null);
    if (!(result?.ok && result.value.kind === 'added')) onHold?.(false);
    return result;
  };

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

  /** GitHub's sign-in first when the flow has none yet (2.x), then `then`. */
  const viaGitHub = (then: 'create' | 'list') =>
    go(github ? (hub ? { at: then } : { at: 'github', then }) : { at: 'url' });

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
            <a className="fr-learn" href={FIRST_RUN_DOCS} target="_blank" rel="noreferrer">
              Learn More
            </a>
          }
          actions={
            <Action primary testId="first-run-start" onClick={() => go({ at: 'goal' })}>
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
          back={back}
          actions={
            <Action
              primary
              testId="first-run-continue"
              onClick={() =>
                goal === 'new' ? go(github ? { at: 'way' } : { at: 'url' }) : viaGitHub('list')
              }
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
                line: 'Your first Penmoss notebook',
                testId: 'first-run-new',
              },
              {
                value: 'existing',
                title: 'Open an Existing Notebook',
                line: 'From a repository with Penmoss notes',
                testId: 'first-run-existing',
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
              },
              {
                value: 'existing',
                title: 'Use Existing Repo',
                line: 'An empty one you made',
                testId: 'first-run-way-existing',
              },
              {
                value: 'url',
                title: 'Paste a URL',
                line: 'Anywhere this Mac’s git can push to',
                testId: 'first-run-way-url',
              },
            ]}
          />
        </Frame>
      );
      break;
    case 'github':
      body = github ? (
        <GitHubAccess
          github={github}
          onReady={(answer) => {
            setHub(answer);
            replace({ at: screen.then });
          }}
          onUrl={() => replace({ at: 'url' })}
          back={back}
        />
      ) : null;
      break;
    case 'create':
      body =
        github && hub ? (
          <CreateRepo
            github={github}
            hub={hub}
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
          onRefresh={() => {
            asked.current.clear();
            setReads(new Map());
            setHub(null);
            replace({ at: 'github', then: 'list' });
          }}
          back={back}
        />
      ) : null;
      break;
    case 'repo':
      body = hub ? (
        <RepoPicked
          repo={screen.repo}
          via={hub.via}
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
          onDone={() => onHold?.(false)}
          onNeedsName={(place) => replace({ at: 'name', place })}
          back={back}
        />
      );
      break;
  }

  return (
    <main className="first-run" data-testid="first-run" data-step={screen.at}>
      {/* A new step is a new screen: its own fields, and its title takes focus. */}
      <Fragment key={stack.length}>{body}</Fragment>
    </main>
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
