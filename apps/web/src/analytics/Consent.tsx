/**
 * The consent question (PEN-137, O3, ac1 and ac8): "Share How You Use Penmoss?". The first run
 * asks it as its last step (FirstRun.tsx); an install that has a notebook and no answer is asked
 * once, in a dialog over the app (`ExistingInstallConsent`). Either way the same words: what
 * Penmoss records and never records, a Privacy Policy link, and Share Usage Data and Don't Share
 * as equal buttons (neither primary, neither focused first; Escape answers nothing). Events are
 * recorded on this Mac whatever the answer; it decides only whether they leave it.
 */
import type { ConsentAnswer } from '@penmoss/core/analytics';
import { useEffect, useId, useRef, useState } from 'react';
import { desktop } from '../desktop/bridge';
import { useTrackedDialog } from './dialog';
import { analyticsBridge, copy, PRIVACY_POLICY_URL, useAnalyticsStatus } from './status';
import './privacy.css';

const RECORDED = [
  'consent.recorded.1',
  'consent.recorded.2',
  'consent.recorded.3',
  'consent.recorded.4',
  // PEN-177: session detail, after the Mac's CLI line.
  'consent.recorded.5',
] as const;
const NEVER = ['consent.never.1', 'consent.never.2', 'consent.never.3'] as const;

/**
 * What the question says: the sentence, the two lists, where to change it later, and the Privacy
 * Policy, so the footer below it is the two answers alone, each half of it.
 */
export function ConsentQuestion() {
  return (
    <div className="consent" data-testid="consent-question">
      <p className="consent-lead">{copy('consent.body')}</p>
      <div className="consent-lists">
        <section className="consent-list" data-testid="consent-recorded">
          <h3>{copy('consent.recorded.title')}</h3>
          <ul>
            {RECORDED.map((key) => {
              const line = copy(key);
              return line ? <li key={key}>{line}</li> : null;
            })}
          </ul>
        </section>
        <section className="consent-list" data-testid="consent-never">
          <h3>{copy('consent.never.title')}</h3>
          <ul>
            {NEVER.map((key) => (
              <li key={key}>{copy(key)}</li>
            ))}
          </ul>
        </section>
      </div>
      <p className="consent-later">{copy('consent.later')}</p>
      <p className="consent-policy-line">
        <PrivacyPolicyLink className="consent-policy" event="consent.policy" />
      </p>
    </div>
  );
}

/** The Privacy Policy on penmoss.app, in the browser (`event`: the consent question's link). */
export function PrivacyPolicyLink({
  className,
  event,
}: {
  readonly className?: string;
  readonly event: 'consent.policy' | 'privacy.policy';
}) {
  return (
    <a
      className={className}
      href={PRIVACY_POLICY_URL}
      target="_blank"
      rel="noreferrer"
      data-event={event}
      data-testid="privacy-policy"
    >
      {copy('consent.policy.label')}
    </a>
  );
}

/**
 * Share Usage Data and Don't Share: the same button twice, each half of the row, neither the
 * default. `onAnswer`
 * runs once main has the answer (or could not be reached: the question is not asked again in
 * this window either way).
 */
export function ConsentAnswers({
  onChoose,
  onAnswer,
}: {
  /** At the click, before main has it (a dialog's `done`: the answer may close it first). */
  readonly onChoose?: () => void;
  readonly onAnswer: (answer: ConsentAnswer) => void;
}) {
  const [busy, setBusy] = useState(false);
  const answer = (consent: ConsentAnswer) => {
    if (busy) return;
    setBusy(true);
    onChoose?.();
    const analytics = analyticsBridge();
    void (analytics ? analytics.answer(consent) : Promise.resolve(null))
      .catch(() => null)
      .then(() => onAnswer(consent));
  };
  return (
    <span className="consent-answers">
      <button
        type="button"
        className="btn"
        data-ui="item"
        data-event="consent.share"
        data-testid="consent-share"
        disabled={busy}
        onClick={() => answer('yes')}
      >
        {copy('consent.share.button')}
      </button>
      <button
        type="button"
        className="btn"
        data-ui="item"
        data-event="consent.dont-share"
        data-testid="consent-dont-share"
        disabled={busy}
        onClick={() => answer('no')}
      >
        {copy('consent.dontShare.button')}
      </button>
    </span>
  );
}

/**
 * An install that had notebooks before PEN-137 and has no answer (ac8, N6): the question once,
 * as a dialog over the main window. Either answer closes it for good; Escape does not.
 */
export function ExistingInstallConsent() {
  const status = useAnalyticsStatus();
  const [answered, setAnswered] = useState(false);
  if (desktop()?.window !== 'main') return null;
  if (answered || !status?.ask || status.consent !== null) return null;
  return <ConsentDialog onAnswer={() => setAnswered(true)} />;
}

/** The question in a modal `<dialog>` (the app's confirm dialog's look), with no way to dismiss it. */
function ConsentDialog({ onAnswer }: { readonly onAnswer: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const tracked = useTrackedDialog('consent');
  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
    // The title, so neither answer is where focus starts.
    dialog?.querySelector<HTMLElement>('h2')?.focus();
  }, []);
  return (
    <dialog
      ref={ref}
      className="confirm consent-dialog"
      aria-labelledby={titleId}
      data-testid="consent-dialog"
      onCancel={(event) => event.preventDefault()}
    >
      <h2 id={titleId} tabIndex={-1}>
        {copy('consent.title')}
      </h2>
      <ConsentQuestion />
      <ConsentAnswers onChoose={() => tracked.done()} onAnswer={onAnswer} />
    </dialog>
  );
}
