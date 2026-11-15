import { isApplePlatform } from '@penmoss/editor/keys';
import { BrandMark, Icon } from '@penmoss/ui/icons';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { useCommands, useKeys } from '../commands/hooks';
import { NOTE_DRAG_TYPE } from '../notes/note-drag';
import { notePath } from '../router';
import { withKeys } from '../shell/drawer';
import { NotebookBadge } from '../sources/NotebookBadge';
import { AllTabs } from './AllTabs';
import { badgeLook, TAB_DRAG_TYPE } from './look';
import { tabTip, useTabFaces, type TabFace } from './describe';
import { TabMenu } from './TabMenu';
import { useTabs, useTabsState } from './hooks';
import { noteIdOfPath } from './state';

/** A tab's leading mark: its note's notebook badge, or its page's icon. */
export function TabMark({ face }: { readonly face: TabFace }) {
  if (face.kind === 'note') {
    return face.source ? (
      <NotebookBadge source={face.source} size={16} />
    ) : (
      <Icon name="file" size={16} />
    );
  }
  if (face.kind === 'home') return <BrandMark size={16} />;
  const icon =
    face.kind === 'graph'
      ? 'graph'
      : face.kind === 'trash'
        ? 'trash'
        : face.kind === 'tags'
          ? 'hash'
          : face.kind === 'time-machine'
            ? 'history'
            : face.kind === 'settings'
              ? 'gear'
              : 'warning';
  return <Icon name={icon} size={16} />;
}

/**
 * What a tab shows (PEN-140): its pin when pinned, its mark, its title, its notebook's name when
 * two tabs look alike, and × unless pinned. The strip's tabs draw it, and so does the notebook
 * badge's preview in Settings (A1564), so the badge shows there on a tab as it is.
 */
export function TabFaceView({
  face,
  closeTip,
  onClose,
}: {
  readonly face: TabFace;
  readonly closeTip?: string | undefined;
  readonly onClose?: (() => void) | undefined;
}) {
  return (
    <>
      {/* A pinned tab starts with its pin, before the badge, and has no × (ac5). */}
      {face.pinned ? (
        <span className="tab-pin" aria-hidden="true" data-testid="tab-pinned">
          <Icon name="pin" size={12} />
        </span>
      ) : null}
      <span className="tab-mark" aria-hidden="true">
        <TabMark face={face} />
      </span>
      {/* The title shortens first, so a look-alike's notebook name stays readable (AC8). */}
      <span className="tab-title">
        <bdi>{face.title}</bdi>
      </span>
      {face.suffix ? (
        <span className="tab-suffix" data-testid="tab-notebook">
          {'· '}
          <bdi>{face.suffix}</bdi>
        </span>
      ) : null}
      {face.pinned ? null : (
        <span
          className="tab-close"
          aria-hidden="true"
          data-testid="tab-close"
          data-tip={closeTip}
          onClick={(event) => {
            event.stopPropagation();
            onClose?.();
          }}
        >
          <Icon name="close" size={12} />
        </span>
      )}
    </>
  );
}

/**
 * The main window's tab strip (PEN-140, layout A, A1502): the note pane's first row, one tab
 * per open tab, a badge then the title then ×, + after the last, and the note's bar buttons at
 * its right end (`end`, filled by the note on screen). A tablist with a roving tabindex: ← and →
 * move focus, ↩ or Space switch, Delete closes, ⌥← and ⌥→ move the tab. Tabs drag to reorder
 * (within their group), onto Quick Access to pin their note, and a note dragged in from the
 * sidebar opens as a tab where it drops. Past the width, the unpinned tabs scroll sideways and
 * All Tabs lists them all.
 */
