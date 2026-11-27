/**
 * The first run's Pick Folder screen (4.8; FirstRunRepos.tsx has the others): a tree with a
 * filter that marks the folders holding a notebook, Android's Pick Folder (A1620) on the Mac and
 * on a relay, which show this one screen (A1703). Its logic is `folder-tree.ts`.
 */
import { Icon } from '@penmoss/ui/icons';
import { useId, useMemo, useState } from 'react';
import { useTypedLength } from '../analytics/typed';
import type { GitHubRepo, GitHubVia, RepoFolders } from '../desktop/bridge';
import { ConfirmDialog } from '../shell/ConfirmDialog';
import { folderWords, placeIn, type Place } from './first-run-flow';
import { Action, Filter, Frame, LinkButton, Marked, Problem } from './FirstRunFrame';
import {
  ancestors,
  folderFilter,
  folderTreeShape,
  nameOf,
  openAtFirst,
  parents,
  treeRows,
  type FolderNotebook,
} from './folder-tree';
import { folderNameProblem } from './repo-words';

/**
 * Pick Folder (4.8; A1620, A1703), drawn as Android draws it. Under the lead, Filter Folders and
 * one square Collapse All / Expand All button, and Notebooks (N) when a folder holds one; then
 * the tree, which scrolls on its own: guide lines for each level (the chosen folder's own line in
 * the accent), a chevron where a folder holds folders, its icon and name, how many it holds while
 * closed, and a tick on the chosen one. A filter keeps each match and the folders above it, and
 * marks the match. A folder holding a notebook shows it, Already Added or Open, and isn't a place
 * for another. Above the footer, Notebook Goes In names the folder, with New Folder….
 */
