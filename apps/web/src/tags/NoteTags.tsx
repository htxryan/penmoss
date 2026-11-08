import { Icon } from '@penmoss/ui/icons';
import { normaliseTag } from '@penmoss/core/tags';
import { frontmatterTags, setFrontmatterTag } from '@penmoss/sync-client/tags';
import type { Yjs14Replica } from '@penmoss/sync-client/yjs14';
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { useCommands } from '../commands/hooks';
import { useNoteList } from '../notes/hooks';
import { tagFilter } from './filter';
import { tagSuggestions } from './suggest';

/**
 * A note's frontmatter tags (T18), set and removed here; in the Info panel
 * since T41 (A502), no longer under the title. Inline `#tags` are shown where
 * they are written, in the text, so they are not repeated as chips (T36,
 * A188). Choosing a tag filters the sidebar by it. The note view owns
 * `note.addTag` (it opens the panel first) and says when to start adding.
 *
 * The Add a tag field is a combobox (T42, A577): typing suggests every tag
 * on any note, ↑/↓ move through them, Enter adds the one chosen (or what was
 * typed), Escape closes the list and then the field. It has no browser
 * autocomplete, whose form history Chrome showed instead.
 */
export function NoteTags({
  replica,
  inline = [],
  adding,
  onAdding,
}: {
  replica: Yjs14Replica | null;
  /** The note's inline `#tags`: already on it, so never suggested (A577). */
  inline?: readonly string[];
  adding: boolean;
  onAdding: (adding: boolean) => void;
}) {
  const commands = useCommands();
  const [listed, setListed] = useState<readonly string[]>([]);
  const setAdding = onAdding;
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  /** Escape left the field: focus goes back to Add a tag, not the page (T39 pass 2). */
  const refocus = useRef(false);
  const list = useNoteList();
  const id = useId();
  /** The suggestion ↑/↓ chose (-1: none, Enter adds what was typed). */
  const [active, setActive] = useState(-1);
  /** Escape closed the list; typing opens it again. */
  const [listClosed, setListClosed] = useState(false);
  const suggestions = useMemo(
    () =>
      adding
        ? tagSuggestions(
            list.map((entry) => entry.tags),
            value,
            [...listed, ...inline],
          )
        : [],
    [adding, list, value, listed, inline],
  );
  const listOpen = suggestions.length > 0 && !listClosed;
  const current = active < suggestions.length ? active : -1;

  // Frontmatter tags are attributes, cheap to read on every change; the chips re-render only
  // when they change, not on every keystroke.
  useEffect(() => {
    if (!replica) return;
    const read = () => {
      const next = frontmatterTags(replica.doc);
      setListed((current) => (current.join('\n') === next.join('\n') ? current : next));
    };
    read();
    return replica.onUpdate(read);
  }, [replica]);

  useEffect(() => {
    if (adding) input.current?.focus();
    else if (refocus.current) addButton.current?.focus();
    refocus.current = false;
  }, [adding]);

  const all = [...listed].sort();

  const add = (raw: string = value) => {
    if (!replica) return;
    const tag = normaliseTag(raw);
    if (!tag) {
      setError('A tag is letters, digits, - and _, with / for levels, and no spaces.');
      return;
    }
    setFrontmatterTag(replica.doc, tag, true);
    setValue('');
    setError(null);
    setActive(-1);
  };

  if (all.length === 0 && !adding) {
    return (
      <div className="note-tags" data-testid="note-tags">
        <button
          ref={addButton}
          type="button"
          className="tag-add"
          data-command="note.addTag"
          aria-label="Add a Tag"
          data-tip="Add a Tag"
          onClick={() => commands.run('note.addTag')}
        >
          <Icon name="plus" size={12} />
          Tag
        </button>
      </div>
    );
  }

  return (
    <div className="note-tags" data-testid="note-tags">
      <ul className="note-tag-list" role="list" aria-label="Tags">
        {all.map((tag) => (
          <li key={tag} className="tag-chip" data-tag={tag}>
            <button
              type="button"
              className="tag-chip-name"
              data-ui="item"
              data-tip={`Show Notes Tagged #${tag}`}
              onClick={() => tagFilter.set(tag)}
            >
              #{tag}
            </button>
            {replica ? (
              <button
                type="button"
                className="tag-chip-remove"
                data-ui="item"
                aria-label={`Remove the Tag #${tag}`}
                data-tip={`Remove the Tag #${tag}`}
                onClick={() => setFrontmatterTag(replica.doc, tag, false)}
              >
                <Icon name="close" size={12} />
              </button>
            ) : null}
          </li>
        ))}
      </ul>
      {adding ? (
        <form
          className="tag-add-form"
          onSubmit={(event) => {
            event.preventDefault();
            add(listOpen && current >= 0 ? suggestions[current] : value);
          }}
        >
          <span className="tag-combo">
            <input
              ref={input}
              className="input tag-input"
              role="combobox"
              aria-label="Add a tag"
              aria-autocomplete="list"
              aria-expanded={listOpen}
              aria-controls={listOpen ? `${id}-tags` : undefined}
              aria-activedescendant={listOpen && current >= 0 ? `${id}-tag-${current}` : undefined}
              autoComplete="off"
              spellCheck={false}
              placeholder="tag or area/tag"
              value={value}
              onChange={(event) => {
                setError(null);
                setValue(event.target.value);
                setActive(-1);
                setListClosed(false);
              }}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing) return;
                if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                  if (suggestions.length === 0) return;
                  event.preventDefault();
                  setListClosed(false);
                  const count = suggestions.length;
                  const step = event.key === 'ArrowDown' ? 1 : -1;
                  setActive(
                    !listOpen || current < 0
                      ? step === 1
                        ? 0
                        : count - 1
                      : (current + step + count) % count,
                  );
                } else if (event.key === 'Escape') {
                  event.preventDefault();
                  // The list first, then the field.
                  if (listOpen) {
                    setListClosed(true);
                    setActive(-1);
                    return;
                  }
                  refocus.current = true;
                  setAdding(false);
                  setValue('');
                  setError(null);
                }
              }}
              onBlur={() => {
                if (!value.trim()) setAdding(false);
              }}
            />
            {listOpen ? (
              <span
                className="tag-suggestions"
                id={`${id}-tags`}
                role="listbox"
                aria-label="Tags"
                data-testid="tag-suggestions"
              >
                {suggestions.map((tag, index) => (
                  <span
                    key={tag}
                    id={`${id}-tag-${index}`}
                    role="option"
                    className="tag-suggestion"
                    aria-selected={index === current}
                    // Keeps focus in the field, so choosing does not close it.
                    onMouseDown={(event) => event.preventDefault()}
                    onMouseMove={() => {
                      if (index !== current) setActive(index);
                    }}
                    onClick={() => add(tag)}
                  >
                    #{tag}
                  </span>
                ))}
              </span>
            ) : null}
          </span>
          {error ? (
            <span className="kb-error" role="alert">
              {error}
            </span>
          ) : null}
        </form>
      ) : (
        <button
          ref={addButton}
          type="button"
          className="tag-add"
          data-command="note.addTag"
          aria-label="Add a Tag"
          data-tip="Add a Tag"
          onClick={() => commands.run('note.addTag')}
        >
          <Icon name="plus" size={12} />
          Tag
        </button>
      )}
    </div>
  );
}
