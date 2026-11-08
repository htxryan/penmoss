import { Icon } from '@penmoss/ui/icons';
import { DialogClose } from '../shell/DialogClose';
import { tagTree, type TagNode } from '@penmoss/core/tags';
import { buildTree, type FolderNode } from '@penmoss/core/workspace';
import { Select } from '@penmoss/ui/controls/Select';
import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
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

/** Folders in tree order, each with its depth, for the folder filter. */
function folderOptions(
  folders: readonly FolderNode[],
  depth = 0,
): Array<{ id: string; label: string }> {
  return folders.flatMap((folder) => [
    { id: folder.id, label: `${' '.repeat(depth)}${folder.name}` },
    ...folderOptions(folder.folders, depth + 1),
  ]);
}

function tagOptions(nodes: readonly TagNode[]): string[] {
  return nodes.flatMap((node) => [node.tag, ...tagOptions(node.children)]);
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

  // With several notebooks, a Notebook filter first (Quanta feedback 3, item 2; A1127): the
  // folders are then that notebook's.
  const sources = useSourcesState()?.all ?? [];
  const notebook = sources.find((source) => source.id === filters.notebookId) ?? null;
  const folderRecords = notebook
    ? notebook.workspace.getState().snapshot.folders
    : workspace.snapshot.folders;
  const folders = useMemo(
    () => folderOptions(buildTree(folderRecords, []).folders),
    [folderRecords],
  );
  const tags = useMemo(() => tagOptions(tagTree(list.map((note) => note.tags))), [list]);

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
                onChange={(event) =>
                  setFilters({ ...filters, notebookId: event.target.value || null, folderId: null })
                }
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
              value={filters.folderId ?? ''}
              onChange={(event) => setFilters({ ...filters, folderId: event.target.value || null })}
            >
              <option value="">All Folders</option>
              {folders.map((folder) => (
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