export function FolderPick({
  repo,
  via,
  folders,
  beside = false,
  branch,
  added = new Set<string>(),
  onOpen,
  lead,
  onName,
  back,
}: {
  repo: GitHubRepo;
  via: GitHubVia;
  folders: RepoFolders;
  /** Another notebook beside the ones the repository holds (4.7's Start Another). */
  beside?: boolean;
  /** The branch these folders are on (Pick Branch, A1621). */
  branch: string;
  /** Notebook ids already added here: their folders say Already Added, not Open. */
  added?: ReadonlySet<string>;
  /** Opens a notebook a folder holds; without it, the folder only shows its notebook. */
  onOpen?: ((place: Place, name: string) => void) | undefined;
  /** The line under the title, when the screen before says why the folders are here. */
  lead?: string;
  onName: (place: Place) => void;
  back: () => void;
}) {
  const id = useId();
  const [made, setMade] = useState<readonly string[]>([]);
  const shape = useMemo(() => folderTreeShape(folders, made), [folders, made]);
  const [chosen, setChosen] = useState<string>(() =>
    shape.free.includes('') ? '' : (shape.free[0] ?? ''),
  );
  const [open, setOpen] = useState<ReadonlySet<string>>(() => openAtFirst(shape));
  const [query, setQuery] = useState('');
  const [onlyNotebooks, setOnlyNotebooks] = useState(false);
  const [making, setMaking] = useState(false);
  const { matches, shown } = folderFilter(shape, query, onlyNotebooks);
  const rows = treeRows(shape, open, shown);
  // The chosen folder and the folders above it: their icons and guide lines in the accent.
  const line = new Set(chosen ? [...ancestors(chosen), chosen] : []);
  const anyOpen = open.size > 0;
  const toggle = (path: string) =>
    setOpen((now) => {
      const next = new Set(now);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  return (
    <Frame
      name="folder"
      state="pick"
      step={2}
      title="Pick Folder"
      back={back}
      strip={
        <>
          <span className="fr-strip-text">
            <span className="fr-strip-label">Notebook Goes In</span>
            <code data-testid="first-run-folder-chosen">
              {chosen ? `${chosen}/` : `Root (${repo.fullName})`}
            </code>
          </span>
          <LinkButton
            data-event="firstrun.folder.new-folder"
            testId="first-run-new-folder-open"
            onClick={() => setMaking(true)}
          >
            <Icon name="folderPlus" size={14} />
            New Folder…
          </LinkButton>
        </>
      }
      actions={
        <Action
          data-event="firstrun.continue"
          primary
          disabled={!shape.free.includes(chosen)}
          testId="first-run-continue"
          onClick={() => onName(placeIn(repo, via, chosen, branch))}
        >
          Continue
        </Action>
      }
    >
      <p className="fr-lead">
        {lead ??
          (beside
            ? 'Pick where the new notebook goes.'
            : `${repo.fullName} holds other files. Pick where the notebook goes.`)}
      </p>
      <span className="fr-row">
        <span className="fr-grow">
          <Filter
            label="Filter Folders"
            placeholder="Filter Folders"
            value={query}
            onChange={setQuery}
            testId="first-run-folder-filter"
            clear={{ event: 'firstrun.folder.clear-filter', testId: 'first-run-folder-clear' }}
          />
        </span>
        <button
          type="button"
          className="btn fr-square"
          data-ui="item"
          data-event="firstrun.folder.expand-all"
          data-testid="first-run-folder-all"
          aria-label={anyOpen ? 'Collapse All' : 'Expand All'}
          title={anyOpen ? 'Collapse All' : 'Expand All'}
          disabled={shown !== null}
          onClick={() => setOpen(anyOpen ? new Set() : parents(shape))}
        >
          <Icon name={anyOpen ? 'chevsTogether' : 'chevsApart'} size={16} />
        </button>
      </span>
      {shape.notebooks.size > 0 ? (
        <span>
          <button
            type="button"
            className="chip fr-toggle-chip"
            data-ui="item"
            data-event="firstrun.folder.only-notebooks"
            data-testid="first-run-folder-notebooks"
            aria-pressed={onlyNotebooks}
            onClick={() => setOnlyNotebooks((now) => !now)}
          >
            <Icon name="notebook" size={12} />
            Notebooks ({shape.notebooks.size})
          </button>
        </span>
      ) : null}
      <div
        className="fr-ftree"
        role="radiogroup"
        aria-label={`Folders in ${repo.fullName}`}
        data-testid="first-run-folder-tree"
      >
        {shown === null && shape.free.includes('') ? (
          <label
            className="fr-frow fr-frow-root"
            data-testid="first-run-folder-option"
            data-path=""
          >
            <input
              type="radio"
              name={`${id}-folder`}
              checked={chosen === ''}
              data-event="firstrun.folder"
              onChange={() => setChosen('')}
            />
            <Icon name="folder" size={16} />
            <strong>Root</strong>
            <span className="fr-grow muted fr-ellipsis">Top of the repository</span>
            {chosen === '' ? <Icon name="check" size={16} /> : null}
          </label>
        ) : null}
        {rows.map(({ path, depth }) => {
          const kids = shape.children.get(path)?.length ?? 0;
          const expanded = kids === 0 ? null : shown !== null || open.has(path);
          const notebook = shape.notebooks.get(path);
          return (
            <FolderRow
              key={path}
              radio={`${id}-folder`}
              path={path}
              guides={Array.from({ length: depth }, () => line.has(path))}
              chosen={chosen === path}
              onLine={line.has(path)}
              dim={query.trim() !== '' && !matches.has(path)}
              count={expanded === false ? kids : null}
              notebook={notebook}
              alreadyAdded={notebook !== undefined && added.has(notebook.id)}
              made={made.includes(path)}
              expanded={expanded}
              query={query.trim()}
              onOpen={
                notebook && !added.has(notebook.id) && onOpen
                  ? () => onOpen(placeIn(repo, via, path, branch), notebook.name)
                  : undefined
              }
              onToggle={() => {
                if (shown === null) toggle(path);
              }}
              onChoose={() => setChosen(path)}
            />
          );
        })}
        {shown !== null && rows.length === 0 ? (
          <div className="fr-ftree-none" data-testid="first-run-folder-none">
            <strong>
              {onlyNotebooks ? 'No Notebooks Here' : `No Folder Matches “${query.trim()}”`}
            </strong>
            <p className="fr-lead fr-small">
              Folders starting with a dot, and folders inside a notebook, aren’t listed.
            </p>
          </div>
        ) : null}
        {folders.truncated ? (
          <p className="fr-lead fr-small fr-ftree-note">
            GitHub left some folders out of a large repository. Paste a URL with the folder for one
            not listed.
          </p>
        ) : null}
      </div>
      {making ? (
        <NewFolderDialog
          inside={chosen}
          onCancel={() => setMaking(false)}
          onMake={(name) => {
            const path = chosen ? `${chosen}/${name}` : name;
            setMade((now) => (now.includes(path) ? now : [...now, path]));
            setOpen((now) => new Set([...now, ...ancestors(path), ...(chosen ? [chosen] : [])]));
            setChosen(path);
            setQuery('');
            setOnlyNotebooks(false);
            setMaking(false);
          }}
        />
      ) : null}
    </Frame>
  );
}

/**
 * One folder in the tree: a guide line for each level above (the accent on the chosen folder's
 * own line), a chevron when it holds folders, then its icon, name, count while closed and a tick
 * when chosen. A folder holding a notebook has the notebook's icon and name instead, and Open.
 */
function FolderRow({
  radio,
  path,
  guides,
  chosen,
  onLine,
  dim,
  count,
  notebook,
  alreadyAdded,
  made,
  expanded,
  query,
  onOpen,
  onToggle,
  onChoose,
}: {
  radio: string;
  path: string;
  guides: readonly boolean[];
  chosen: boolean;
  onLine: boolean;
  dim: boolean;
  count: number | null;
  notebook: FolderNotebook | undefined;
  alreadyAdded: boolean;
  made: boolean;
  expanded: boolean | null;
  query: string;
  onOpen: (() => void) | undefined;
  onToggle: () => void;
  onChoose: () => void;
}) {
  const name = nameOf(path);
  const text = (
    <>
      <Icon name={notebook ? 'notebook' : 'folder'} size={16} />
      <span className="fr-grow fr-frow-text">
        <span className="fr-ellipsis">
          <Marked text={name} query={query} />
        </span>
        {notebook ? (
          <span className="fr-frow-notebook" data-testid="first-run-folder-notebook-chip">
            {alreadyAdded
              ? `Notebook: ${notebook.name} · Already Added`
              : `Notebook: ${notebook.name}`}
          </span>
        ) : made ? (
          <span className="muted">New, made at the first sync</span>
        ) : null}
      </span>
      {count !== null ? <span className="fr-frow-count">{count}</span> : null}
    </>
  );
  return (
    <div
      className="fr-frow-line"
      data-on-line={onLine || undefined}
      data-dim={dim || undefined}
      data-chosen={chosen || undefined}
    >
      {guides.map((lit, level) => (
        <span key={level} className="fr-guide" data-lit={lit || undefined} aria-hidden="true" />
      ))}
      {expanded === null ? (
        <span className="fr-twisty" aria-hidden="true" />
      ) : (
        <button
          type="button"
          className="fr-twisty"
          data-ui="item"
          data-event="firstrun.folder.toggle"
          data-testid="first-run-folder-toggle"
          aria-expanded={expanded}
          aria-label={expanded ? `Collapse ${name}` : `Expand ${name}`}
          onClick={onToggle}
        >
          <Icon name={expanded ? 'chevD' : 'chevR'} size={14} />
        </button>
      )}
      {notebook ? (
        <div
          className="fr-frow fr-frow-held"
          data-testid="first-run-folder-notebook"
          data-path={path}
        >
          {text}
          {onOpen ? (
            <Action
              data-event="firstrun.folder.open"
              icon="folder"
              testId="first-run-folder-open"
              onClick={onOpen}
            >
              Open
            </Action>
          ) : null}
        </div>
      ) : (
        <label className="fr-frow" data-testid="first-run-folder-option" data-path={path}>
          <input
            type="radio"
            name={radio}
            checked={chosen}
            data-event="firstrun.folder"
            onChange={onChoose}
          />
          {text}
          {chosen ? <Icon name="check" size={16} /> : null}
        </label>
      )}
    </div>
  );
}

/** New Folder…: its name, made inside the chosen folder at the first sync. */
function NewFolderDialog({
  inside,
  onCancel,
  onMake,
}: {
  inside: string;
  onCancel: () => void;
  onMake: (name: string) => void;
}) {
  const [name, setName] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const typed = useTypedLength('newFolder', 'name', name);
  return (
    <ConfirmDialog
      title={`New Folder in ${folderWords(inside)}`}
      testId="first-run-new-folder-dialog"
      dialog="newFolder"
      onCancel={onCancel}
      onSubmit={() => {
        const words = folderNameProblem(name);
        if (words) setProblem(words);
        else onMake(name.trim());
      }}
    >
      <label className="settings-field">
        <span>Folder Name</span>
        <input
          {...typed}
          className="input"
          spellCheck={false}
          autoFocus
          value={name}
          data-testid="first-run-new-folder"
          onChange={(event) => {
            setName(event.target.value);
            setProblem(null);
          }}
        />
      </label>
      {problem ? <Problem testId="first-run-new-folder-problem">{problem}</Problem> : null}
      <p className="fr-lead fr-small">Made at the first sync.</p>
      <div className="confirm-actions">
        <button
          type="button"
          className="btn"
          data-ui="dismiss"
          data-event="firstrun.folder.cancel"
          data-testid="first-run-new-folder-cancel"
          onClick={onCancel}
        >
          Cancel
        </button>
        <button
          type="submit"
          className="btn primary"
          data-ui="submit"
          data-event="firstrun.folder.add-folder"
          data-testid="first-run-new-folder-add"
        >
          <Icon name="folderPlus" size={14} />
          Add Folder
        </button>
      </div>
    </ConfirmDialog>
  );
}
