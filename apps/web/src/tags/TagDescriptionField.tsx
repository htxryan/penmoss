/** A tag's description field on the Tags page (TagsPage.tsx). */
import { TAG_DESCRIPTION_MAX } from '@penmoss/core/tags';
import { Icon } from '@penmoss/ui/icons';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Workspace } from '../workspace/service';

type SaveState = 'idle' | 'saving' | 'saved' | 'failed';

/** How long a typed description waits before it is stored, and how long Saved shows. */
const SAVE_DELAY_MS = 500;
const SAVED_MS = 2000;

/**
 * A tag's description: its first line, cut with an ellipsis, until it is chosen; then a field
 * that grows to show every line, saved as it is typed (as a note's title is). Beside it, Saving…
 * then Saved once it is stored, or Not saved with Try Again. While it is edited it shows what is
 * typed; otherwise what is stored, so another device's edit arrives.
 */
export function DescriptionField({
  tag,
  value,
  workspace,
  generating = false,
}: {
  readonly tag: string;
  readonly value: string;
  readonly workspace: Workspace;
  /** Its AI description is being generated (A1677): said where Saving… is. */
  readonly generating?: boolean;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const [state, setState] = useState<SaveState>('idle');
  const field = useRef<HTMLTextAreaElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fade = useRef<ReturnType<typeof setTimeout> | null>(null);
  const editing = draft !== null;
  const view = useRef<HTMLButtonElement>(null);
  const refocus = useRef(false);
  useEffect(() => {
    if (editing || !refocus.current) return;
    refocus.current = false;
    view.current?.focus();
  }, [editing]);

  const store = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    workspace.flush().then(
      () => {
        setState('saved');
        if (fade.current) clearTimeout(fade.current);
        fade.current = setTimeout(() => setState('idle'), SAVED_MS);
      },
      () => setState('failed'),
    );
  }, [workspace]);

  useEffect(
    () => () => {
      // Leaving the page: whatever is typed is stored now.
      if (timer.current) {
        clearTimeout(timer.current);
        void workspace.flush().catch(() => undefined);
      }
      if (fade.current) clearTimeout(fade.current);
    },
    [workspace],
  );

  // The field grows with its lines (one line high when short).
  useLayoutEffect(() => {
    const element = field.current;
    if (!element) return;
    element.style.height = 'auto';
    element.style.height = `${element.scrollHeight + 2}px`;
  }, [draft, editing]);

  const change = (text: string) => {
    setDraft(text);
    if (fade.current) clearTimeout(fade.current);
    try {
      workspace.setTagDescription(tag, text);
    } catch {
      setState('failed');
      return;
    }
    setState('saving');
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(store, SAVE_DELAY_MS);
  };

  const firstLine = value.split('\n')[0] ?? '';
  const more = value.includes('\n');
  return (
    <span className="tags-desc" data-state={state}>
      {editing ? (
        <textarea
          ref={field}
          className="input tags-desc-field"
          aria-label={`Description of #${tag}`}
          placeholder="Add a description"
          rows={1}
          maxLength={TAG_DESCRIPTION_MAX}
          spellCheck
          autoFocus
          value={draft}
          onFocus={(event) => {
            const end = event.currentTarget.value.length;
            event.currentTarget.setSelectionRange(end, end);
          }}
          onBlur={() => {
            if (timer.current) store();
            setDraft(null);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              // Done: what is typed is kept (it saves as it is typed), and focus stays on the row.
              event.preventDefault();
              event.stopPropagation();
              refocus.current = true;
              event.currentTarget.blur();
            }
          }}
          onChange={(event) => change(event.target.value)}
        />
      ) : (
        <button
          ref={view}
          type="button"
          className="tags-desc-view"
          data-ui="item"
          data-event="tags.description.edit"
          data-empty={value ? undefined : ''}
          aria-label={value ? `Description of #${tag}: ${value}` : `Add a Description of #${tag}`}
          onClick={() => setDraft(value)}
        >
          <span className="tags-desc-line">
            {value ? `${firstLine}${more ? ' …' : ''}` : 'Add a description'}
          </span>
        </button>
      )}
      <span className="tags-save" role="status" data-testid="tags-save">
        {generating ? (
          <>
            <span className="tags-save-dot" aria-hidden="true" />
            Generating…
          </>
        ) : state === 'saving' ? (
          <>
            <span className="tags-save-dot" aria-hidden="true" />
            Saving…
          </>
        ) : state === 'saved' ? (
          <>
            <Icon name="check" size={12} />
            Saved
          </>
        ) : state === 'failed' ? (
          <>
            <span className="tags-save-failed">Not saved</span>
            <button
              type="button"
              className="btn quiet"
              data-ui="submit"
              data-event="tags.description.retry"
              onClick={store}
            >
              Try Again
            </button>
          </>
        ) : null}
      </span>
    </span>
  );
}
