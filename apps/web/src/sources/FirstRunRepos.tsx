/**
 * The first run's repository screens (First Run C; Ryan's review of #192, findings 3 and 4):
 * Create New Repo (3.x), Use Existing Repo as a two-level tree of repositories and the notebooks
 * in them (Notebook List A, 4.1–4.4), one repository picked (4.5 empty, 4.6 one notebook, 4.7
 * several, 4.8 other files: Pick Folder), Paste a URL (5.x), Penmoss Needs Git (2.8) and Name
 * Your Notebook (6.x). Each asks one thing; the flow (FirstRun.tsx) says where each goes next.
 * Each screen has its own file beside this one (FirstRunCreateRepo.tsx, FirstRunRepoPicked.tsx,
 * FirstRunFolderPick.tsx, FirstRunPasteUrl.tsx, FirstRunGitMissing.tsx, FirstRunNameNotebook.tsx,
 * and FirstRunAccountSwitcher.tsx for the account menu they share); this one is Use Existing
 * Repo's tree.
 */
import { Icon } from '@penmoss/ui/icons';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { fuzzyMatch, highlightRuns } from '@penmoss/core/fuzzy';
import type { GitHubRepo, RepoFolder } from '../desktop/bridge';
import { notebooksIn, readKey, type Goal, type Hub, type RepoRead } from './first-run-flow';
import { Action, Frame, LinkButton, Location } from './FirstRunFrame';
import { pushedWords } from './repo-words';
import { counted } from '@penmoss/core/words';
import { hostWords } from './host-words';

/** Text with what the filter matched marked (4.3). */
function Marked({ text, query }: { text: string; query: string }) {
  const match = query ? fuzzyMatch(query, text, { scattered: false }) : null;
  if (!match || match.indices.length === 0) return text;
  return highlightRuns(text, match.indices).map((run, index) =>
    run.match ? <mark key={index}>{run.text}</mark> : run.text,
  );
}

/** How many repositories the tree reads at once, as they come near the list's view. */
const READ_AT_ONCE = 3;

/** Whether this window can tell which rows are near the view; without it, every row is near. */
const seeing = typeof IntersectionObserver !== 'undefined';

/** Whether `row` shows, even in part, in `box` (the tree's visible box). */
const inView = (row: Element, box: DOMRect) => {
  const at = row.getBoundingClientRect();
  return at.bottom > box.top && at.top < box.bottom;
};

/**
 * Use Existing Repo (4.1–4.4): each repository with the notebooks in it beneath (Notebook List A).
 * A repository is read as it comes near the list's view, a few at a time, and opens by itself
 * when it holds a notebook; one with none (empty, or read and found none) stays closed until it
 * is opened (Ryan's review of #193). A notebook opens; a repository goes on to what it holds.
 */