export function TabStrip({
  lead,
  onEnd,
}: {
  /** Back, Forward and the pin, when the sidebar is a rail (A1505). */
  readonly lead?: ReactNode;
  /** The element at the strip's right end, for the open note's buttons. */
  readonly onEnd: (element: HTMLElement | null) => void;
}) {
  const tabs = useTabs();
  const state = useTabsState();
  const faces = useTabFaces(state, badgeLook);
  const commands = useCommands();
  const newKeys = useKeys('tab.new');
  const closeKeys = useKeys('tab.close');
  const apple = isApplePlatform();
  const scroller = useRef<HTMLDivElement>(null);
  const [overflow, setOverflow] = useState({ any: false, start: false, end: false });
  const [focusId, setFocusId] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [allOpen, setAllOpen] = useState(false);
  const allButton = useRef<HTMLButtonElement>(null);
  /** Where a dragged tab or note would drop: before the tab at this index. */
  const [drop, setDrop] = useState<number | null>(null);
  const dragging = useRef<string | null>(null);

  const measure = useCallback(() => {
    const element = scroller.current;
    if (!element) return;
    const any = element.scrollWidth > element.clientWidth + 1;
    const start = element.scrollLeft > 1;
    const end = element.scrollLeft + element.clientWidth < element.scrollWidth - 1;
    setOverflow((was) =>
      was.any === any && was.start === start && was.end === end ? was : { any, start, end },
    );
  }, []);
  useLayoutEffect(() => {
    measure();
  });
  useEffect(() => {
    const element = scroller.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [measure]);
  // The active tab is always in view.
  const active = state?.active ?? null;
  useEffect(() => {
    if (!active) return;
    scroller.current
      ?.querySelector<HTMLElement>(`[data-tab-id="${CSS.escape(active)}"]`)
      ?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [active, faces.length]);

  if (!tabs || !state) return null;
  const pinned = faces.filter((face) => face.pinned);
  const unpinned = faces.filter((face) => !face.pinned);
  const roving = focusId && faces.some((face) => face.id === focusId) ? focusId : state.active;

  const focusTab = (id: string) => {
    setFocusId(id);
    requestAnimationFrame(() =>
      document.querySelector<HTMLElement>(`.tab-strip [data-tab-id="${CSS.escape(id)}"]`)?.focus(),
    );
  };

  const onTabKeyDown = (event: KeyboardEvent<HTMLElement>, face: TabFace, index: number) => {
    const key = event.key;
    if (key === 'ContextMenu' || (event.shiftKey && key === 'F10')) {
      event.preventDefault();
      const rect = event.currentTarget.getBoundingClientRect();
      setMenu({ id: face.id, x: rect.left + 8, y: rect.bottom });
      return;
    }
    if ((key === 'ArrowLeft' || key === 'ArrowRight') && event.altKey) {
      event.preventDefault();
      tabs.move(face.id, index + (key === 'ArrowLeft' ? -1 : 1));
      focusTab(face.id);
      return;
    }
    if (key === 'ArrowLeft' || key === 'ArrowRight' || key === 'Home' || key === 'End') {
      event.preventDefault();
      const to =
        key === 'Home'
          ? 0
          : key === 'End'
            ? faces.length - 1
            : (index + (key === 'ArrowLeft' ? -1 : 1) + faces.length) % faces.length;
      focusTab(faces[to]!.id);
      return;
    }
    if (key === 'Enter' || key === ' ') {
      event.preventDefault();
      tabs.activate(face.id);
      return;
    }
    if ((key === 'Delete' || key === 'Backspace') && !face.pinned) {
      event.preventDefault();
      const next = faces[index + 1] ?? faces[index - 1];
      tabs.close(face.id);
      if (next) focusTab(next.id);
    }
  };

  /** The index a drop at the pointer lands before, within the dragged tab's group. */
  const dropIndex = (event: DragEvent<HTMLElement>): number => {
    const items = [
      ...(event.currentTarget.ownerDocument.querySelectorAll<HTMLElement>(
        '.tab-strip [data-tab-id]',
      ) ?? []),
    ];
    for (const [index, item] of items.entries()) {
      const rect = item.getBoundingClientRect();
      if (event.clientX < rect.left + rect.width / 2) return index;
    }
    return items.length;
  };
  const accepts = (event: DragEvent<HTMLElement>) =>
    event.dataTransfer.types.includes(TAB_DRAG_TYPE) ||
    event.dataTransfer.types.includes(NOTE_DRAG_TYPE);
  const onDragOver = (event: DragEvent<HTMLElement>) => {
    if (!accepts(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = dragging.current ? 'move' : 'copy';
    const at = dropIndex(event);
    if (at !== drop) setDrop(at);
  };
  const onDrop = (event: DragEvent<HTMLElement>) => {
    if (!accepts(event)) return;
    event.preventDefault();
    const at = dropIndex(event);
    setDrop(null);
    const tab = dragging.current ?? event.dataTransfer.getData(TAB_DRAG_TYPE);
    dragging.current = null;
    if (tab && state.tabs.some((item) => item.id === tab)) {
      const from = state.tabs.findIndex((item) => item.id === tab);
      tabs.move(tab, at > from ? at - 1 : at);
      return;
    }
    // A note from the sidebar (Notebooks, Recent Notes, Quick Access): a tab where it drops.
    const note = event.dataTransfer.getData(NOTE_DRAG_TYPE);
    if (note) tabs.openAt(notePath(note), at);
  };

  const renderTab = (face: TabFace) => {
    const index = faces.indexOf(face);
    const selected = face.id === state.active;
    const tip = tabTip(face, apple);
    return (
      <div
        key={face.id}
        role="tab"
        className="tab"
        id={`tab-${face.id}`}
        aria-selected={selected}
        aria-controls="tab-panel"
        tabIndex={face.id === roving ? 0 : -1}
        data-tab-id={face.id}
        data-kind={face.kind}
        data-pinned={face.pinned ? '' : undefined}
        data-drop={
          drop === index
            ? 'before'
            : drop === index + 1 && index === faces.length - 1
              ? 'after'
              : undefined
        }
        data-testid="tab"
        data-tip={tip}
        aria-label={`${face.title}${face.suffix ? `, ${face.suffix}` : face.source ? `, ${face.source.name}` : ''}${face.pinned ? ', pinned' : ''}`}
        draggable
        onFocus={() => setFocusId(face.id)}
        onClick={() => tabs.activate(face.id)}
        onAuxClick={(event) => {
          if (event.button !== 1 || face.pinned) return;
          event.preventDefault();
          tabs.close(face.id);
        }}
        onMouseDown={(event) => {
          // A middle click would scroll the page.
          if (event.button === 1) event.preventDefault();
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          setMenu({ id: face.id, x: event.clientX, y: event.clientY });
        }}
        onKeyDown={(event) => onTabKeyDown(event, face, index)}
        onDragStart={(event) => {
          dragging.current = face.id;
          event.dataTransfer.setData(TAB_DRAG_TYPE, face.id);
          const tab = state.tabs.find((item) => item.id === face.id);
          const note = tab ? noteIdOfPath(tab.entries[tab.index]?.path ?? '') : null;
          // Onto Quick Access, a note's tab pins its note (A989).
          if (note) event.dataTransfer.setData(NOTE_DRAG_TYPE, note);
          event.dataTransfer.effectAllowed = 'copyMove';
        }}
        onDragEnd={() => {
          dragging.current = null;
          setDrop(null);
        }}
      >
        <TabFaceView
          face={face}
          closeTip={withKeys('Close Tab', closeKeys)}
          onClose={() => tabs.close(face.id)}
        />
      </div>
    );
  };

  return (
    <div
      className="tab-strip"
      data-testid="tab-strip"
      data-overflow={overflow.any ? '' : undefined}
      onDragOver={onDragOver}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDrop(null);
      }}
      onDrop={onDrop}
    >
      {lead ? (
        <div className="tab-strip-lead" data-testid="note-top-lead">
          {lead}
        </div>
      ) : null}
      <div className="tab-list" role="tablist" aria-label="Open Tabs" data-testid="tab-list">
        {pinned.length > 0 ? (
          <div className="tab-group tab-group-pinned" role="presentation">
            {pinned.map(renderTab)}
          </div>
        ) : null}
        <div
          ref={scroller}
          className="tab-group tab-group-scroll"
          role="presentation"
          data-fade-start={overflow.start ? '' : undefined}
          data-fade-end={overflow.end ? '' : undefined}
          onScroll={measure}
          onWheel={(event) => {
            const element = scroller.current;
            if (!element || Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
            element.scrollLeft += event.deltaY;
          }}
        >
          {unpinned.map(renderTab)}
        </div>
      </div>
      <button
        type="button"
        className="icon-btn tab-new"
        data-command="tab.new"
        aria-label="New Tab"
        data-tip={withKeys('New Tab', newKeys)}
        data-testid="tab-new"
        onClick={() => commands.run('tab.new')}
      >
        <Icon name="plus" size={16} />
      </button>
      {faces.length > 0 ? (
        <button
          ref={allButton}
          type="button"
          className="tab-all"
          data-ui="menu"
          aria-label={`All Tabs, ${faces.length}`}
          aria-haspopup="dialog"
          aria-expanded={allOpen}
          data-tip="Show All Tabs"
          data-testid="tab-all"
          onClick={() => setAllOpen((open) => !open)}
        >
          <Icon name="chevD" size={14} />
          <span>{faces.length}</span>
        </button>
      ) : null}
      <span className="tab-strip-fill" aria-hidden="true" />
      <div className="tab-strip-end" ref={onEnd} />
      {menu ? (
        <TabMenu
          id={menu.id}
          x={menu.x}
          y={menu.y}
          onClose={(giveFocusBack = true) => {
            const id = menu.id;
            setMenu(null);
            if (giveFocusBack && state.tabs.some((tab) => tab.id === id)) focusTab(id);
          }}
        />
      ) : null}
      {allOpen ? (
        <AllTabs
          faces={faces}
          anchor={allButton}
          onClose={() => {
            setAllOpen(false);
            allButton.current?.focus();
          }}
        />
      ) : null}
    </div>
  );
}
