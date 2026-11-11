import { Icon } from '@penmoss/ui/icons';
import { useEffect } from 'react';
import { blockedWindow, useBlockedWindow } from './open';
import { ToastSlot } from '../toasts/ToastSlot';

/** How long the toast stays. */
const BLOCKED_MS = 10_000;

/**
 * The browser blocked a note window (T45, A710): the note opens in a new tab from the toast's
 * link instead, a click of its own that no popup blocker stops.
 */
export function WindowBlockedToast() {
  const blocked = useBlockedWindow();
  useEffect(() => {
    if (!blocked) return;
    const timer = setTimeout(() => {
      if (blockedWindow.get() === blocked) blockedWindow.set(null);
    }, BLOCKED_MS);
    return () => clearTimeout(timer);
  }, [blocked]);
  return (
    <ToastSlot>
      {blocked ? (
        <div className="toast toast-with-action" data-tone="info" data-testid="window-blocked">
          <Icon name="info" />
          <span>The browser blocked the new window.</span>
          <a
            className="toast-action"
            href={blocked.path}
            target="_blank"
            data-ui="item"
            onClick={() => blockedWindow.set(null)}
          >
            Open in a New Tab
          </a>
          <button
            type="button"
            className="toast-close"
            data-ui="dismiss"
            aria-label="Dismiss"
            data-tip="Dismiss"
            onClick={() => blockedWindow.set(null)}
          >
            <Icon name="close" size={16} />
          </button>
        </div>
      ) : null}
    </ToastSlot>
  );
}
