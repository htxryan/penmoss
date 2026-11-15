import { Icon } from '@penmoss/ui/icons';
import type { ReactNode, Ref } from 'react';
import type { ToastTone } from './toasts';

/**
 * A toast with controls (Undo, Open, Install and Restart…) and a Dismiss button, the parts every
 * such toast has: render it inside a `ToastSlot`, so it takes its place in the window's one stack
 * (PEN-63). With `onHold`, it says when it is pointed at or holds focus, so its timer can wait
 * (A524: a keyboard user has no time limit); Escape in it dismisses it.
 */
export function ActionToast({
  tone,
  testId,
  icon,
  children,
  actions,
  onDismiss,
  dismissTestId,
  onHold,
  toastRef,
}: {
  readonly tone: ToastTone;
  readonly testId: string;
  /** Its glyph, before the text. */
  readonly icon: ReactNode;
  /** What it says. */
  readonly children: ReactNode;
  /** Its buttons or link, before Dismiss. */
  readonly actions?: ReactNode;
  /** Dismiss's click (and Escape's, with `onHold`); no Dismiss button without it. */
  readonly onDismiss?: (() => void) | undefined;
  readonly dismissTestId?: string;
  readonly onHold?: (held: boolean) => void;
  readonly toastRef?: Ref<HTMLDivElement>;
}) {
  const hold = onHold
    ? {
        onPointerEnter: () => onHold(true),
        onPointerLeave: () => onHold(false),
        onFocus: () => onHold(true),
        onBlur: (event: React.FocusEvent<HTMLDivElement>) => {
          if (!event.currentTarget.contains(event.relatedTarget)) onHold(false);
        },
        onKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => {
          if (event.key === 'Escape') {
            event.stopPropagation();
            onDismiss?.();
          }
        },
      }
    : {};
  return (
    <div
      ref={toastRef}
      className="toast toast-with-action"
      data-tone={tone}
      data-testid={testId}
      {...hold}
    >
      {icon}
      <span className="toast-text">{children}</span>
      {actions}
      {onDismiss ? (
        <button
          type="button"
          className="toast-close"
          data-ui="dismiss"
          aria-label="Dismiss"
          onClick={onDismiss}
          data-testid={dismissTestId}
        >
          <Icon name="close" size={14} />
        </button>
      ) : null}
    </div>
  );
}
