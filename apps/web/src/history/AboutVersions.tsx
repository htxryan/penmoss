import { Icon } from '@penmoss/ui/icons';
import { useId } from 'react';
import { usePopover } from '../shell/popover';
import { GIT_VERSIONS } from './source';

/** The user docs' page on History, for the ⓘ's Learn More. */
export const HISTORY_DOCS = 'https://penmoss.app/docs/history/#version-history';

/**
 * History's ⓘ, in the note panel's head beside Close (Ryan's review of #192, finding 13): how
 * versions are made, which the panel used to say above its list, and a link to the docs. Opens
 * under the button; Escape, a press outside it or focus leaving it closes it.
 */
export function AboutVersions() {
  const { open, setOpen, button, panel, onPanelKeyDown } = usePopover();
  const id = useId();
  return (
    <span className="history-about">
      <button
        ref={button}
        type="button"
        className="icon-btn"
        data-ui="menu"
        aria-label="About Versions"
        data-tip="About Versions"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        data-testid="history-about"
        onClick={() => setOpen(!open)}
      >
        <Icon name="info" size={16} />
      </button>
      {open ? (
        <div
          ref={panel}
          id={id}
          className="history-about-pop"
          data-testid="history-about-text"
          onKeyDown={onPanelKeyDown}
        >
          <p>{GIT_VERSIONS}</p>
          <a href={HISTORY_DOCS} target="_blank" rel="noreferrer">
            Learn More
          </a>
        </div>
      ) : null}
    </span>
  );
}
