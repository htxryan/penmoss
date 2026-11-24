/**
 * Settings → Privacy → Advanced (PEN-137, O7, ac25, ac27, ac39): a disclosure, closed until
 * opened, with every limit in three groups (Usage Record, Logs, Bug Reports). Each field has its
 * unit and range, and "Default: n" once changed. A value outside the range says "Between a and
 * b" and is not saved. A value is committed with Enter or by leaving the field; one that would
 * delete anything asks first, under the field ("Delete 41,206 Events?"), and Cancel puts the old
 * value back. Under each group, how much it may take; Reset to Defaults at the foot asks the same
 * way, with the CLI's way to change them.
 */
import {
  DEFAULT_LIMITS,
  eventSpace,
  LIMITS,
  logSpace,
  reportHours,
  type LimitKey,
  type LimitSpec,
  type Limits,
} from '@penmoss/core/analytics';
import { formatBytes } from '@penmoss/core/words';
import { Icon } from '@penmoss/ui/icons';
import { useId, useRef, useState } from 'react';
import type { DesktopAnalytics, LimitsPreview } from '../desktop/bridge';
import { ConfirmBlock } from '../shell/ConfirmBlock';
import { record } from './record';
import { copy } from './status';

/** Each limit's row id for Search Settings: its label's, but the two At Most fields' own. */
const LIMIT_SETTING_IDS: Readonly<Record<LimitKey, string>> = {
  'events.days': 'keep-events-for',
  'events.max': 'keep-at-most',
  'logs.fileKb': 'log-file-size',
  'logs.files': 'log-files-kept',
  'logs.days': 'keep-log-lines-for',
  'report.hours': 'attach-logs-from-the-last',
  'report.lines': 'report-at-most-lines',
  'report.kb': 'report-at-most-kb',
};

const GROUPS = [
  { id: 'usage', title: 'limits.usage.title' },
  { id: 'logs', title: 'limits.logs.title' },
  { id: 'report', title: 'limits.report.title' },
] as const;

const LABELS = {
  'events.days': 'limits.events.days.label',
  'events.max': 'limits.events.max.label',
  'logs.fileKb': 'limits.logs.fileKb.label',
  'logs.files': 'limits.logs.files.label',
  'logs.days': 'limits.logs.days.label',
  'report.hours': 'limits.report.hours.label',
  'report.lines': 'limits.report.lines.label',
  'report.kb': 'limits.report.kb.label',
} as const satisfies Record<LimitKey, string>;

/** What a lowering would delete, as the confirmation asks it. */
interface Pruning {
  readonly title: string;
  readonly body: string;
}

/**
 * A lowering's question, under the field or Reset to Defaults: Cancel (quiet, focused first, and
 * Escape) or Delete. Its title is `pruning`'s.
 */
function PruneConfirm({
  asking,
  onCancel,
  onConfirm,
}: {
  readonly asking: Pruning;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}) {
  return (
    <ConfirmBlock
      className="privacy-confirm"
      title={asking.title}
      testId="privacy-limit-confirm"
      onCancel={onCancel}
    >
      <p className="privacy-confirm-body">{asking.body}</p>
      <span className="privacy-confirm-actions">
        <button
          type="button"
          className="btn quiet"
          data-ui="dismiss"
          data-event="privacy.limits.cancel"
          data-testid="privacy-limit-confirm-cancel"
          onClick={onCancel}
        >
          {copy('confirm.cancel.button')}
        </button>
        <button
          type="button"
          className="btn danger"
          data-ui="submit"
          data-event="privacy.limits.confirm"
          data-testid="privacy-limit-confirm-delete"
          onClick={onConfirm}
        >
          {copy('confirm.delete.button')}
        </button>
      </span>
    </ConfirmBlock>
  );
}

/** Why `key` at `value` deletes what it does: its age, its cap or the logs' size. */
function reason(key: LimitKey, value: number): string {
  if (key === 'events.days' || key === 'logs.days') {
    return copy('prune.reason.age', { days: value });
  }
  if (key === 'events.max') return copy('prune.reason.cap', { max: value });
  return copy('prune.reason.size');
}

/** The question for a preview that deletes something, or null when it deletes nothing. */
function pruning(preview: LimitsPreview, key: LimitKey, value: number): Pruning | null {
  const events = key.startsWith('events.') && preview.events > 0;
  const logs = key.startsWith('logs.') && preview.logBytes > 0;
  if (!events && !logs) return null;
  return {
    title: events
      ? copy('prune.events.title', { count: preview.events })
      : copy('prune.logs.title', { size: formatBytes(preview.logBytes) }),
    body: copy('prune.body', { reason: reason(key, value) }),
  };
}

