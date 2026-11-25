/** Send Feedback's description toolbar and its link editor (FeedbackDialog.tsx). */
import { FEEDBACK_FORMATS, setFeedbackLink, type FeedbackEditor } from '@penmoss/editor/feedback';
import { ariaKeyShortcuts, formatCombo } from '@penmoss/editor/keys';
import { Icon, type IconName } from '@penmoss/ui/icons';
import type { RefObject } from 'react';
import type { TypedLengthMarks } from '../analytics/typed';

const keysOf = (keys: string) =>
  keys
    .split('-')
    .map((part) => (part.length === 1 ? part.toUpperCase() : part))
    .join('+');

/** The toolbar's icons, and glyphs where the icon set has none. */
const ICONS: Readonly<Record<string, IconName>> = {
  bold: 'bold',
  italic: 'italic',
  code: 'code',
  bulletList: 'list',
};
const GLYPHS: Readonly<Record<string, string>> = {
  orderedList: '1.',
  indent: '→',
  outdent: '←',
  blockquote: '❝',
  codeBlock: '{ }',
};

/** The formatting toolbar over the description, and the link's address when Link is open. */
export function FeedbackFormatting({
  id,
  editorRef,
  active,
  linkHref,
  setLinkHref,
  typedLink,
}: {
  id: string;
  editorRef: RefObject<FeedbackEditor | null>;
  /** Which formats the selection has, for the toolbar's pressed states. */
  active: ReadonlySet<string>;
  /** The link's address while Link is open; null while it is closed. */
  linkHref: string | null;
  setLinkHref: (href: string | null) => void;
  typedLink: TypedLengthMarks;
}) {
  return (
    <>
      <div className="feedback-toolbar" role="toolbar" aria-label="Formatting">
        {FEEDBACK_FORMATS.map((format) => (
          <button
            key={format.id}
            type="button"
            className="icon-btn feedback-format"
            data-ui="option"
            data-event="feedback.format"
            data-testid={`feedback-format-${format.id}`}
            aria-pressed={
              ['indent', 'outdent'].includes(format.id) ? undefined : active.has(format.id)
            }
            aria-keyshortcuts={ariaKeyShortcuts([keysOf(format.keys)]) || undefined}
            data-tip={`${format.label} (${formatCombo(keysOf(format.keys))})`}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              const editor = editorRef.current;
              if (editor) format.run(editor);
            }}
          >
            {ICONS[format.id] ? (
              <Icon name={ICONS[format.id]!} />
            ) : (
              <span className="feedback-format-glyph" aria-hidden="true">
                {GLYPHS[format.id]}
              </span>
            )}
            <span className="sr-only">{format.label}</span>
          </button>
        ))}
        <button
          type="button"
          className="icon-btn feedback-format"
          data-ui="option"
          data-event="feedback.format.link"
          data-testid="feedback-format-link"
          aria-pressed={active.has('link')}
          aria-expanded={linkHref !== null}
          data-tip="Link"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() =>
            setLinkHref(
              linkHref === null
                ? ((editorRef.current?.getAttributes('link')['href'] as string | undefined) ?? '')
                : null,
            )
          }
        >
          <Icon name="link" />
          <span className="sr-only">Link</span>
        </button>
      </div>
      {linkHref !== null ? (
        <div className="feedback-link">
          <label className="sr-only" htmlFor={`${id}-link`}>
            Link address
          </label>
          <input
            id={`${id}-link`}
            type="url"
            autoFocus
            placeholder="https://"
            value={linkHref}
            {...typedLink}
            data-testid="feedback-link-href"
            onChange={(event) => setLinkHref(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                if (editorRef.current && setFeedbackLink(editorRef.current, linkHref))
                  setLinkHref(null);
              }
            }}
          />
          <button
            type="button"
            className="btn"
            data-ui="submit"
            data-event="feedback.link.apply"
            onClick={() => {
              if (editorRef.current && setFeedbackLink(editorRef.current, linkHref))
                setLinkHref(null);
            }}
          >
            Apply
          </button>
          <button
            type="button"
            className="btn quiet"
            data-ui="dismiss"
            data-event="feedback.link.remove"
            onClick={() => {
              if (editorRef.current) setFeedbackLink(editorRef.current, '');
              setLinkHref(null);
            }}
          >
            Remove Link
          </button>
        </div>
      ) : null}
    </>
  );
}
