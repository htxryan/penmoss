import { Icon } from '@penmoss/ui/icons';
import { DialogClose } from '../shell/DialogClose';
import { Select } from '@penmoss/ui/controls/Select';
import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import { useNoteList } from '../notes/hooks';
import { snippetParts } from '../notes/backlinks';
import { displayTitle } from '../notes/list';
import { useSourcesState } from '../sources/hooks';
import { useWorkspaceState } from '../workspace/hooks';
import {
  APP_SEARCH_MODE,
  NO_FILTERS,
  type SearchFilters,
  type SearchHit,
  type SearchOutcome,
} from './service';
import type { Searcher } from './sources';
import {
  folderGroups,
  folderOptions,
  notebookTags,
  tagOptions,
  type FilterNotebook,
} from './filter-options';
import type { Source } from '../sources/registry';

/** This device's words answer each keystroke at once (A111); Enter answers without waiting. */
const TYPING_MS = 60;
/**
 * Meaning's hybrid answer replaces the words after a pause in typing, or on Enter (A1156): the
 * Mac's embedding service embeds the query (100–300 ms, T76), so not on every keystroke.
 */
const PAUSE_MS = 500;
const DAY_MS = 86_400_000;

const DATE_RANGES: ReadonlyArray<{ readonly label: string; readonly days: number | null }> = [
  { label: 'Any Time', days: null },
  { label: 'Past Day', days: 1 },
  { label: 'Past Week', days: 7 },
  { label: 'Past Month', days: 30 },
  { label: 'Past Year', days: 365 },
];

const NO_SOURCES: readonly Source[] = [];

/** A grouped folder's option value: its notebook and its id, so two notebooks' never meet. */
const groupedValue = (notebookId: string, folderId: string) =>
  JSON.stringify([notebookId, folderId]);

/**
 * Every open notebook's folders and tags, read again when any notebook's notes or folders
 * change, so a folder made while the dialog is open shows (PEN-71).
 */
function useFilterNotebooks(sources: readonly Source[]): FilterNotebook[] {
  const [revision, bump] = useReducer((count: number) => count + 1, 0);
  useEffect(() => {
    const offs = sources.flatMap((source) => [
      source.notes.subscribe(bump),
      source.workspace.subscribe(bump),
    ]);
    return () => {
      for (const off of offs) off();
    };
  }, [sources]);
  return useMemo(
    () =>
      sources.map((source) => ({
        id: source.id,
        name: source.name,
        folders: source.workspace.getState().snapshot.folders,
        tags: source.notes.list().map((note) => note.tags),
      })),
    // `revision` reads the notebooks again when one changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [sources, revision],
  );
}
function Marked({ text }: { text: string }) {
  return (
    <>
      {snippetParts(text).map((part, index) =>
        part.match ? <mark key={index}>{part.text}</mark> : <span key={index}>{part.text}</span>,
      )}
    </>
  );
}

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });

export interface SearchOverlayProps {
  /** One source's search, or every source's (T50, A826). */
  readonly service: Searcher;
  readonly onOpenNote: (id: string, heading: string | null) => void;
  readonly onClose: () => void;
}

/**
 * Search across every note (T22, T23): one search with folder, tag and date filters (T42, A571:
 * no type picker). Each notebook's full-text index on this device answers as the user types
 * (A111). A WAI-ARIA combobox like the palette: the input keeps focus, ↑/↓ move through results,
 * Enter opens one, Esc closes.
 */
