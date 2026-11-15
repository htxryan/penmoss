/**
 * The rows every Settings page is built from (PEN-146; one set since PEN-148, Writing's too): a
 * group's subhead, with a laptop mark when what it holds is this device's own; a bordered group
 * of rows (`lf-group`), each a label (and a line of help) on the left and its control on the
 * right; and a switch, a native checkbox drawn as on and off. Every row carries `data-setting`,
 * its label in kebab case, which Search Settings scrolls to.
 */
import { Icon } from '@penmoss/ui/icons';
import type { InputHTMLAttributes, MouseEvent, ReactNode } from 'react';
import { deviceOnlyTip } from './device-only';
import './look-settings.css';

/**
 * A setting (or, with `many`, a group of them) kept on this device alone (A1559): a laptop, its
 * sentence the app's tooltip on hover and on keyboard focus, and its accessible name. Never inside
 * a `<label>`, whose control would take the sentence into its own name; a click on it does
 * nothing, so it never toggles a control beside it.
 */
export function ScopeMarker({ many = false }: { readonly many?: boolean }) {
  const tip = deviceOnlyTip(many);
  return (
    <span
      className="lf-scope"
      role="img"
      tabIndex={0}
      aria-label={tip}
      data-tip={tip}
      data-testid="scope-marker"
      onClick={(event: MouseEvent) => event.preventDefault()}
    >
      <Icon name="laptop" size={14} />
    </span>
  );
}

/**
 * A group's subhead, a rule running to the page's edge after it. The heading is the name alone
 * (the group's `aria-labelledby` points at `id`); the laptop mark and the hint follow it.
 */
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
    <div className="lf-sub">
      <h3 className="lf-sub-name" id={id}>
        {children}
      </h3>
      {scope ? <ScopeMarker many /> : null}
      {hint ? <span className="lf-sub-hint">{hint}</span> : null}
    </div>
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
  const name = labelFor ? (
    <label className="lf-row-label" htmlFor={labelFor} id={labelId}>
      {label}
    </label>
  ) : (
    <span className="lf-row-label" id={labelId}>
      {label}
    </span>
  );
  return (
    <div className="lf-row" data-setting={setting} data-testid={testId} {...data}>
      {lead}
      <div className="lf-row-text">
        {/* The mark beside the label, not in it: the control's name stays the label (A1559). */}
        {scope ? (
          <span className="lf-row-name">
            {name}
            <ScopeMarker />
          </span>
        ) : (
          name
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
