import { aiProviderOf } from '@penmoss/core/ai-description';
import type { TagChange } from '@penmoss/model/tags';
import { Icon } from '@penmoss/ui/icons';
import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { windowDescriber } from '../notes/describer';
import { useNoteList } from '../notes/hooks';
import { SourceScope } from '../sources/context';
import { useAppWorkspace, useSource, useSourcesState } from '../sources/hooks';
import { showToast } from '../toasts/toasts';
import type { Source } from '../sources/registry';
import type { Workspace } from '../workspace/service';
import { useWorkspace, useWorkspaceState } from '../workspace/hooks';
import { filterKey, mergeChanges, notesText, rowMatches, tagList, tagRows } from './manage';
import { ChooseAiProviderDialog, GenerateTagsDialog } from './GenerateTagsDialog';
import { DeleteDialog, MergeDialog } from './TagDialogs';
import { useTagChanges } from './tag-changes';
import { TagDoneToast, type TagDone } from './TagDoneToast';
import { counted } from '@penmoss/core/words';
import { Checkbox, TagRowView } from './TagRow';

/** What choosing a tag's name does: what choosing it in the sidebar does, in its notebook. */
export type ShowTag = (sourceId: string | null, tag: string) => void;

/**
 * The Tags page (PEN-68, `/tags`; finding 8 of Ryan's review of #192, design "Tags D"): one
 * compact table per notebook, a tag (with its note count) on the left and what it means on the
 * right, narrowed by the filter at the top. A description saves as it is typed, into the
 * notebook's WorkspaceDoc, so it syncs and agents read it (`describe_tags`), and its row says
 * Saving…, Saved or Not saved. It is where tags are managed too: rename in place, merge, delete,
 * from a row's ⋯ or, for the selected tags, the buttons above the table; each acts on that
 * notebook's notes only, and its toast offers Undo. Choosing a tag's name opens Search on it.
 * A row's ⋯ also has Generate AI Description, and the page Generate All… (A1677): the tag
 * prompt, with the tag's notes and the other tags on them, sent to the AI provider.
 */
export function TagsPage({ onShowTag }: { readonly onShowTag: ShowTag }) {
  const sources = useSourcesState().all;
  const anyTags = useAnyTags(sources);
  const [query, setQuery] = useState('');
  const [done, setDone] = useState<TagDone | null>(null);
  const closeDone = useCallback(() => setDone(null), []);
  const [generating, setGenerating] = useState(false);
  const [noProvider, setNoProvider] = useState(false);
  const app = useAppWorkspace();
  // The provider is this device's setting: re-read when the app's settings change.
  useSyncExternalStore(app.subscribe, app.getState, app.getState);
  const provider = aiProviderOf(app.settings());
  const section = (source: Source) => (
    <NotebookTags
      name={source.name}
      sourceId={source.id}
      query={query}
      onShowTag={onShowTag}
      onDone={setDone}
      provider={provider !== 'none'}
      onNoProvider={() => setNoProvider(true)}
    />
  );
  return (
    <section className="tags-page" aria-labelledby="tags-page-heading" data-testid="tags-page">
      <div className="tags-page-top" data-testid="tags-page-top">
        <h2 id="tags-page-heading">Tags</h2>
        {anyTags === false ? null : (
          <div className="tags-page-tools">
            <label className="tags-filter tags-page-filter">
              <Icon name="search" size={14} />
              <input
                className="input"
                type="search"
                aria-label="Filter Tags"
                placeholder="Filter tags"
                value={query}
                data-testid="tags-filter"
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Escape' && query) {
                    event.preventDefault();
                    setQuery('');
                  }
                }}
              />
            </label>
            <button
              type="button"
              className="btn tags-generate-all"
              data-ui="item"
              data-event="tags.generate-all"
              data-testid="tags-generate-all"
              onClick={() => (provider === 'none' ? setNoProvider(true) : setGenerating(true))}
            >
              <Icon name="sparkle" size={14} />
              Generate All…
            </button>
          </div>
        )}
      </div>
      <div className="tags-page-scroll" data-testid="tags-page-scroll">
        {anyTags === false ? (
          <div className="empty-state compact" data-testid="tags-page-empty">
            <span className="empty-icon" aria-hidden="true">
              <Icon name="hash" size={28} />
            </span>
            <h3>No tags yet</h3>
            <p>Tag a note, with #name in its text or under its title, and the tag shows here.</p>
          </div>
        ) : (
          sources.map((source) => (
            <SourceScope key={source.id} source={source}>
              {section(source)}
            </SourceScope>
          ))
        )}
      </div>
      <TagDoneToast done={done} onClose={closeDone} />
      {generating ? (
        <GenerateTagsDialog sources={sources} onClose={() => setGenerating(false)} />
      ) : null}
      {noProvider ? <ChooseAiProviderDialog onClose={() => setNoProvider(false)} /> : null}
    </section>
  );
}

