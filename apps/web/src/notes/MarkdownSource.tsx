/**
 * The markdown source view's text (T11), edited in place (Quanta feedback 3, item 4; A1133):
 * the frontmatter stays read-only, since the note's own fields (title, tags, pins) write it, and
 * the body is plain text typed straight into, applied to the note as a pause in typing comes and
 * when the view loses focus. While the person types, the note's own changes do not overwrite
 * what they are writing; once they leave the text it shows the note again, as stored.
 */
import { useEffect, useLayoutEffect, useRef } from 'react';
import { splitMarkdown } from './markdown';

/** How long a pause in typing is before the body is applied to the note. */
const APPLY_AFTER_MS = 400;

export function MarkdownSource({
  markdown,
  editable,
  onEdit,
}: {
  markdown: string;
  /** False for a note that cannot be edited here: a version, or one in Trash. */
  editable: boolean;
  /** Applies an edited body to the note. */
  onEdit: (body: string) => void;
}) {
  const { frontmatter, body } = splitMarkdown(markdown);
  const bodyRef = useRef<HTMLPreElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const edited = useRef(false);
  // The text as last typed: on unmount the element is already gone from the ref.
  const typed = useRef('');
  const onEditRef = useRef(onEdit);
  useLayoutEffect(() => {
    onEditRef.current = onEdit;
  });

  // React does not own the body's text: it is set here, and not while the person types in it.
  useEffect(() => {
    const element = bodyRef.current;
    if (!element || element === document.activeElement) return;
    if (element.textContent !== body) element.textContent = body;
  }, [body]);

  const flush = () => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
    if (!edited.current) return;
    edited.current = false;
    onEditRef.current(typed.current);
  };
  useEffect(() => () => flush(), []);

  return (
    <div className="note-markdown" data-testid="note-markdown">
      {frontmatter ? (
        <pre
          className="note-markdown-frontmatter"
          aria-label="Frontmatter"
          aria-readonly="true"
          data-testid="note-markdown-frontmatter"
        >
          {frontmatter.replace(/\n+$/, '\n')}
        </pre>
      ) : null}
      <pre
        ref={bodyRef}
        className="note-markdown-body"
        role="textbox"
        aria-multiline="true"
        aria-label="Markdown source"
        aria-readonly={editable ? undefined : 'true'}
        tabIndex={0}
        contentEditable={editable ? 'plaintext-only' : false}
        suppressContentEditableWarning
        spellCheck={false}
        data-testid="note-markdown-body"
        onInput={(event) => {
          // innerText: Enter may write a <br>, which textContent would drop.
          typed.current = event.currentTarget.innerText;
          edited.current = true;
          if (timer.current !== null) clearTimeout(timer.current);
          timer.current = setTimeout(flush, APPLY_AFTER_MS);
        }}
        onBlur={() => {
          flush();
          // Shows the note as stored, which may write the markdown a little differently.
          const element = bodyRef.current;
          if (element && element.textContent !== body) element.textContent = body;
        }}
      />
    </div>
  );
}
