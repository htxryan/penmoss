import { tagTree, TAG_DESCRIPTION_MAX, type TagNode } from '@penmoss/core/tags';
import { Icon } from '@penmoss/ui/icons';
import { useMemo, useState, useSyncExternalStore } from 'react';
import { SourceScope } from '../sources/context';
import { useSourcesState } from '../sources/hooks';
import type { Source } from '../sources/registry';
import { useOpenNoteList } from '../workspace/notebooks';
import { useWorkspace, useWorkspaceState } from '../workspace/hooks';

/** What choosing a tag's name does: what choosing it in the sidebar does, in its notebook. */
export type ShowTag = (sourceId: string | null, tag: string) => void;

const NO_SOURCES = (): (() => void) => () => undefined;

/**
 * The Tags page (PEN-68, `/tags`): every tag as a tree, nested tags under their parent, each with
 * its note count and a description that saves as it is typed, into the notebook's WorkspaceDoc,
 * so it syncs with the notebook and agents read it (`describe_tags`). One section per notebook, in
 * the sidebar's order, when there are several. Choosing a tag's name shows its notes in the
 * sidebar, as choosing it there does.
 */
export function TagsPage({ onShowTag }: { readonly onShowTag: ShowTag }) {
  const state = useSourcesState();
  const sources = state?.all ?? null;
  const anyTags = useAnyTags(sources);
  return (
    <section className="tags-page" aria-labelledby="tags-page-heading" data-testid="tags-page">
      <h2 id="tags-page-heading">Tags</h2>
      <p className="muted tags-page-lede">
        Say what each tag means. Each notebook keeps its tags’ descriptions and syncs them, and
        agents read them to choose and understand tags.
      </p>
      {anyTags === false ? (
        <div className="empty-state compact" data-testid="tags-page-empty">
          <span className="empty-icon" aria-hidden="true">
            <Icon name="hash" size={28} />
          </span>
          <h3>No tags yet</h3>
          <p>Tag a note, with #name in its text or under its title, and the tag shows here.</p>
        </div>
      ) : sources === null ? (
        <NotebookTags name={null} sourceId={null} onShowTag={onShowTag} />
      ) : (
        sources.map((source) => (
          <SourceScope key={source.id} source={source}>
            <NotebookTags
              name={sources.length > 1 ? source.name : null}
              sourceId={source.id}
              onShowTag={onShowTag}
            />
          </SourceScope>
        ))
      )}
    </section>
  );
}

/** Whether any notebook has a tag; null without the sources (one notebook in context). */
function useAnyTags(sources: readonly Source[] | null): boolean | null {
  const subscribe = useMemo(() => {
    if (!sources) return NO_SOURCES;
    return (listener: () => void) => {
      const offs = sources.map((source) => source.notes.subscribe(listener));
      return () => {
        for (const off of offs) off();
      };
    };
  }, [sources]);
  const read = () =>
    sources ? sources.some((source) => source.notes.list().some((n) => n.tags.length > 0)) : null;
  const any = useSyncExternalStore(subscribe, read, read);
  // One notebook in context: its own section says when it has none.
  return any;
}

/** One notebook's tags (the notebook in context). */
function NotebookTags({
  name,
  sourceId,
  onShowTag,
}: {
  /** The notebook's name, as its section's heading; null with one notebook. */
  readonly name: string | null;
  readonly sourceId: string | null;
  readonly onShowTag: ShowTag;
}) {
  const list = useOpenNoteList();
  const tree = useMemo(() => tagTree(list.map((entry) => entry.tags)), [list]);
  const workspace = useWorkspace();
  const descriptions = useWorkspaceState().snapshot.tagDescriptions ?? {};

  const rows = (nodes: readonly TagNode[], depth: number) =>
    nodes.map((node) => (
      <li
        key={node.tag}
        className="tags-page-item"
        data-tag={node.tag}
        style={{ ['--depth' as string]: depth }}
      >
        <div className="tags-page-row">
          <button
            type="button"
            className="tags-page-name"
            data-ui="item"
            aria-label={`#${node.tag}, ${node.count} ${node.count === 1 ? 'note' : 'notes'}`}
            data-tip={`Show Notes Tagged #${node.tag}`}
            onClick={() => onShowTag(sourceId, node.tag)}
          >
            <span className="tag-hash" aria-hidden="true">
              #
            </span>
            {node.name}
          </button>
          <span className="tags-page-count muted" aria-hidden="true">
            {node.count} {node.count === 1 ? 'note' : 'notes'}
          </span>
        </div>
        <DescriptionField
          tag={node.tag}
          value={Object.hasOwn(descriptions, node.tag) ? descriptions[node.tag]! : ''}
          onChange={(text) => workspace.setTagDescription(node.tag, text)}
        />
        {node.children.length > 0 ? (
          <ul className="tags-page-tree" role="list">
            {rows(node.children, depth + 1)}
          </ul>
        ) : null}
      </li>
    ));

  const headingId = sourceId ? `tags-page-${sourceId}` : undefined;
  return (
    <section
      className="tags-page-notebook"
      aria-labelledby={name ? headingId : undefined}
      aria-label={name ? undefined : 'Tags'}
      data-testid="tags-page-notebook"
    >
      {name ? (
        <h3 id={headingId} className="tags-page-notebook-name">
          <Icon name="notebook" size={16} />
          {name}
        </h3>
      ) : null}
      {tree.length === 0 ? (
        <p className="muted tags-page-none" data-testid="tags-page-none">
          No tags in this notebook yet.
        </p>
      ) : (
        <ul className="tags-page-tree" role="list">
          {rows(tree, 0)}
        </ul>
      )}
    </section>
  );
}

/**
 * A tag's description: several lines, saved as they are typed (as a note's title is). While it
 * has focus it shows what is typed; otherwise what is stored, so another device's edit arrives.
 */
function DescriptionField({
  tag,
  value,
  onChange,
}: {
  readonly tag: string;
  readonly value: string;
  readonly onChange: (text: string) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <textarea
      className="input tags-page-description"
      aria-label={`Description of #${tag}`}
      placeholder={`What #${tag} means`}
      rows={1}
      maxLength={TAG_DESCRIPTION_MAX}
      spellCheck
      value={draft ?? value}
      onFocus={() => setDraft(value)}
      onBlur={() => setDraft(null)}
      onChange={(event) => {
        setDraft(event.target.value);
        onChange(event.target.value);
      }}
    />
  );
}