const NEVER = () => () => undefined;

/** A description written or cleared (A1677): the toast says so, and Undo puts back `before`. */
function describedDone(workspace: Workspace, tag: string, text: string, before: string): TagDone {
  return {
    text,
    undone: `The description of #${tag} is as it was.`,
    undo: async () => {
      workspace.setTagDescription(tag, before);
      await workspace.flush().catch(() => undefined);
      return 0;
    },
  };
}

/** Whether any notebook has a tag. */
function useAnyTags(sources: readonly Source[]): boolean {
  const subscribe = useMemo(
    () => (listener: () => void) => {
      const offs = sources.map((source) => source.notes.subscribe(listener));
      return () => {
        for (const off of offs) off();
      };
    },
    [sources],
  );
  const read = () => sources.some((source) => source.notes.list().some((n) => n.tags.length > 0));
  return useSyncExternalStore(subscribe, read, read);
}

type Sort = { readonly by: 'tag' | 'notes'; readonly up: boolean };

/** One notebook's tags (the notebook in context): its table, selection and actions. */
function NotebookTags({
  name,
  sourceId,
  query,
  onShowTag,
  onDone,
  provider,
  onNoProvider,
}: {
  /** The notebook's name, as its section's heading. */
  readonly name: string;
  readonly sourceId: string;
  readonly query: string;
  readonly onShowTag: ShowTag;
  readonly onDone: (done: TagDone) => void;
  /** This device has an AI provider (Settings → AI Descriptions). */
  readonly provider: boolean;
  /** Generate AI Description without one: where to choose one. */
  readonly onNoProvider: () => void;
}) {
  const workspace = useWorkspace();
  const source = useSource();
  const describer = windowDescriber();
  // Which tags are being generated, as the describer says.
  const busyKey = () => describer?.tagsBusyIn(sourceId).join(' ') ?? '';
  useSyncExternalStore(describer?.subscribe ?? NEVER, busyKey, busyKey);
  const list = useNoteList();
  const noteTags = useMemo(() => list.map((entry) => entry.tags), [list]);
  const rows = useMemo(() => tagRows(noteTags), [noteTags]);
  const stored = useWorkspaceState().snapshot.tagDescriptions;
  const descriptions = useMemo(() => stored ?? {}, [stored]);
  const [sort, setSort] = useState<Sort>({ by: 'tag', up: true });
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [renaming, setRenaming] = useState<string | null>(null);
  const [merging, setMerging] = useState<{
    readonly sources: readonly string[];
    readonly target: string | null;
  } | null>(null);
  const [deleting, setDeleting] = useState<readonly string[] | null>(null);
  const sectionRef = useRef<HTMLElement>(null);
  const headRef = useRef<HTMLDivElement>(null);
  useStickyHeadHeight(sectionRef, headRef);

  const key = filterKey(query);
  const shown = useMemo(() => {
    const matching = rows.filter((row) => rowMatches(row, descriptions[row.tag] ?? '', key));
    if (sort.by === 'notes') matching.sort((a, b) => b.count - a.count);
    if (!sort.up) matching.reverse();
    return matching;
  }, [rows, descriptions, key, sort]);
  // The selection, in the table's order, without tags that are gone.
  const picked = rows.filter((row) => selected.has(row.tag)).map((row) => row.tag);
  const allShown = shown.length > 0 && shown.every((row) => selected.has(row.tag));
  const someShown = shown.some((row) => selected.has(row.tag));

  const toggle = (tag: string, on: boolean) =>
    setSelected((current) => {
      const next = new Set(current);
      if (on) next.add(tag);
      else next.delete(tag);
      return next;
    });

  /**
   * Makes `changes` in this notebook's notes and moves the descriptions with them; the toast
   * says `text` and offers Undo, which puts back the notes and the descriptions.
   */
  const change = useTagChanges();
  const run = async (changes: readonly TagChange[], text: (notes: number) => string) => {
    onDone(await change(changes, text));
    // The tags it changed leave the selection; a merge's target too, as the selection was its.
    const touched = new Set(changes.flatMap((each) => [each.from, each.to ?? each.from]));
    setSelected((current) => new Set([...current].filter((tag) => !touched.has(tag))));
  };

  const rename = async (from: string, to: string, nested: boolean) => {
    await run([{ from, to, nested }], (n) => `Renamed #${from} to #${to} in ${notesText(n)}.`);
    setRenaming(null);
  };

  const merge = async (sources: readonly string[], target: string) => {
    const merged = sources.filter((source) => source !== target);
    await run(mergeChanges(sources, target), (n) =>
      merged.length > 3
        ? `Merged ${merged.length} tags into #${target} in ${notesText(n)}.`
        : `Merged ${tagList(merged)} into #${target} in ${notesText(n)}.`,
    );
    setMerging(null);
  };

  const remove = async (tags: readonly string[]) => {
    await run(
      tags.map((from) => ({ from, to: null })),
      (n) =>
        tags.length > 3
          ? `Deleted ${tags.length} tags from ${notesText(n)}.`
          : `Deleted ${tagList(tags)} from ${notesText(n)}.`,
    );
    setDeleting(null);
  };

  /**
   * Generate AI Description (A1677): the answer replaces the description, and the toast's Undo
   * puts back what it said.
   */
  const generate = async (tag: string) => {
    if (!provider || !describer || !source) {
      onNoProvider();
      return;
    }
    const answer = await describer.describeTag(source, tag);
    if (answer.ok) {
      onDone(describedDone(workspace, tag, `Wrote a description of #${tag}.`, answer.before));
    } else if (answer.code === 'no-provider') {
      onNoProvider();
    } else {
      showToast({
        text: `Couldn’t generate a description of #${tag}: ${answer.message}`,
        tone: 'error',
        testId: 'tags-generate-error',
      });
    }
  };

  const clear = (tag: string) => {
    const before = descriptions[tag] ?? '';
    workspace.setTagDescription(tag, '');
    void workspace.flush().catch(() => undefined);
    onDone(describedDone(workspace, tag, `Cleared the description of #${tag}.`, before));
  };

  const headingId = `tags-page-${sourceId}`;
  const count = `${key ? `${shown.length} of ` : ''}${counted(rows.length, 'Tag')}`;
  return (
    <section
      ref={sectionRef}
      className="tags-page-notebook"
      aria-labelledby={name ? headingId : undefined}
      aria-label={name ? undefined : 'Tags'}
      data-testid="tags-page-notebook"
    >
      <div ref={headRef} className="tags-page-notebook-head">
        {name ? (
          <h3 id={headingId} className="tags-page-notebook-name">
            <Icon name="notebook" size={16} />
            {name}
          </h3>
        ) : null}
        <span className="muted tags-page-count" data-testid="tags-count">
          {count}
        </span>
        {picked.length > 0 ? (
          <div className="tags-page-actions" role="group" aria-label="Selected Tags">
            <span className="tags-page-selected">{picked.length} Selected</span>
            {picked.length === 1 ? (
              <button
                type="button"
                className="btn"
                data-ui="item"
                data-event="tags.selected.rename"
                onClick={() => setRenaming(picked[0]!)}
              >
                <Icon name="pencil" size={14} />
                Rename…
              </button>
            ) : null}
            <button
              type="button"
              className="btn"
              data-ui="item"
              data-event="tags.selected.merge"
              onClick={() => setMerging({ sources: picked, target: null })}
            >
              <Icon name="branch" size={14} />
              Merge…
            </button>
            <button
              type="button"
              className="btn danger"
              data-ui="item"
              data-event="tags.selected.delete"
              onClick={() => setDeleting(picked)}
            >
              <Icon name="trash" size={14} />
              Delete…
            </button>
            <button
              type="button"
              className="icon-btn"
              data-ui="item"
              data-event="tags.selected.clear"
              aria-label="Clear Selection"
              data-tip="Clear Selection"
              onClick={() => setSelected(new Set())}
            >
              <Icon name="close" size={14} />
            </button>
          </div>
        ) : null}
      </div>
      {rows.length === 0 ? (
        <p className="muted tags-page-none" data-testid="tags-page-none">
          No tags in this notebook yet.
        </p>
      ) : shown.length === 0 ? (
        <p className="muted tags-page-none" data-testid="tags-page-none">
          No tag matches “{query.trim()}”.
        </p>
      ) : (
        <div className="tags-table" role="table" aria-label={name ? `Tags in ${name}` : 'Tags'}>
          <div className="tags-row tags-head" role="row">
            <span role="columnheader">
              <Checkbox
                label="Select All"
                data-event="tags.select-all"
                checked={allShown}
                mixed={!allShown && someShown}
                onChange={(on) =>
                  setSelected((current) => {
                    const next = new Set(current);
                    for (const row of shown) {
                      if (on) next.add(row.tag);
                      else next.delete(row.tag);
                    }
                    return next;
                  })
                }
              />
            </span>
            <SortHeader
              label="Tag"
              by="tag"
              data-event="tags.sort.tag"
              sort={sort}
              onSort={setSort}
            />
            <SortHeader
              label="Notes"
              by="notes"
              data-event="tags.sort.notes"
              sort={sort}
              onSort={setSort}
            />
            <span role="columnheader">Description</span>
            <span role="columnheader">
              <span className="sr-only">Actions</span>
            </span>
          </div>
          {shown.map((row) => (
            <TagRowView
              key={row.tag}
              row={row}
              rows={rows}
              noteTags={noteTags}
              filter={key}
              description={descriptions[row.tag] ?? ''}
              workspace={workspace}
              selected={selected.has(row.tag)}
              renaming={renaming === row.tag}
              onSelect={(on) => toggle(row.tag, on)}
              onShow={() => onShowTag(sourceId, row.tag)}
              onStartRename={() => setRenaming(row.tag)}
              onCancelRename={() => setRenaming(null)}
              onRename={rename}
              onMergeInto={(target) => {
                setRenaming(null);
                setMerging({ sources: [row.tag], target });
              }}
              onDelete={() => setDeleting([row.tag])}
              generating={describer?.tagBusy(sourceId, row.tag) ?? false}
              onGenerate={() => void generate(row.tag)}
              onClear={() => clear(row.tag)}
            />
          ))}
        </div>
      )}
      {merging ? (
        <MergeDialog
          sources={merging.sources}
          initialTarget={merging.target}
          rows={rows}
          notes={noteTags}
          descriptions={descriptions}
          onMerge={merge}
          onCancel={() => setMerging(null)}
        />
      ) : null}
      {deleting ? (
        <DeleteDialog
          tags={deleting}
          rows={rows}
          notes={noteTags}
          onDelete={() => remove(deleting)}
          onCancel={() => setDeleting(null)}
        />
      ) : null}
    </section>
  );
}