export function SearchOverlay({ service, onOpenNote, onClose }: SearchOverlayProps) {
  const list = useNoteList();
  const workspace = useWorkspaceState();
  const [query, setQuery] = useState('');
  const mode = APP_SEARCH_MODE;
  const [filters, setFilters] = useState<SearchFilters>(NO_FILTERS);
  const [range, setRange] = useState(0);
  /**
   * The latest answer, with the request it answers (searching while that is not the current
   * one); `final` once it has answered it.
   */
  const [answer, setAnswer] = useState<{
    key: string;
    outcome: SearchOutcome;
    final: boolean;
  } | null>(null);
  /** The request Enter asked to be answered now (A111). */
  const [submitted, setSubmitted] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const answeredKey = useRef<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const results = useRef<HTMLDivElement>(null);
  const id = useId();

  // With several notebooks, a Notebook filter first (Quanta feedback 3, item 2; A1127). Under
  // All Notebooks, Folder lists every notebook's folders grouped by notebook and Tag every
  // notebook's tags; with one chosen, that notebook's (PEN-71, A1290).
  const sourcesState = useSourcesState();
  const sources = useMemo(() => sourcesState?.all ?? NO_SOURCES, [sourcesState]);
  const several = sources.length > 1;
  const notebooks = useFilterNotebooks(several ? sources : NO_SOURCES);
  const notebook = notebooks.find((each) => each.id === filters.notebookId) ?? null;
  const grouped = several && !notebook;
  const folderRecords = notebook ? notebook.folders : workspace.snapshot.folders;
  const folders = useMemo(() => folderOptions(folderRecords), [folderRecords]);
  const groups = useMemo(() => (grouped ? folderGroups(notebooks) : []), [grouped, notebooks]);
  const ownTags = useMemo(() => tagOptions(list.map((note) => note.tags)), [list]);
  /** Tag's list with this notebook chosen (null: All Notebooks). */
  const tagsFor = (notebookId: string | null): string[] => {
    if (!several) return ownTags;
    const chosen = notebooks.find((each) => each.id === notebookId);
    return notebookTags(chosen ? [chosen] : notebooks);
  };
  const tags = useMemo(
    () => (several ? notebookTags(notebook ? [notebook] : notebooks) : ownTags),
    [several, notebook, notebooks, ownTags],
  );
  /** Notebook changed: Folder to All Folders (or the folder picked), Tag to Any Tag if gone. */
  const chooseNotebook = (notebookId: string | null, folderId: string | null = null) => {
    const tag = filters.tag && tagsFor(notebookId).includes(filters.tag) ? filters.tag : null;
    setFilters({ ...filters, notebookId, folderId, tag });
  };

  // Notes changed: the index catches up before its next search.
  useEffect(() => service.invalidate(), [service, list]);
  // Warm the index while the user types.
  useEffect(() => {
    service.refresh().catch((error: unknown) => {
      console.warn('[search] could not read this device’s notes', error);
    });
  }, [service]);

  const requestKey = JSON.stringify([query, mode, filters]);
  useEffect(() => {
    if (!query.trim()) return;
    const controller = new AbortController();
    const request = { input: query, mode, filters, submitted: submitted === requestKey };
    let final = false;
    const show = (outcome: SearchOutcome, done: boolean) => {
      if (controller.signal.aborted || final) return;
      final = done;
      setAnswer({ key: requestKey, outcome, final: done });
      // A later answer to the same request keeps the active result where the user moved it.
      if (answeredKey.current !== requestKey) setActive(0);
      answeredKey.current = requestKey;
    };
    const fail = (error: unknown) => {
      if (controller.signal.aborted) return;
      console.warn('[search] search failed', error);
      show({ source: 'device', hits: [], notice: 'Search failed. Try again.' }, true);
    };
    // While typing, the words at once: the answer itself without meaning, otherwise a preview.
    const typing = setTimeout(
      () => {
        service
          .typing(request)
          .then((outcome) => {
            if (outcome) show(outcome, !outcome.preview);
          })
          .catch(fail);
      },
      request.submitted ? 0 : TYPING_MS,
    );
    // On a pause, or at once after Enter: the hybrid answer, which replaces the preview.
    const pause = setTimeout(
      () => {
        if (final) return;
        service
          .search(request)
          .then((outcome) => show(outcome, true))
          .catch(fail);
      },
      request.submitted ? 0 : PAUSE_MS,
    );
    return () => {
      clearTimeout(typing);
      clearTimeout(pause);
      controller.abort();
    };
  }, [service, query, mode, filters, requestKey, submitted]);

  useLayoutEffect(() => {
    input.current?.focus();
  }, []);

  const outcome = query.trim() ? (answer?.outcome ?? null) : null;
  const answered = answer?.key === requestKey;
  const searching = Boolean(query.trim()) && !(answered && answer.final);
  const hits = useMemo(() => outcome?.hits ?? [], [outcome]);
  const current = Math.min(active, Math.max(0, hits.length - 1));

  useLayoutEffect(() => {
    results.current
      ?.querySelector<HTMLElement>(`[data-index="${current}"]`)
      ?.scrollIntoView?.({ block: 'nearest' });
  }, [current, hits]);

  const choose = (hit: SearchHit | undefined) => {
    if (hit) onOpenNote(hit.id, hit.heading);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    const count = Math.max(1, hits.length);
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        setActive((current + 1) % count);
        break;
      case 'ArrowUp':
        event.preventDefault();
        setActive((current - 1 + count) % count);
        break;
      case 'Enter':
        event.preventDefault();
        // Answered: Enter opens; before the answer, it asks for one at once.
        if (answered && answer.final) {
          choose(hits[current]);
        } else if (query.trim()) {
          setSubmitted(requestKey);
        }
        break;
      case 'Escape':
        event.preventDefault();
        event.stopPropagation();
        onClose();
        break;
    }
  };

  const option = (index: number) => `${id}-result-${index}`;
  const status = !query.trim()
    ? 'Type to search every note.'
    : searching && !outcome
      ? 'Searching…'
      : outcome
        ? `${hits.length === 0 ? 'No results' : `${hits.length} ${hits.length === 1 ? 'result' : 'results'}`}${
            outcome.preview ? '' : ' on this device'
          }`
        : '';

  return (
    <div
      className="overlay"
      data-testid="search"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="dialog palette search" role="dialog" aria-modal="true" aria-label="Search">
        <div className="dlg-search">
          <span className="search-icon" aria-hidden="true">
            <Icon name="search" />
          </span>
          <input
            ref={input}
            type="search"
            role="combobox"
            aria-expanded="true"
            aria-controls={`${id}-results`}
            aria-autocomplete="list"
            aria-activedescendant={hits.length > 0 ? option(current) : undefined}
            aria-label="Search notes"
            placeholder="Search notes…  “phrase”  prefix*"
            autoComplete="off"
            spellCheck={false}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onKeyDown}
          />
          <DialogClose label="Close Search" onClose={onClose} />
        </div>
        <div className="search-controls">
          {sources.length > 1 ? (
            <div className="search-filter">
              <Select
                size="small"
                aria-label="Notebook"
                data-testid="search-notebook"
                value={filters.notebookId ?? ''}
                onChange={(event) => chooseNotebook(event.target.value || null)}
              >
                <option value="">All Notebooks</option>
                {sources.map((source) => (
                  <option key={source.id} value={source.id}>
                    {source.name}
                  </option>
                ))}
              </Select>
            </div>
          ) : null}
          <div className="search-filter">
            <Select
              size="small"
              aria-label="Folder"
              data-testid="search-folder"
              value={filters.folderId ?? ''}
              onChange={(event) => {
                const value = event.target.value;
                if (grouped && value) {
                  // A folder from a notebook's group: Notebook switches to its notebook.
                  const [notebookId, folderId] = JSON.parse(value) as [string, string];
                  chooseNotebook(notebookId, folderId);
                } else {
                  setFilters({ ...filters, folderId: value || null });
                }
              }}
            >
              <option value="">All Folders</option>
              {grouped
                ? groups.map((group) => (
                    <optgroup key={group.notebookId} label={group.name}>
                      {group.folders.map((folder) => (
                        <option key={folder.id} value={groupedValue(group.notebookId, folder.id)}>
                          {folder.label}
                        </option>
                      ))}
                    </optgroup>
                  ))
                : folders.map((folder) => (
                    <option key={folder.id} value={folder.id}>
                      {folder.label}
                    </option>
                  ))}
            </Select>
          </div>
          <div className="search-filter">
            <Select
              size="small"
              aria-label="Tag"
              value={filters.tag ?? ''}
              onChange={(event) => setFilters({ ...filters, tag: event.target.value || null })}
            >
              <option value="">Any Tag</option>
              {tags.map((tag) => (
                <option key={tag} value={tag}>
                  #{tag}
                </option>
              ))}
            </Select>
          </div>
          <div className="search-filter">
            <Select
              size="small"
              aria-label="Updated"
              value={range}
              onChange={(event) => {
                const index = Number(event.target.value);
                setRange(index);
                const days = DATE_RANGES[index]?.days ?? null;
                setFilters({
                  ...filters,
                  updatedAfter: days === null ? null : Date.now() - days * DAY_MS,
                });
              }}
            >
              {DATE_RANGES.map((each, index) => (
                <option key={each.label} value={index}>
                  {each.label}
                </option>
              ))}
            </Select>
          </div>
        </div>
        <div className="search-status" role="status" data-testid="search-status">
          {searching ? (
            <span className="spinner" aria-hidden="true" data-testid="search-spinner" />
          ) : null}
          <span>{status}</span>
          {outcome?.notice ? (
            <span className="search-notice" data-testid="search-notice">
              {outcome.notice}
            </span>
          ) : null}
          {outcome?.wordsOnly && !outcome.notice ? (
            <span
              className="search-words-only"
              data-testid="search-words-only"
              data-tip={outcome.wordsOnly}
            >
              Words only
              <span className="sr-only">. {outcome.wordsOnly}</span>
            </span>
          ) : null}
        </div>
        <div
          ref={results}
          className="dlg-list search-results"
          id={`${id}-results`}
          role="listbox"
          aria-label="Search results"
          aria-busy={searching}
        >
          {hits.map((hit, index) => (
            <div
              key={hit.id}
              id={option(index)}
              role="option"
              className="opt search-hit"
              aria-selected={index === current}
              data-index={index}
              data-sources={hit.sources.join(' ')}
              data-note-id={hit.id}
              onMouseMove={() => {
                if (index !== current) setActive(index);
              }}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => choose(hit)}
            >
              <span className="search-hit-title">
                {hit.titleHighlighted ? (
                  <Marked text={hit.titleHighlighted} />
                ) : (
                  displayTitle(hit.title)
                )}
              </span>
              <span className="search-hit-meta">
                {hit.notebook ? (
                  <span className="search-notebook" data-testid="search-hit-notebook">
                    {hit.notebook}
                  </span>
                ) : null}
                {hit.heading ? <span className="search-heading">› {hit.heading}</span> : null}
                {hit.tags.map((tag) => (
                  <span key={tag} className="tag-mini">
                    #{tag}
                  </span>
                ))}
                {hit.updatedAt > 0 ? (
                  <time dateTime={new Date(hit.updatedAt).toISOString()}>
                    {dateFormat.format(hit.updatedAt)}
                  </time>
                ) : null}
                {/* Found by meaning alone (A1156): its words are not in the note. */}
                {hit.sources.includes('semantic') && !hit.sources.includes('full-text') ? (
                  <span className="search-source" title="Found by meaning">
                    ≈
                  </span>
                ) : null}
              </span>
              {hit.snippet ? (
                <span className="search-snippet">
                  <Marked text={hit.snippet} />
                </span>
              ) : null}
            </div>
          ))}
        </div>
        {/* The list's empty state, as the palette's (T39 pass 2); the status line counts. */}
        {query.trim() && outcome && !searching && hits.length === 0 ? (
          <p className="dlg-empty" data-testid="search-empty">
            No notes match “{query.trim()}”
          </p>
        ) : null}
        <div className="dlg-foot" aria-hidden="true">
          <span className="keys">
            <kbd>↑</kbd>
            <kbd>↓</kbd>
          </span>
          Navigate
          <span className="keys">
            <kbd>↵</kbd>
          </span>
          Open
          <span className="grow" />
          <span className="keys">
            <kbd>Esc</kbd>
          </span>
          Close
        </div>
      </div>
    </div>
  );
}
