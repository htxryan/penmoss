/**
 * The rows every Settings page is built from (PEN-146; one set since PEN-148, Writing's too): a
 * group's subhead, with a scope marker when what it holds is this device's own; a bordered group
 * of rows (`lf-group`), each a label (and a line of help) on the left and its control on the
 * right; and a switch, a native checkbox drawn as on and off. Every row carries `data-setting`,
 * its label in kebab case, which Search Settings scrolls to.
 */
import type { InputHTMLAttributes, ReactNode } from 'react';
import { desktop } from '../desktop/bridge';
import './look-settings.css';

/** What a setting kept on this device alone is marked with: "This Mac" in the Mac app. */
const deviceScopeLabel = (): string => (desktop() ? 'This Mac' : 'This Device');

export function ScopeMarker({ label }: { readonly label?: string }) {
  return (
    <span className="lf-scope" data-testid="scope-marker">
      {label ?? deviceScopeLabel()}
    </span>
  );
}

/** A group's subhead, a rule running to the page's edge after it. */
export function GroupHead({
  children,
  scope,
  hint,
  id,
}: {
  readonly children: ReactNode;
  /** The group is this device's own. */
  readonly scope?: boolean | undefined;
  /** A short note after the name, e.g. how to reorder the group's rows. */
  readonly hint?: ReactNode | undefined;
  readonly id?: string | undefined;
}) {
  return (
    <h3 className="lf-sub" id={id}>
      <span>{children}</span>
      {scope ? <ScopeMarker /> : null}
      {hint ? <span className="lf-sub-hint">{hint}</span> : null}
    </h3>
  );
}

export function SettingRow({
  setting,
  label,
  labelFor,
  labelId,
  help,
  helpId,
  lead,
  testId,
  scope,
  extra,
  children,
  ...data
}: {
  /** The row's id for Search Settings: its label in kebab case. */
  readonly setting: string;
  readonly label: ReactNode;
  /** The control the label names; without one the label is plain text (`labelId` names it). */
  readonly labelFor?: string | undefined;
  readonly labelId?: string | undefined;
  readonly help?: ReactNode | undefined;
  readonly helpId?: string | undefined;
  /** Before the label: a drag handle. */
  readonly lead?: ReactNode | undefined;
  readonly testId?: string | undefined;
  /** The row alone is this device's own. */
  readonly scope?: boolean | undefined;
  /** Under the help: a status line or an alert about the row (`lf-row-note`). */
  readonly extra?: ReactNode | undefined;
  readonly children?: ReactNode | undefined;
} & { readonly [key: `data-${string}`]: string | undefined }) {
  const name = (
    <>
      {label}
      {scope ? <ScopeMarker /> : null}
    </>
  );
  return (
    <div className="lf-row" data-setting={setting} data-testid={testId} {...data}>
      {lead}
      <div className="lf-row-text">
        {labelFor ? (
          <label className="lf-row-label" htmlFor={labelFor} id={labelId}>
            {name}
          </label>
        ) : (
          <span className="lf-row-label" id={labelId}>
            {name}
          </span>
        )}
        {help ? (
          <span className="lf-row-help" id={helpId}>
            {help}
          </span>
        ) : null}
        {extra}
      </div>
      {children !== undefined ? <div className="lf-row-control">{children}</div> : null}
    </div>
  );
}

/** A switch: a native checkbox (Space toggles it, tests check it), drawn as on and off. */
export function Switch(props: Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'role'>) {
  return <input {...props} type="checkbox" role="switch" className="lf-switch" />;
}
