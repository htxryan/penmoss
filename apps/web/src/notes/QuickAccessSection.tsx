import { MAX_QUICK_ACCESS } from '@penmoss/core/quick-access';
import { Icon } from '@penmoss/ui/icons';
import { useId, useRef, useState, type DragEvent, type ReactNode } from 'react';
import { linkHandler, notePath } from '../router';
import { useStoredCollapse } from '../shell/collapsed';
import { ContextMenu } from '../shell/ContextMenu';
import { useSidebarLayout } from '../shell/sidebar-layout-state';
import { displayTitle } from './list';
import { NOTE_DRAG_TYPE } from './note-drag';
import { useQuickAccess, useQuickAccessNotes } from './quick-access';
import { SectionHead } from '../shell/SectionHead';

/** Whether Quick Access is collapsed on this device (T51, A946). */
export const QUICK_ACCESS_COLLAPSED_KEY = 'penmoss.sidebar.quickAccess';

const DRAG_TYPE = 'application/x-penmoss-pin';

/**
 * Quick Access at the top of the sidebar (T51, A946): the pinned notes, in pin order, from any
 * source, each a link to the note. A trashed note drops out without being unpinned. Collapsed or
 * open on this device, with the sections' chevron.
 *
 * T53 item 10: a note's right-click menu (or the context-menu key) has Remove from Quick Access;
 * a note dragged onto another goes before or after it, by the half it lands in (Alt+↑ and Alt+↓
 * move the focused one); Settings → Display may name each note's notebook under its title.
 * Shown with no notes too, and a note dragged in from Notebooks or Recent Notes is pinned (A989): before
 * or after the note it lands on, or last.
 */