/** What Reset to Defaults would delete, asked as the first limit it lowers would ask it. */
function resetPruning(preview: LimitsPreview, limits: Limits): Pruning | null {
  const kind = preview.events > 0 ? 'events.' : preview.logBytes > 0 ? 'logs.' : null;
  const lowered = kind
    ? LIMITS.find(
        (spec) => spec.key.startsWith(kind) && DEFAULT_LIMITS[spec.key] < limits[spec.key],
      )
    : undefined;
  return lowered ? pruning(preview, lowered.key, DEFAULT_LIMITS[lowered.key]) : null;
}

/** A limit's value as its field shows it: "5,000". */
const shown = (value: number) => value.toLocaleString('en-US');

/** The whole number typed, or null for anything else. */
function typed(text: string): number | null {
  const trimmed = text.trim().replace(/[,_\s]/g, '');
  return /^\d{1,9}$/.test(trimmed) ? Number(trimmed) : null;
}

export function AdvancedLimits({
  analytics,
  limits,
}: {
  readonly analytics: DesktopAnalytics;
  readonly limits: Limits;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  return (
    <details
      className="privacy-advanced"
      data-setting="advanced"
      data-testid="privacy-advanced"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary
        className="lf-sub privacy-advanced-summary"
        data-event="privacy.advanced"
        data-testid="privacy-advanced-summary"
      >
        <Icon name="chevR" size={14} className="privacy-advanced-chevron" />
        <h3 className="lf-sub-name" id={`${id}-h`}>
          {copy('privacy.advanced.label')}
        </h3>
        <span className="lf-sub-hint privacy-advanced-hint" data-testid="privacy-advanced-hint">
          {copy('privacy.advanced.hint')}
        </span>
      </summary>
      <p className="privacy-advanced-intro">{copy('privacy.advanced.intro')}</p>
      <div className="privacy-limits">
        {GROUPS.map((group) => (
          <section
            key={group.id}
            className="privacy-limit-group"
            aria-labelledby={`${id}-${group.id}`}
            data-testid={`privacy-limits-${group.id}`}
          >
            <h4 id={`${id}-${group.id}`} className="privacy-limit-group-title">
              {copy(group.title)}
            </h4>
            {LIMITS.filter((spec) => spec.group === group.id).map((spec) => (
              <LimitField
                key={spec.key}
                spec={spec}
                saved={limits[spec.key]}
                analytics={analytics}
              />
            ))}
            <p className="privacy-space" data-testid={`privacy-space-${group.id}`}>
              {group.id === 'usage'
                ? copy('limits.usage.space', { size: formatBytes(eventSpace(limits)) })
                : group.id === 'logs'
                  ? copy('limits.logs.space', { size: formatBytes(logSpace(limits)) })
                  : copy('limits.report.space', {
                      hours: reportHours(limits),
                      lines: limits['report.lines'],
                      kb: limits['report.kb'],
                    })}
            </p>
          </section>
        ))}
      </div>
      <ResetLimits analytics={analytics} limits={limits} />
    </details>
  );
}

function LimitField({
  spec,
  saved,
  analytics,
}: {
  readonly spec: LimitSpec;
  readonly saved: number;
  readonly analytics: DesktopAnalytics;
}) {
  const id = useId();
  // What is typed and not yet saved; null shows the saved value, so a change from elsewhere
  // (Reset to Defaults, a terminal) always reaches the field.
  const [draft, setDraft] = useState<string | null>(null);
  const [refused, setRefused] = useState(false);
  const [asking, setAsking] = useState<(Pruning & { readonly value: number }) | null>(null);
  /** A commit in flight, or a question open: leaving the field commits nothing more. */
  const working = useRef(false);
  // The saved value as main has it (a terminal may change it meanwhile): it replaces any draft.
  const [held, setHeld] = useState(saved);
  if (held !== saved) {
    setHeld(saved);
    setDraft(null);
    setRefused(false);
  }
  const text = draft ?? shown(saved);

  const save = async (value: number) => {
    await analytics.setLimits({ [spec.key]: value }).catch(() => null);
    record('setting', `privacy.limits.${spec.key}`, { value });
  };
  const commit = async () => {
    if (working.current || draft === null) return;
    const value = typed(draft);
    if (value === null || value < spec.min || value > spec.max) {
      setRefused(true);
      return;
    }
    setRefused(false);
    if (value === saved) {
      setDraft(null);
      return;
    }
    working.current = true;
    let waits = false;
    try {
      // Raising never deletes anything; lowering asks first when it would.
      const preview =
        value > saved ? null : await analytics.preview({ [spec.key]: value }).catch(() => null);
      const asked = preview ? pruning(preview, spec.key, value) : null;
      if (asked) {
        // Until it is answered: focus going to Cancel commits nothing more.
        waits = true;
        setAsking({ ...asked, value });
        return;
      }
      await save(value);
      setDraft(null);
    } finally {
      if (!waits) working.current = false;
    }
  };
  const settle = () => {
    setAsking(null);
    working.current = false;
  };

  const changed = saved !== spec.default;
  const label = copy(LABELS[spec.key]);
  return (
    <div className="privacy-limit" data-setting={LIMIT_SETTING_IDS[spec.key]} data-limit={spec.key}>
      <label className="privacy-limit-label" htmlFor={`${id}-input`}>
        {label}
      </label>
      <span className="privacy-limit-input">
        <input
          id={`${id}-input`}
          className="input"
          inputMode="numeric"
          spellCheck={false}
          autoComplete="off"
          value={text}
          aria-invalid={refused || undefined}
          aria-describedby={`${id}-range`}
          data-testid={`privacy-limit-${spec.key}`}
          onChange={(event) => {
            setDraft(event.target.value);
            if (refused) setRefused(false);
          }}
          onKeyDown={(event) => {
            if (event.key !== 'Enter') return;
            event.preventDefault();
            void commit();
          }}
          onBlur={() => void commit()}
        />
        <span className="privacy-limit-unit">{spec.unit}</span>
      </span>
      <span className="privacy-limit-hint" id={`${id}-range`}>
        {refused ? (
          <span role="alert" className="privacy-limit-refused" data-testid="privacy-limit-refused">
            {copy('limits.range', { min: spec.min, max: spec.max })}
          </span>
        ) : (
          <span data-testid="privacy-limit-range">
            {`${spec.min.toLocaleString('en-US')}–${spec.max.toLocaleString('en-US')} ${spec.unit}`}
          </span>
        )}
        {changed ? (
          <span className="privacy-limit-default" data-testid="privacy-limit-default">
            {copy('limits.default', { value: spec.default })}
          </span>
        ) : null}
      </span>
      {asking ? (
        <PruneConfirm
          asking={asking}
          onCancel={() => {
            setDraft(null);
            settle();
          }}
          onConfirm={() => {
            const value = asking.value;
            settle();
            void save(value).then(() => setDraft(null));
          }}
        />
      ) : null}
    </div>
  );
}

/** Reset to Defaults, asking first when the defaults would delete anything. */
function ResetLimits({
  analytics,
  limits,
}: {
  readonly analytics: DesktopAnalytics;
  readonly limits: Limits;
}) {
  const [asking, setAsking] = useState<Pruning | null>(null);
  const [busy, setBusy] = useState(false);
  const allDefault = LIMITS.every((spec) => limits[spec.key] === spec.default);
  const reset = async () => {
    await analytics.setLimits(null).catch(() => null);
    record('setting', 'privacy.limits.reset', { value: true });
  };
  const hint = copy('limits.reset.hint');
  const command = 'penmoss analytics limits';
  const at = hint.indexOf(command);
  return (
    <div className="privacy-limits-foot" data-testid="privacy-limits-foot">
      <span className="privacy-limits-reset">
        <button
          type="button"
          className="btn"
          data-ui="item"
          data-event="privacy.limits.reset"
          data-testid="privacy-limits-reset"
          disabled={busy || allDefault || asking !== null}
          onClick={() => {
            setBusy(true);
            void (async () => {
              const preview = await analytics.preview(DEFAULT_LIMITS).catch(() => null);
              const asked = preview ? resetPruning(preview, limits) : null;
              if (asked) setAsking(asked);
              else await reset();
              setBusy(false);
            })();
          }}
        >
          {copy('limits.reset.button')}
        </button>
        {at === -1 ? (
          <span className="privacy-limits-hint">{hint}</span>
        ) : (
          <span className="privacy-limits-hint">
            {hint.slice(0, at)}
            <code>{command}</code>
            {hint.slice(at + command.length)}
          </span>
        )}
      </span>
      {asking ? (
        <PruneConfirm
          asking={asking}
          onCancel={() => setAsking(null)}
          onConfirm={() => {
            setAsking(null);
            void reset();
          }}
        />
      ) : null}
    </div>
  );
}