/** A checkbox with an accessible name, and its mixed state set on the element. */
/**
 * The notebook's heading row's height, as `--tags-head-h` on its section (R2-4): the table's
 * header row sticks just under it while the rows scroll, and the heading wraps in a narrow window
 * or when the selection's buttons show.
 */
function useStickyHeadHeight(
  sectionRef: { readonly current: HTMLElement | null },
  headRef: { readonly current: HTMLElement | null },
): void {
  useLayoutEffect(() => {
    const section = sectionRef.current;
    const head = headRef.current;
    if (!section || !head) return;
    const set = () => section.style.setProperty('--tags-head-h', `${head.offsetHeight}px`);
    set();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(set);
    observer.observe(head);
    return () => observer.disconnect();
  }, [sectionRef, headRef]);
}

/** A column heading that sorts by it; a second press reverses the order. */
function SortHeader({
  label,
  by,
  sort,
  onSort,
  'data-event': tracked,
}: {
  readonly label: string;
  readonly by: Sort['by'];
  readonly sort: Sort;
  readonly onSort: (sort: Sort) => void;
  /** Its tracked id (PEN-137). */
  readonly 'data-event'?: string;
}) {
  const on = sort.by === by;
  return (
    <span
      role="columnheader"
      aria-sort={on ? (sort.up ? 'ascending' : 'descending') : undefined}
      className={by === 'notes' ? 'tags-count-cell' : undefined}
    >
      <button
        type="button"
        className="tags-sort"
        data-ui="item"
        data-event={tracked ?? 'tags.sort'}
        onClick={() => onSort({ by, up: on ? !sort.up : true })}
      >
        {label}
        {on ? <Icon name={sort.up ? 'chevU' : 'chevD'} size={12} /> : null}
      </button>
    </span>
  );
}
