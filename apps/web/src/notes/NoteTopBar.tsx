/**
 * The note's title row above its text (`header.note-top`): Back and Forward beside the rail, the
 * breadcrumbs and the note's bar buttons (A1134). In the main window, with tabs, the row goes
 * (PEN-140, A1505): the tab names the note and its notebook, so only the buttons stay, at the
 * tab strip's end (`TabStripEnd`), and the folder path moves to the status bar. A note window,
 * with no tabs, keeps the row.
 */
import { Icon } from '@penmoss/ui/icons';
import type { ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useStripEnd } from '../tabs/hooks';
import { NoteActions, type NotePanelTab } from './NoteActions';
import { NoteBarButtonView } from './NoteBarButton';
import { useNoteBar } from './note-bar';

export function NoteTopBar({
  lead,
  nav,
  sourceCrumb,
  trail,
  title,
  actions,
  showSource,
  shownTab,
  pinned,
  fullWidth,
}: {
  /** Back, Forward and the pin, beside the rail (PEN-135 item 6). */
  readonly lead: ReactNode;
  /** In place of the breadcrumbs: a note window's Back and Forward (T45, A710). */
  readonly nav: ReactNode;
  /** The note's notebook, with two or more open (T64 item 5). */
  readonly sourceCrumb: string | null;
  readonly trail: readonly string[];
  readonly title: string;
  /** Before the bar's own buttons: a note window's pin in the Mac app (T46, A720). */
  readonly actions: ReactNode;
  readonly showSource: boolean;
  readonly shownTab: NotePanelTab | null;
  readonly pinned: boolean;
  readonly fullWidth: boolean;
}) {
  const noteBar = useNoteBar();
  const stripEnd = useStripEnd();
  const buttons = (
    <div className="note-actions" data-testid="note-actions">
      {actions}
      {/* The buttons chosen in Settings → Display, each also in ⋯ (A1134). */}
      {noteBar.shown.map((button) => (
        <NoteBarButtonView
          key={button}
          button={button}
          pressed={
            button === 'fullWidth'
              ? fullWidth
              : button === 'toggleSource'
                ? showSource
                : button === 'pinQuickAccess'
                  ? pinned
                  : undefined
          }
          label={
            button === 'fullWidth' && fullWidth
              ? 'Back to the Theme’s Width'
              : button === 'pinQuickAccess' && pinned
                ? 'Unpin from Quick Access'
                : undefined
          }
        />
      ))}
      {/* Comments is a tab of the panel alone since T53 (item 9): no button here. */}
      <NoteActions
        source={showSource}
        tab={shownTab}
        pinned={pinned}
        fullWidth={fullWidth}
        variant="bar"
      />
    </div>
  );
  if (stripEnd) return createPortal(buttons, stripEnd);
  return (
    <header className="note-top">
      {lead ? (
        <div className="note-top-lead" data-testid="note-top-lead">
          {lead}
        </div>
      ) : null}
      {nav ?? (
        <nav className="crumbs" aria-label="Breadcrumb">
          <ol>
            {sourceCrumb !== null ? (
              <li className="crumb-notebook" data-testid="note-source-crumb">
                <Icon name="notebook" size={12} />
                {sourceCrumb}
                <Icon name="chevR" size={12} />
              </li>
            ) : null}
            {trail.map((name, index) => (
              <li key={index}>
                {name}
                <Icon name="chevR" size={12} />
              </li>
            ))}
            <li aria-current="page">{title || 'Untitled'}</li>
          </ol>
        </nav>
      )}
      {buttons}
    </header>
  );
}