export function QuickAccessSection({
  activeId,
  tools,
}: {
  readonly activeId: string | null;
  /** The section's drag handle and ✕ (T53 item 8). */
  readonly tools?: ReactNode;
}) {
  const { quickAccessNotebook } = useSidebarLayout();
  const pinned = useQuickAccessNotes(quickAccessNotebook);
  const quickAccess = useQuickAccess();
  const [collapsed, toggle] = useStoredCollapse(QUICK_ACCESS_COLLAPSED_KEY);
  const [menu, setMenu] = useState<{ x: number; y: number; id: string } | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const [hint, setHint] = useState<{ id: string; after: boolean } | null>(null);
  /** A note from elsewhere is over the section. */
  const [receiving, setReceiving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const list = useRef<HTMLUListElement>(null);
  const id = useId();

  /** Moves `pin` to before or after `target`, among every pin (shown or not). */
  const moveNear = (pin: string, target: string, after: boolean) => {
    if (pin === target) return;
    const rest = quickAccess.ids.filter((each) => each !== pin);
    quickAccess.move(pin, rest.indexOf(target) + (after ? 1 : 0));
  };
  const place = (event: DragEvent<HTMLElement>, target: string) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return { id: target, after: event.clientY > rect.top + rect.height / 2 };
  };
  /** A pin being moved, or a note from Notebooks or Recent Notes to pin. */
  const accepts = (event: DragEvent<HTMLElement>) =>
    quickAccess.canChange &&
    (dragging !== null || event.dataTransfer.types.includes(NOTE_DRAG_TYPE));
  /** Pins the dropped note, before or after `target` (or last); one already pinned moves there. */
  const pinDropped = (
    event: DragEvent<HTMLElement>,
    target: { id: string; after: boolean } | null,
  ) => {
    const note = event.dataTransfer.getData(NOTE_DRAG_TYPE);
    if (!note) return;
    if (!quickAccess.pinned(note) && !quickAccess.toggle(note)) {
      setNotice(
        `Quick Access is full: it holds ${MAX_QUICK_ACCESS} notes. Unpin one to pin this note.`,
      );
      return;
    }
    setNotice(null);
    if (target) moveNear(note, target.id, target.after);
    else quickAccess.move(note, quickAccess.ids.length);
  };
  const endDrop = () => {
    setHint(null);
    setDragging(null);
    setReceiving(false);
  };
  const focusPin = (pin: string) =>
    requestAnimationFrame(() =>
      list.current?.querySelector<HTMLElement>(`[data-note-id="${pin}"]`)?.focus(),
    );
  const closeMenu = () => {
    const pin = menu?.id;
    setMenu(null);
    if (pin) focusPin(pin);
  };

  return (
    <section
      className="sb-section sb-quick"
      aria-labelledby={`${id}-name`}
      data-testid="quick-access"
      data-collapsed={collapsed ? 'true' : undefined}
      data-receiving={receiving ? 'true' : undefined}
      onDragOver={(event) => {
        if (dragging || !accepts(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
        if (!receiving) setReceiving(true);
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          setReceiving(false);
          setHint(null);
        }
      }}
      onDrop={(event) => {
        if (dragging || !accepts(event)) return;
        event.preventDefault();
        pinDropped(event, null);
        endDrop();
      }}
    >
      <SectionHead
        name="Quick Access"
        nameId={`${id}-name`}
        collapsed={collapsed}
        onToggle={toggle}
        controls={`${id}-body`}
        tools={tools}
        hint={
          // On the title's row, so an empty Quick Access costs the sidebar no more than its title.
          pinned.length === 0 ? (
            <span className="sb-section-hint" data-testid="quick-access-empty">
              Drag Here to Pin
            </span>
          ) : undefined
        }
      />
      {collapsed ? null : pinned.length === 0 ? (
        // Open and empty: quiet words in the panel, not a bare gap (feedback of 6 Nov).
        <p id={`${id}-body`} className="sb-quick-empty" data-testid="quick-access-none">
          No notes
        </p>
      ) : (
        <ul ref={list} id={`${id}-body`} className="sb-quick-list" role="list">
          {pinned.map((note, index) => (
            <li
              key={note.id}
              data-dragging={dragging === note.id ? '' : undefined}
              data-drop={
                hint?.id === note.id && dragging !== note.id
                  ? hint.after
                    ? 'after'
                    : 'before'
                  : undefined
              }
              onDragOver={(event) => {
                if (!accepts(event)) return;
                event.preventDefault();
                event.stopPropagation();
                event.dataTransfer.dropEffect = dragging ? 'move' : 'copy';
                if (!dragging && !receiving) setReceiving(true);
                const next = place(event, note.id);
                if (hint?.id !== next.id || hint.after !== next.after) setHint(next);
              }}
              onDragLeave={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget as Node | null))
                  setHint(null);
              }}
              onDrop={(event) => {
                if (!accepts(event)) return;
                event.preventDefault();
                event.stopPropagation();
                if (dragging) moveNear(dragging, note.id, place(event, note.id).after);
                else pinDropped(event, place(event, note.id));
                endDrop();
              }}
            >
              <a
                className="sb-item"
                data-ui="item"
                href={notePath(note.id)}
                draggable={quickAccess.canChange}
                aria-current={note.id === activeId ? 'page' : undefined}
                aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
                data-testid="quick-access-note"
                data-note-id={note.id}
                onClick={linkHandler(notePath(note.id))}
                onContextMenu={(event) => {
                  event.preventDefault();
                  setMenu({ x: event.clientX, y: event.clientY, id: note.id });
                }}
                onKeyDown={(event) => {
                  if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
                    event.preventDefault();
                    const rect = event.currentTarget.getBoundingClientRect();
                    setMenu({ x: rect.left + 16, y: rect.bottom, id: note.id });
                    return;
                  }
                  if (!event.altKey || !quickAccess.canChange) return;
                  const by = event.key === 'ArrowUp' ? -1 : event.key === 'ArrowDown' ? 1 : 0;
                  const target = pinned[index + by];
                  if (by === 0 || !target) return;
                  event.preventDefault();
                  moveNear(note.id, target.id, by > 0);
                  focusPin(note.id);
                }}
                onDragStart={(event) => {
                  event.dataTransfer.setData(DRAG_TYPE, note.id);
                  event.dataTransfer.effectAllowed = 'move';
                  setDragging(note.id);
                }}
                onDragEnd={endDrop}
              >
                <Icon name="file" size={16} />
                <span className="label">
                  <span className="sb-item-title">{displayTitle(note.title)}</span>
                  {note.notebook !== null ? (
                    <span className="sb-item-notebook" data-testid="quick-access-notebook-name">
                      {note.notebook}
                    </span>
                  ) : null}
                </span>
              </a>
            </li>
          ))}
        </ul>
      )}
      {notice ? (
        <p className="list-empty" role="status" data-testid="quick-access-notice">
          {notice}
        </p>
      ) : null}
      {menu ? (
        <ContextMenu
          label={`Quick Access: “${displayTitle(pinned.find((note) => note.id === menu.id)?.title ?? '')}”`}
          x={menu.x}
          y={menu.y}
          onClose={closeMenu}
        >
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            className="menu-item"
            data-ui="item"
            data-testid="quick-access-remove"
            disabled={!quickAccess.canChange}
            onClick={() => {
              const pin = menu.id;
              setMenu(null);
              quickAccess.toggle(pin);
            }}
          >
            <Icon name="pin" />
            <span className="menu-label">Remove from Quick Access</span>
          </button>
        </ContextMenu>
      ) : null}
    </section>
  );
}
