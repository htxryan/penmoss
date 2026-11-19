import { Icon } from '@penmoss/ui/icons';
import { useEffect, useRef, useSyncExternalStore, type KeyboardEvent } from 'react';
import { useCommands } from '../commands/hooks';
import { badgeLook } from './look';
import { TabMark } from './TabStrip';
import { facePath, useTabFaces, type TabFace } from './describe';
import { useTabs, useTabsState } from './hooks';
import { sheet } from './sheet';
import { shownTabCount } from './state';
import { useTrackedDialog } from '../analytics/dialog';

/**
 * The narrow window's tabs (700 px and narrower, AC13, A1502): the strip is hidden, and the app
 * bar's Tabs button, with the count, opens a sheet from the bottom listing them (pinned first,
 * the active one marked, × on the others) and New Tab. It keeps the drawer's focus rules: focus
 * moves in, Escape and the scrim close it, and focus goes back to the button.
 */
export function TabsButton() {
  const tabs = useTabs();
  const state = useTabsState();
  const open = useSyncExternalStore(sheet.subscribe, sheet.get, sheet.get);
  if (!tabs || !state) return null;
  const count = shownTabCount(state);
  return (
    <button
      type="button"
      className="icon-btn tabs-button"
      data-ui="menu"
      aria-label={`Tabs, ${count}`}
      aria-haspopup="dialog"
      aria-expanded={open}
      data-tip="Tabs"
      data-testid="tabs-button"
      onClick={() => sheet.set(true)}
    >
      <span className="tabs-count" aria-hidden="true">
        {count > 99 ? '∞' : count}
      </span>
    </button>
  );
}

/**
 * The sheet itself, once for the window (NotesShell), so it stays open while the note under it
 * changes; closing it gives focus back to the app bar's Tabs button.
 */
export function TabsSheetHost() {
  const open = useSyncExternalStore(sheet.subscribe, sheet.get, sheet.get);
  if (!open) return null;
  return (
    <TabsSheet
      onClose={() => {
        sheet.set(false);
        requestAnimationFrame(() =>
          document.querySelector<HTMLElement>('[data-testid="tabs-button"]')?.focus(),
        );
      }}
    />
  );
}

/** A row's second line: the note's notebook and folders, then "Pinned" for a pinned tab. */
function sheetLine(face: TabFace): string {
  return [facePath(face), face.pinned ? 'Pinned' : ''].filter(Boolean).join(' · ');
}

function TabsSheet({ onClose }: { readonly onClose: () => void }) {
  const tabs = useTabs();
  const state = useTabsState();
  const faces = useTabFaces(state, badgeLook);
  const commands = useCommands();
  const panel = useRef<HTMLDivElement>(null);
  const tracked = useTrackedDialog('tabs');
  useEffect(() => {
    panel.current?.querySelector<HTMLElement>('[aria-current="true"], button')?.focus();
  }, []);
  if (!tabs || !state) return null;
  const ordered = [...faces.filter((face) => face.pinned), ...faces.filter((face) => !face.pinned)];
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    onClose();
  };
  return (
    <>
      <div className="drawer-scrim tabs-scrim" aria-hidden="true" onClick={onClose} />
      <div
        ref={panel}
        className="tabs-sheet"
        role="dialog"
        aria-modal="true"
        aria-label="Tabs"
        data-testid="tabs-sheet"
        onKeyDown={onKeyDown}
      >
        <div className="tabs-sheet-head">
          <h2 data-testid="tabs-sheet-heading">
            {ordered.length === 1 ? '1 Tab' : `${ordered.length} Tabs`}
          </h2>
          <button
            type="button"
            className="icon-btn"
            data-ui="dismiss"
            aria-label="Close Tabs"
            data-tip="Close Tabs"
            onClick={onClose}
          >
            <Icon name="close" />
          </button>
        </div>
        <ul className="tabs-sheet-list">
          {ordered.map((face) => (
            <li key={face.id} className="tabs-sheet-row" data-active={face.active ? '' : undefined}>
              <button
                type="button"
                className="tabs-sheet-tab"
                data-ui="item"
                aria-current={face.active ? 'true' : undefined}
                data-testid="tabs-sheet-tab"
                onClick={() => {
                  tracked.done();
                  tabs.activate(face.id);
                  onClose();
                }}
              >
                {/* A pinned tab starts with its pin, before the badge, as in the strip (ac13). */}
                {face.pinned ? (
                  <span className="tabs-sheet-pin" aria-hidden="true" data-testid="tabs-sheet-pin">
                    <Icon name="pin" size={14} />
                  </span>
                ) : null}
                <span className="tab-mark" aria-hidden="true">
                  <TabMark face={face} />
                </span>
                <span className="tabs-sheet-text">
                  <span className="tabs-sheet-title">
                    <bdi>{face.title}</bdi>
                  </span>
                  {sheetLine(face) ? (
                    <span className="tabs-sheet-path" data-testid="tabs-sheet-path">
                      {sheetLine(face)}
                    </span>
                  ) : null}
                </span>
              </button>
              {face.pinned ? null : (
                <button
                  type="button"
                  className="icon-btn"
                  data-ui="dismiss"
                  aria-label={`Close ${face.title}`}
                  data-testid="tabs-sheet-close"
                  onClick={() => tabs.close(face.id)}
                >
                  <Icon name="close" size={16} />
                </button>
              )}
            </li>
          ))}
        </ul>
        <button
          type="button"
          className="btn tabs-sheet-new"
          data-command="tab.new"
          data-testid="tabs-sheet-new"
          onClick={() => {
            // Closed without giving focus back to the Tabs button: New Tab’s picker takes it.
            sheet.set(false);
            commands.run('tab.new');
          }}
        >
          <Icon name="plus" size={16} />
          New Tab…
        </button>
      </div>
    </>
  );
}
