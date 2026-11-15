import type { CSSProperties } from 'react';

/**
 * A miniature of Penmoss (PEN-146): a strip of the sidebar and a note with its title, a line of
 * details, text with a link, a highlight and code, a task, a callout, a code block and buttons.
 * It reads only the page's `--pm-…` variables, so it shows whatever theme, mode, fonts and note
 * size are applied around it. Settings → Appearance shows the app's own; the theme editor sets
 * the edited variant's variables on it (`style`), so there is one renderer for both.
 */
export function AppPreview({
  style,
  testId = 'app-preview',
}: {
  /** Variables laid over the page's: the theme being edited, or a size being dragged. */
  readonly style?: CSSProperties | undefined;
  readonly testId?: string | undefined;
}) {
  return (
    <div className="theme-preview" style={style} data-testid={testId} aria-hidden="true">
      <div className="tp-side">
        <span className="tp-item tp-current">Today</span>
        <span className="tp-item">Projects</span>
        <span className="tp-item tp-muted">Inbox · 3</span>
      </div>
      <div className="tp-main">
        <p className="tp-title">Garden Plan</p>
        <p className="tp-muted tp-meta">Personal · Projects · Edited 4:02 PM</p>
        <p className="tp-text">
          Raised beds by the <span className="tp-link">fence</span>, with <mark>tomatoes</mark> and{' '}
          <code>basil</code>.
        </p>
        <p className="tp-text tp-task">
          <span className="tp-box" />
          Order the seeds
        </p>
        <div className="tp-callout">
          <b>Tip</b> Water in the morning.
        </div>
        <pre className="tp-code">
          <span className="tp-k">const</span> <span className="tp-f">beds</span> ={' '}
          <span className="tp-n">4</span>; <span className="tp-c">{'// by the fence'}</span>
          {'\n'}
          <span className="tp-k">plant</span>(<span className="tp-s">{"'tomato'"}</span>);
        </pre>
        <span className="tp-actions">
          <span className="tp-button">Save</span>
          <span className="tp-plain">Cancel</span>
          <span className="tp-danger">Delete</span>
        </span>
      </div>
    </div>
  );
}