export function RepoTree({
  hub,
  goal,
  added,
  reads,
  read,
  onRepo,
  onOpen,
  onUrl,
  onCreate,
  onRefresh,
  back,
  switcher,
}: {
  hub: Hub;
  goal: Goal;
  /** Notebook ids already on this Mac (Add Notebook, A1562): shown Already Added, not opened. */
  added: ReadonlySet<string>;
  reads: ReadonlyMap<string, RepoRead>;
  read: (repo: GitHubRepo) => void;
  onRepo: (repo: GitHubRepo) => void;
  onOpen: (repo: GitHubRepo, folder: RepoFolder) => void;
  onUrl: () => void;
  onCreate: (() => void) | null;
  onRefresh: () => void;
  back: () => void;
  /** Whose repositories these are, and another account's (A1617); else a line with Refresh. */
  switcher?: ReactNode;
}) {
  const repos = useMemo(() => {
    const all = [...hub.list.repos];
    // A new notebook wants an empty repository: those first (B7).
    if (goal === 'new') all.sort((a, b) => Number(b.empty) - Number(a.empty));
    return all;
  }, [hub, goal]);
  /** Opened or closed by hand: the tree never changes these itself. */
  const [toggled, setToggled] = useState<ReadonlyMap<string, boolean>>(() => new Map());
  /** Opened by the tree, once read and found to hold a notebook. */
  const [found, setFound] = useState<ReadonlySet<string>>(() => new Set());
  /** The repositories in or near the list's view: the ones to read. */
  const [near, setNear] = useState<ReadonlySet<string>>(() => new Set());
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [tree, setTree] = useState<HTMLUListElement | null>(null);
  const watch = useRef<IntersectionObserver | null>(null);
  const pointerIn = useRef(false);
  /** Bumped when a row held closed may open now: the pointer left the list, or it scrolled. */
  const [retry, setRetry] = useState(0);
  /**
   * The list's height when a filter was first typed: the list keeps at least that while filtered,
   * so the centred card doesn't shrink and move as matches go (Ryan's review of #193).
   */
  const [floor, setFloor] = useState<number | null>(null);
  const filter = (next: string) => {
    if (!next.trim()) setFloor(null);
    else if (!query.trim() && tree) setFloor(tree.getBoundingClientRect().height);
    setQuery(next);
  };

  // Which rows are in or near the view. Those up to a list's height above or below it count, so
  // most are read, and open, before they scroll in.
  useEffect(() => {
    if (!tree || !seeing) return;
    const observer = new IntersectionObserver(
      (entries) =>
        setNear((now) => {
          const next = new Set(now);
          for (const entry of entries) {
            const name = (entry.target as HTMLElement).dataset['repo'];
            if (!name) continue;
            if (entry.isIntersecting) next.add(name);
            else next.delete(name);
          }
          return next.size === now.size && [...next].every((name) => now.has(name)) ? now : next;
        }),
      { root: tree, rootMargin: '100% 0px' },
    );
    watch.current = observer;
    for (const row of tree.children) observer.observe(row);
    return () => {
      observer.disconnect();
      watch.current = null;
    };
  }, [tree, repos]);
  /** Each row, watched while it is in the list. */
  const watchRow = useCallback((row: HTMLLIElement) => {
    watch.current?.observe(row);
    return () => watch.current?.unobserve(row);
  }, []);

  const q = query.trim();
  const shown = useMemo(() => {
    return repos.flatMap((repo) => {
      const loaded = reads.get(readKey(repo));
      const notebooks = loaded?.state === 'ready' ? notebooksIn(loaded.folders) : [];
      if (!q) return [{ repo, notebooks }];
      const repoMatch = fuzzyMatch(q, repo.fullName, { scattered: false }) !== null;
      const matching = notebooks.filter(
        (each) => fuzzyMatch(q, each.notebook.name, { scattered: false }) !== null,
      );
      if (!repoMatch && matching.length === 0) return [];
      return [{ repo, notebooks: repoMatch ? notebooks : matching }];
    });
  }, [repos, reads, q]);

  // Read what is near the view, a few at a time, in the list's order.
  useEffect(() => {
    let reading = [...reads.values()].filter((each) => each.state === 'loading').length;
    for (const { repo } of shown) {
      if (reading >= READ_AT_ONCE) break;
      const isNear = !seeing || near.has(repo.fullName);
      if (!isNear || !repo.canPush || repo.empty || reads.has(readKey(repo))) continue;
      read(repo);
      reading += 1;
    }
  }, [shown, near, reads, read]);

  /** Read and found to hold a notebook, but not yet opened by the tree. */
  const waiting = useMemo(
    () =>
      repos
        .filter((repo) => {
          const loaded = reads.get(readKey(repo));
          return (
            !found.has(repo.fullName) &&
            loaded?.state === 'ready' &&
            notebooksIn(loaded.folders).length > 0
          );
        })
        .map((repo) => repo.fullName),
    [repos, reads, found],
  );
  // Each opens as it is found, except a row in view while the pointer is over the list: opening it
  // would move the rows under the pointer, so it waits until the pointer leaves or it scrolls out
  // of view. A row above the view opens at once, since the browser keeps what is in view in place.
  useEffect(() => {
    if (waiting.length === 0) return;
    const box = pointerIn.current && tree ? tree.getBoundingClientRect() : null;
    const rows = new Map<string | undefined, Element>();
    for (const row of tree?.children ?? []) rows.set((row as HTMLElement).dataset['repo'], row);
    const now = waiting.filter((name) => {
      const row = rows.get(name);
      return !box || !row || !inView(row, box);
    });
    if (now.length > 0) setFound((was) => new Set([...was, ...now]));
  }, [waiting, tree, retry]);
  const tryHeld = () => {
    if (waiting.length > 0) setRetry((now) => now + 1);
  };

  const isAdded = (folder: RepoFolder) => folder.notebook !== null && added.has(folder.notebook.id);
  const firstNotebook = shown
    .flatMap(({ repo, notebooks }) => notebooks.map((folder) => ({ repo, folder })))
    .find(({ folder }) => !isAdded(folder));
  const chosen =
    selected ??
    (firstNotebook ? `${firstNotebook.repo.fullName}\n${firstNotebook.folder.path}` : null);

  const signedInLine = (
    <p className="fr-lead fr-small" data-testid="first-run-via">
      {hub.login
        ? `Signed in as ${hub.login}`
        : hub.via === 'git'
          ? hostWords().signedInThrough
          : 'Signed in to GitHub'}
      {' · '}
      <LinkButton data-event="firstrun.list.refresh" testId="first-run-refresh" onClick={onRefresh}>
        Refresh
      </LinkButton>
    </p>
  );
  // Whose repositories these are, and another account's, above the list (A1617).
  const accountLines = switcher ?? signedInLine;

  // 4.4: nothing to pick.
  if (repos.length === 0) {
    return (
      <Frame
        name="list"
        state="none"
        step={2}
        title="Pick Repository"
        back={back}
        actions={
          <>
            <Action
              data-event="firstrun.list.paste-a-url-instead"
              testId="first-run-url-instead"
              onClick={onUrl}
            >
              Paste a URL Instead
            </Action>
            {onCreate ? (
              <Action
                data-event="firstrun.list.create-new-repo"
                primary
                testId="first-run-create-instead"
                onClick={onCreate}
              >
                Create New Repo
              </Action>
            ) : null}
          </>
        }
      >
        <p className="fr-empty" data-testid="first-run-no-repos">
          GitHub lists no repository{hub.login ? ` for ${hub.login}` : ' for this sign-in'}.
        </p>
        {accountLines}
      </Frame>
    );
  }

  /** Open when opened by hand, or, unless closed by hand, once found to hold a notebook. */
  const isOpen = (name: string) => toggled.get(name) ?? found.has(name);
  const toggle = (repo: GitHubRepo) => {
    const opening = !isOpen(repo.fullName);
    setToggled((now) => new Map(now).set(repo.fullName, opening));
    if (opening && !repo.empty && !reads.has(readKey(repo))) read(repo);
  };

  return (
    <Frame name="list" state="ready" step={2} title="Pick Repository" back={back}>
      {accountLines}
      <label className="fr-filter">
        <span className="sr-only">Filter</span>
        <Icon name="search" size={14} />
        <input
          type="search"
          className="input"
          placeholder="Filter repositories and notebooks"
          value={query}
          data-testid="first-run-filter"
          onChange={(event) => filter(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape' && query) {
              event.preventDefault();
              event.stopPropagation();
              filter('');
            }
          }}
        />
      </label>
      {/* Always there, so the list never moves when the filter is typed in (Ryan's review of #193).
          A live region speaks only when its words change: as the filter is typed or cleared. */}
      <p className="fr-lead fr-small fr-count" role="status" data-testid="first-run-filter-count">
        {q
          ? `${shown.length} of ${repos.length} match.`
          : `${counted(repos.length, 'repository', 'repositories')}.`}
      </p>
      <ul
        ref={setTree}
        className="fr-tree"
        style={floor === null ? undefined : { minHeight: floor }}
        aria-label="Repositories and notebooks"
        data-testid="first-run-tree"
        onPointerEnter={() => {
          pointerIn.current = true;
        }}
        onPointerLeave={() => {
          pointerIn.current = false;
          tryHeld();
        }}
        onScroll={tryHeld}
      >
        {shown.map(({ repo, notebooks }) => {
          // A filter shows what matched inside, opened or not.
          const expanded = isOpen(repo.fullName) || (q !== '' && notebooks.length > 0);
          const loaded = reads.get(readKey(repo));
          return (
            <li
              key={repo.fullName}
              ref={watchRow}
              data-testid="first-run-tree-repo"
              data-repo={repo.fullName}
            >
              <div className="fr-tree-repo">
                <button
                  type="button"
                  className="fr-tree-toggle"
                  data-ui="item"
                  aria-expanded={expanded}
                  aria-label={`${expanded ? 'Hide' : 'Show'} what ${repo.fullName} holds`}
                  disabled={!repo.canPush}
                  data-testid="first-run-repo-toggle"
                  data-event="firstrun.repo.toggle"
                  onClick={() => toggle(repo)}
                >
                  <Icon name={expanded ? 'chevD' : 'chevR'} size={14} />
                </button>
                <button
                  type="button"
                  className="fr-tree-name"
                  data-ui="item"
                  disabled={!repo.canPush}
                  title={repo.canPush ? undefined : 'You can’t push to this repository'}
                  data-testid="first-run-repo-pick"
                  data-event="firstrun.repo"
                  onClick={() => onRepo(repo)}
                >
                  <span className="muted">
                    <Marked text={`${repo.owner}/`} query={q} />
                  </span>
                  <strong>
                    <Marked text={repo.name} query={q} />
                  </strong>
                </button>
                {repo.empty ? <span className="chip fr-chip">Empty</span> : null}
                {repo.visibility !== 'private' ? (
                  <span className="chip fr-chip">
                    {repo.visibility === 'public' ? 'Public' : 'Internal'}
                  </span>
                ) : null}
                {repo.canPush ? null : <span className="chip fr-chip">Read Only</span>}
                <span className="fr-when">{pushedWords(repo.pushedAt)}</span>
              </div>
              {expanded ? (
                <ul className="fr-tree-in">
                  {repo.empty || (loaded?.state === 'ready' && notebooks.length === 0) ? (
                    <li className="fr-tree-none" data-testid="first-run-no-notebook">
                      <span>No notebook yet</span>
                      <LinkButton
                        data-event="firstrun.list.start-one-here"
                        testId="first-run-start-here"
                        onClick={() => onRepo(repo)}
                      >
                        Start One Here
                      </LinkButton>
                    </li>
                  ) : loaded?.state === 'failed' ? (
                    <li className="fr-tree-none">
                      <span>Couldn’t read it: {loaded.message}</span>
                    </li>
                  ) : loaded?.state !== 'ready' ? (
                    <li className="fr-tree-none">
                      <span className="fr-spin" aria-hidden="true" />
                      <span>Looking for notebooks…</span>
                    </li>
                  ) : (
                    notebooks.map((folder) => {
                      const key = `${repo.fullName}\n${folder.path}`;
                      const here = isAdded(folder);
                      const isChosen = chosen === key && !here;
                      return (
                        <li
                          key={key}
                          className={isChosen ? 'fr-tree-notebook on' : 'fr-tree-notebook'}
                          data-testid="first-run-notebook"
                          data-repo={repo.fullName}
                          data-dir={folder.path}
                          aria-disabled={here || undefined}
                          onClick={here ? undefined : () => setSelected(key)}
                        >
                          <Icon name="notebook" size={16} />
                          <strong>
                            <Marked text={folder.notebook.name} query={q} />
                          </strong>
                          <Location dir={folder.path} />
                          {here ? (
                            <span className="chip fr-chip" data-testid="first-run-already-added">
                              Already Added
                            </span>
                          ) : (
                            <Action
                              data-event="firstrun.list.open"
                              primary={isChosen}
                              testId="first-run-notebook-open"
                              onClick={() => onOpen(repo, folder)}
                            >
                              Open
                            </Action>
                          )}
                        </li>
                      );
                    })
                  )}
                </ul>
              ) : null}
            </li>
          );
        })}
      </ul>
      {hub.list.more ? (
        <p className="fr-lead fr-small">
          Showing the 300 most recently pushed. Paste a URL for others.
        </p>
      ) : null}
      <LinkButton
        data-event="firstrun.list.paste-a-url-instead"
        testId="first-run-url-instead"
        onClick={onUrl}
      >
        Paste a URL Instead
      </LinkButton>
    </Frame>
  );
}
