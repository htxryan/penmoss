import { SIDEBAR_SECTION_NAMES, type SidebarSection } from '@penmoss/core/sidebar-layout';
import { Icon } from '@penmoss/ui/icons';
import {
  createContext,
  useContext,
  useState,
  type DragEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { useOnRevealNotebooks } from './reveal-notebooks';
import type { SidebarLayout } from './sidebar-layout-state';

/** The section being dragged, shared by the sections while a drag lasts. */
const DragContext = createContext<{
  readonly dragging: SidebarSection | null;
  readonly setDragging: (id: SidebarSection | null) => void;
}>({ dragging: null, setDragging: () => undefined });

const DRAG_TYPE = 'application/x-penmoss-section';

/**
 * Sections kept mounted, hidden, while turned off: Notebooks' tree registers New Folder, New
 * Notebook and the sort commands, which work from the palette and their keys regardless.
 */
const KEPT_MOUNTED: ReadonlySet<SidebarSection> = new Set(['notebooks']);

/**
 * The shown sections, in order (T53 item 8): each in its own part of the list, the lines between
 * them running edge to edge. A section's title row carries its tools (`render`'s argument): a
 * drag handle and ✕. A section dropped on another goes before or after it, by the half it lands
 * in. A part with nothing in it takes no room.
 */
export function SidebarSections({
  layout,
  render,
  leads,
}: {
  readonly layout: SidebarLayout;
  readonly render: Readonly<Record<SidebarSection, (tools: ReactNode) => ReactNode>>;
  /** A section's own button, first among its tools (the Tags page's, PEN-68). */
  readonly leads?: Partial<Readonly<Record<SidebarSection, ReactNode>>>;
}) {
  const [dragging, setDragging] = useState<SidebarSection | null>(null);
  useOnRevealNotebooks(() => {
    if (layout.hidden.has('notebooks') && layout.canChange) layout.setHidden('notebooks', false);
  });
  const [hint, setHint] = useState<{ id: SidebarSection; after: boolean } | null>(null);
  const place = (event: DragEvent<HTMLElement>, id: SidebarSection) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return { id, after: event.clientY > rect.top + rect.height / 2 };
  };
  return (
    <DragContext.Provider value={{ dragging, setDragging }}>
      {layout.order
        .filter((id) => layout.shown.includes(id) || KEPT_MOUNTED.has(id))
        .map((id) => (
          <div
            key={id}
            hidden={!layout.shown.includes(id)}
            className="sb-part"
            data-section={id}
            data-testid={`sidebar-section-${id}`}
            data-dragging={dragging === id ? '' : undefined}
            data-drop={
              hint?.id === id && dragging !== id ? (hint.after ? 'after' : 'before') : undefined
            }
            onDragOver={(event) => {
              if (!dragging || !event.dataTransfer.types.includes(DRAG_TYPE)) return;
              event.preventDefault();
              event.dataTransfer.dropEffect = 'move';
              const next = place(event, id);
              if (hint?.id !== next.id || hint.after !== next.after) setHint(next);
            }}
            onDragLeave={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setHint(null);
            }}
            onDrop={(event) => {
              if (!dragging) return;
              event.preventDefault();
              const { after } = place(event, id);
              setHint(null);
              setDragging(null);
              if (dragging === id) return;
              const rest = layout.order.filter((each) => each !== dragging);
              layout.move(dragging, rest.indexOf(id) + (after ? 1 : 0));
            }}
          >
            {render[id](
              <SectionTools
                id={id}
                layout={layout}
                lead={leads?.[id]}
                onDragEnd={() => setHint(null)}
              />,
            )}
          </div>
        ))}
    </DragContext.Provider>
  );
}

/**
 * A section's tools on its title row (T53 item 8), shown while the pointer is over the row or
 * focus is in it: a handle to drag it to a new place (or ↑ and ↓ on it, from the keyboard) and
 * ✕ to hide it (Settings → Display shows it again, T62 item 11).
 */
function SectionTools({
  id,
  layout,
  lead,
  onDragEnd,
}: {
  readonly id: SidebarSection;
  readonly layout: SidebarLayout;
  /** The section's own button, before the handle. */
  readonly lead?: ReactNode;
  readonly onDragEnd: () => void;
}) {
  const { setDragging } = useContext(DragContext);
  const name = SIDEBAR_SECTION_NAMES[id];
  if (!layout.canChange) {
    return lead ? (
      <span className="sb-part-tools" data-testid="section-tools">
        {lead}
      </span>
    ) : null;
  }
  const step = (event: KeyboardEvent<HTMLButtonElement>) => {
    const by = event.key === 'ArrowUp' ? -1 : event.key === 'ArrowDown' ? 1 : 0;
    if (by === 0) return;
    event.preventDefault();
    // Past the next section that shows, whatever hidden or empty ones lie between, so every
    // press visibly moves it.
    const showing = layout.shown.filter(
      (each) =>
        each === id ||
        (document.querySelector(`.sb-part[data-section="${each}"]`)?.childElementCount ?? 0) > 0,
    );
    const target = showing[showing.indexOf(id) + by];
    if (!target) return;
    const rest = layout.order.filter((each) => each !== id);
    layout.move(id, rest.indexOf(target) + (by > 0 ? 1 : 0));
    // Moving down moves this section's own element, which loses focus: put it back.
    const grip = event.currentTarget;
    requestAnimationFrame(() => {
      if (!grip.isConnected || document.activeElement === grip) return;
      document
        .querySelector<HTMLElement>(`.sb-part[data-section="${id}"] [data-testid="section-move"]`)
        ?.focus();
    });
  };
  return (
    <span className="sb-part-tools" data-testid="section-tools">
      {lead}
      <button
        type="button"
        className="icon-btn sb-part-grip"
        data-ui="item"
        draggable
        aria-label={`Move ${name}`}
        aria-description="Drag, or press the up or down arrow"
        data-tip={`Drag to Move ${name}`}
        data-testid="section-move"
        onKeyDown={step}
        onDragStart={(event) => {
          event.dataTransfer.setData(DRAG_TYPE, id);
          event.dataTransfer.effectAllowed = 'move';
          const part = event.currentTarget.closest('.sb-part');
          if (part) event.dataTransfer.setDragImage(part, 16, 12);
          setDragging(id);
        }}
        onDragEnd={() => {
          setDragging(null);
          onDragEnd();
        }}
      >
        <Icon name="grip" size={14} />
      </button>
      <button
        type="button"
        className="icon-btn"
        data-ui="item"
        aria-label={`Hide ${name}`}
        data-tip={`Hide ${name}`}
        data-testid="section-hide"
        onClick={() => layout.setHidden(id, true)}
      >
        <Icon name="close" size={14} />
      </button>
    </span>
  );
}
