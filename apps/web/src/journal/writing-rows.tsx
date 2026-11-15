/**
 * The rows the Writing pages (Daily Notes, Quick Capture, Keyboard Shortcuts; PEN-146) are built
 * from: a group's subhead with a rule after it, a bordered group of rows, and a row with its
 * label and a line of help on the left and its control on the right. Every row carries
 * `data-setting`, its label in kebab case, which Search Settings scrolls to.
 */
import type { HTMLAttributes, InputHTMLAttributes, ReactNode } from 'react';
import './writing.css';

/** A group's subhead, a rule running to the page's edge after it. */
export function WritingSubhead({
  id,
  children,
}: {
  readonly id?: string;
  readonly children: ReactNode;
}) {
  return (
    <h3 className="wr-sub" id={id}>
      <span>{children}</span>
    </h3>
  );
}

/** A bordered group of rows (`role` and the rest go on it as they are: a radiogroup). */
export function WritingGroup({
  children,
  className,
  ...props
}: HTMLAttributes<HTMLDivElement> & { readonly 'data-testid'?: string }) {
  return (
    <div {...props} className={className ? `wr-group ${className}` : 'wr-group'}>
      {children}
    </div>
  );
}

export function WritingRow({
  setting,
  label,
  labelFor,
  labelId,
  help,
  helpId,
  testId,
  extra,
  children,
  ...data
}: {
  /** The row's id for Search Settings: its label in kebab case. */
  readonly setting: string;
  readonly label: ReactNode;
  /** The control the label names; without one the label is plain text (`labelId` names it). */
  readonly labelFor?: string;
  readonly labelId?: string;
  readonly help?: ReactNode;
  readonly helpId?: string;
  readonly testId?: string;
  /** Under the help: a status line or an alert about the row. */
  readonly extra?: ReactNode;
  readonly children?: ReactNode;
} & { readonly [key: `data-${string}`]: string | undefined }) {
  return (
    <div className="wr-row" data-setting={setting} data-testid={testId} {...data}>
      <div className="wr-row-text">
        {labelFor ? (
          <label className="wr-row-label" htmlFor={labelFor} id={labelId}>
            {label}
          </label>
        ) : (
          <span className="wr-row-label" id={labelId}>
            {label}
          </span>
        )}
        {help ? (
          <span className="wr-row-help" id={helpId}>
            {help}
          </span>
        ) : null}
        {extra}
      </div>
      {children !== undefined ? <div className="wr-row-control">{children}</div> : null}
    </div>
  );
}

/** A switch: a native checkbox (Space toggles it, tests check it), drawn as on and off. */
export function WritingSwitch(props: Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'role'>) {
  return <input {...props} type="checkbox" role="switch" className="wr-switch" />;
}
