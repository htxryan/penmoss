/**
 * One screen of the first run (First Run C; Ryan's review of #192, findings 2–4): the "Step n of
 * 3" bar, the screen's title (which takes focus, so a screen reader hears where it is), what it
 * asks, and a footer with Back on the left and its buttons on the right.
 */
import { Icon, type IconName } from '@penmoss/ui/icons';
import { useEffect, useId, useRef, type ReactNode } from 'react';
import { folderWords } from './first-run-flow';

export function Frame({
  name,
  step,
  title,
  children,
  back,
  actions,
  centered = false,
  state,
  start,
  above,
}: {
  /** Above the title (the welcome's mark). */
  above?: ReactNode;
  /** The footer's left, when there is no Back (the welcome's Learn More). */
  start?: ReactNode;
  /** The screen, as `data-screen` (and the tests) name it. */
  name: string;
  /** Which of the three steps this is; none for the welcome and the last screen. */
  step?: 1 | 2 | 3;
  title: ReactNode;
  children?: ReactNode;
  /** Back, when there is somewhere to go back to. */
  back?: (() => void) | undefined;
  /** The footer's buttons, the primary one last. */
  actions?: ReactNode;
  /** The welcome: its words in the middle of the screen. */
  centered?: boolean;
  /** What the screen shows of its work, as `data-state`. */
  state?: string;
}) {
  const id = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus();
  }, [name]);
  return (
    <section
      className="fr-screen"
      aria-labelledby={`${id}-h`}
      data-testid={`first-run-${name}`}
      data-screen={name}
      data-state={state}
    >
      <div className={`fr-body${centered ? ' fr-centered' : ''}`}>
        {step ? (
          <div className="fr-progress">
            <p className="fr-step">Step {step} of 3</p>
            <div className="fr-bars" aria-hidden="true">
              {[1, 2, 3].map((each) => (
                <span key={each} className={each <= step ? 'on' : undefined} />
              ))}
            </div>
          </div>
        ) : null}
        {above}
        <h2 id={`${id}-h`} ref={heading} tabIndex={-1}>
          {title}
        </h2>
        {children}
      </div>
      {back || actions || start ? (
        <div className="fr-foot">
          {back ? (
            <button
              type="button"
              className="btn quiet"
              data-ui="item"
              data-testid="first-run-back"
              onClick={back}
            >
              <Icon name="chevL" size={14} />
              Back
            </button>
          ) : (
            (start ?? <span />)
          )}
          <span className="fr-actions">{actions}</span>
        </div>
      ) : null}
    </section>
  );
}

/** A primary or plain footer button. */
export function Action({
  children,
  onClick,
  primary = false,
  disabled = false,
  busy = false,
  icon,
  testId,
  form,
}: {
  children: ReactNode;
  onClick?: (() => void) | undefined;
  primary?: boolean;
  disabled?: boolean;
  /** Working: a spinner instead of the icon, and no second click. */
  busy?: boolean;
  icon?: IconName | undefined;
  testId?: string;
  /** Submits this form (the screen's fields), so Return in a field does what the button does. */
  form?: string;
}) {
  const props = {
    type: form ? ('submit' as const) : ('button' as const),
    form,
    'data-testid': testId,
    disabled: disabled || busy,
    'aria-busy': busy || undefined,
    onClick,
  };
  const content = (
    <>
      {busy ? (
        <span className="fr-spin" aria-hidden="true" />
      ) : icon ? (
        <Icon name={icon} size={14} />
      ) : null}
      {children}
    </>
  );
  return primary ? (
    <button className="btn primary" data-ui="submit" {...props}>
      {content}
    </button>
  ) : (
    <button className="btn" data-ui="item" {...props}>
      {content}
    </button>
  );
}

/** A button that reads as a link, inside a line of words. */
export function LinkButton({
  children,
  onClick,
  testId,
}: {
  children: ReactNode;
  onClick: () => void;
  testId?: string;
}) {
  return (
    <button type="button" className="fr-link" data-ui="item" data-testid={testId} onClick={onClick}>
      {children}
    </button>
  );
}

/** A line of work going on, with a spinner. */
export function Working({ children, testId }: { children: ReactNode; testId?: string }) {
  return (
    <p className="fr-status" role="status" data-testid={testId}>
      <span className="fr-spin" aria-hidden="true" />
      {children}
    </p>
  );
}

/** What went wrong, in its own words. */
export function Problem({ children, testId }: { children: ReactNode; testId?: string }) {
  return (
    <p className="fr-error" role="alert" data-testid={testId}>
      <Icon name="warning" size={16} />
      <span>{children}</span>
    </p>
  );
}

/** Where a notebook is or goes: its folder (Root or `dir/`) and branch, each with its icon. */
export function Location({ dir, branch }: { dir: string; branch?: string | undefined }) {
  return (
    <span className="fr-loc">
      <span data-testid="first-run-location-dir">
        <Icon name="folder" size={12} />
        {folderWords(dir)}
      </span>
      {branch ? (
        <span>
          <Icon name="branch" size={12} />
          {branch}
        </span>
      ) : null}
    </span>
  );
}

/** A repository (or address) with where in it: the card the name and repository screens show. */
export function PlaceCard({
  label,
  dir,
  branch,
  notebook,
}: {
  label: string;
  dir: string;
  branch: string;
  /** The notebook it holds, shown above the repository. */
  notebook?: string;
}) {
  return (
    <div className="fr-card" data-testid="first-run-place">
      {notebook ? (
        <span className="fr-card-icon">
          <Icon name="notebook" size={16} />
        </span>
      ) : null}
      <span className="fr-card-text">
        {notebook ? <strong className="fr-card-title">{notebook}</strong> : null}
        <span className={notebook ? 'muted' : 'fr-card-title'}>{label}</span>
        <Location dir={dir} branch={branch} />
      </span>
    </div>
  );
}

/** Branch and folder, out of the way (most repositories use main, at the root). */
export function MoreOptions({
  branch,
  dir,
  onBranch,
  onDir,
}: {
  branch: string;
  dir: string;
  onBranch: (branch: string) => void;
  onDir: (dir: string) => void;
}) {
  return (
    <details className="fr-more" data-testid="first-run-more">
      <summary>More Options</summary>
      <label className="settings-field">
        <span>Branch</span>
        <input
          className="input"
          value={branch}
          spellCheck={false}
          data-testid="first-run-branch"
          onChange={(event) => onBranch(event.target.value)}
        />
      </label>
      <label className="settings-field">
        <span>
          Folder <span className="muted">(optional, such as docs/notes)</span>
        </span>
        <input
          className="input"
          value={dir}
          spellCheck={false}
          data-testid="first-run-dir"
          onChange={(event) => onDir(event.target.value)}
        />
      </label>
    </details>
  );
}
