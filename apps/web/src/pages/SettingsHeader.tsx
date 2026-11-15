import { Icon } from '@penmoss/ui/icons';
import {
  createContext,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';
import { gitNotebookPath, linkHandler } from '../router';
import { useTooltipDelay } from '../shell/tooltip-state';
import { usePopover } from '../shell/popover';
import { useSourcesState } from '../sources/hooks';
import { thisDevice } from '../theme/device-only';

/**
 * Every Settings page's header (Ryan's chosen design, A1560): a small "Settings" with an (i) that
 * says where settings are kept, the page's title large, and one line under it. Once the title has
 * scrolled out of sight the row with "Settings (i)" stays pinned at the top of the content column
 * and the title joins it, small, after a slash, with a hairline and a soft shadow; the line under
 * the title scrolls away. One component for every page, the search results too.
 *
 * It renders the pinned row and the title as siblings, so the row sticks for the whole page (a
 * sticky element sticks only within its parent): put it first in the page's own element.
 */
export function SettingsHeader({
  id,
  title,
  barTitle,
  intro,
  beside,
  actions,
  live = false,
}: {
  /** The title's id, which the page's `aria-labelledby` names. */
  readonly id: string;
  readonly title: ReactNode;
  /** The title in the pinned row, when `title` is more than words (a notebook's badge). */
  readonly barTitle?: string | undefined;
  /** One line about the page, under its title. */
  readonly intro?: ReactNode | undefined;
  /** Just after the title, outside the heading: a notebook's Primary chip. */
  readonly beside?: ReactNode | undefined;
  /** At the title's row's end: a page's own buttons (Add Notebook…, Sync Now). */
  readonly actions?: ReactNode | undefined;
  /** The intro changes as the person types (Search's count): read out when it does. */
  readonly live?: boolean | undefined;
}) {
  const titleRef = useRef<HTMLHeadingElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const pinned = usePinned(titleRef, barRef);
  return (
    <>
      <div
        ref={barRef}
        className="settings-head-bar"
        data-pinned={pinned ? '' : undefined}
        data-testid="settings-head-bar"
      >
        <span className="settings-head-root">Settings</span>
        <SettingsInfo />
        {/* The title again, for the eye only: the heading below is the page's name. */}
        <span className="settings-head-crumb" aria-hidden="true" data-testid="settings-head-crumb">
          <span className="settings-head-slash">/</span>
          {barTitle ?? title}
        </span>
      </div>
      <div className="settings-head">
        <div className="settings-head-row">
          <h1 ref={titleRef} id={id} className="settings-head-title" data-testid="settings-title">
            {title}
          </h1>
          {beside}
          {actions ? <div className="settings-head-actions">{actions}</div> : null}
        </div>
        {intro ? (
          <p
            className="settings-head-intro"
            data-testid="settings-intro"
            aria-live={live ? 'polite' : undefined}
          >
            {intro}
          </p>
        ) : null}
      </div>
    </>
  );
}

/**
 * Whether the title has gone under the pinned row: an IntersectionObserver on the title, its top
 * edge moved down to the row's bottom, wherever the page scrolls (the content column, or the
 * window on a phone). Watched again when the window changes size, as the row's place may move.
 */
function usePinned(
  title: RefObject<HTMLElement | null>,
  bar: RefObject<HTMLElement | null>,
): boolean {
  const [pinned, setPinned] = useState(false);
  const [size, setSize] = useState(0);
  useEffect(() => {
    const onResize = () => setSize((count) => count + 1);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  useEffect(() => {
    void size;
    const heading = title.current;
    const row = bar.current;
    if (!heading || !row || typeof IntersectionObserver === 'undefined') return;
    const top = Math.max(0, Math.round(stuckBottom(row)));
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry) return;
        // Out of sight above the row, not below the window's foot.
        setPinned(!entry.isIntersecting && entry.boundingClientRect.top < top);
      },
      { rootMargin: `-${top}px 0px 0px 0px`, threshold: 0 },
    );
    observer.observe(heading);
    return () => observer.disconnect();
  }, [title, bar, size]);
  return pinned;
}

/** Where the pinned row's foot is in the window while it is stuck: its scroller's top, plus its own. */
function stuckBottom(row: HTMLElement): number {
  let scroller = row.parentElement;
  while (scroller && !/(auto|scroll)/.test(getComputedStyle(scroller).overflowY)) {
    scroller = scroller.parentElement;
  }
  const base = scroller ? scroller.getBoundingClientRect().top : 0;
  return base + (parseFloat(getComputedStyle(row).top) || 0) + row.offsetHeight;
}

/** What the (i) needs from the app: the primary notebook, and how long a tooltip waits. */
interface SettingsHome {
  readonly name: string;
  readonly path: string;
  /** The tooltip delay in milliseconds, or null for Never (A1247). */
  readonly delay: number | null;
}

const SettingsHomeContext = createContext<SettingsHome | null>(null);

/**
 * Settings' pages in the app, where the (i) names the primary notebook (SettingsPage puts them
 * in it). A page drawn alone, as a unit test draws one, says "your primary notebook" unnamed.
 */
export function SettingsHomeProvider({ children }: { readonly children: ReactNode }) {
  const state = useSourcesState();
  const { delay } = useTooltipDelay();
  const home: SettingsHome = {
    name: state.journal.name,
    path: gitNotebookPath(state.journal.id),
    delay,
  };
  return <SettingsHomeContext.Provider value={home}>{children}</SettingsHomeContext.Provider>;
}

/**
 * The (i) after "Settings": where settings are kept, the primary notebook's name a link to its
 * page, and what the laptop marks (A1559). It shows on hover (after the tooltip delay) and on
 * keyboard focus, and stays while the pointer or focus is on it or on its words, so the link can
 * be reached; a click keeps it open until Escape, a click elsewhere or focus leaving it. Its
 * words are also the button's description.
 */
export function SettingsInfo() {
  const home = useContext(SettingsHomeContext);
  const delay = home ? home.delay : 1000;
  const { open, setOpen, button, panel, close, onPanelKeyDown } = usePopover();
  const id = useId();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wrap = useRef<HTMLSpanElement>(null);
  /** Opened by a click: it stays when the pointer leaves, until a second click or Escape. */
  const held = useRef(false);
  /** Escape in the words gives focus back to the (i), which must not open them again. */
  const returning = useRef(false);
  useEffect(() => {
    if (!open) held.current = false;
  }, [open]);
  const clear = () => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  };
  useEffect(() => clear, []);
  const showSoon = () => {
    clear();
    if (delay === null) return;
    timer.current = setTimeout(() => setOpen(true), delay);
  };
  const hideSoon = () => {
    clear();
    // A moment to cross from the button to the words.
    timer.current = setTimeout(() => {
      if (!held.current && !wrap.current?.contains(document.activeElement)) setOpen(false);
    }, 200);
  };
  return (
    <span
      ref={wrap}
      className="settings-info"
      onPointerEnter={(event) => {
        if (event.pointerType === 'mouse') showSoon();
      }}
      onPointerLeave={(event) => {
        if (event.pointerType === 'mouse') hideSoon();
      }}
    >
      <button
        ref={button}
        type="button"
        className="icon-btn settings-info-button"
        data-ui="item"
        aria-label="About Settings"
        aria-describedby={`${id}-tip`}
        aria-expanded={open}
        aria-controls={`${id}-tip`}
        data-testid="settings-info"
        onFocus={(event) => {
          if (returning.current) returning.current = false;
          else if (event.currentTarget.matches(':focus-visible')) setOpen(true);
        }}
        onClick={() => {
          clear();
          const next = !(open && held.current);
          held.current = next;
          setOpen(next);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && open) {
            event.preventDefault();
            close(false);
          }
        }}
      >
        <Icon name="info" size={16} />
      </button>
      <div
        ref={panel}
        id={`${id}-tip`}
        className="settings-info-tip"
        role="note"
        hidden={!open}
        data-testid="settings-home"
        onKeyDown={(event) => {
          if (event.key === 'Escape') returning.current = true;
          onPanelKeyDown(event);
        }}
      >
        Settings are synced through your primary notebook
        {home ? (
          <>
            ,{' '}
            <a
              href={home.path}
              data-ui="item"
              // Named apart from "← Notes" when the notebook is called Notes.
              aria-label={`${home.name}, your primary notebook`}
              onClick={(event) => {
                close(false);
                linkHandler(home.path)(event);
              }}
              data-testid="settings-home-link"
            >
              {home.name}
            </a>
          </>
        ) : null}
        . Those marked{' '}
        <span className="settings-info-laptop" role="img" aria-label="with a laptop">
          <Icon name="laptop" size={14} />
        </span>{' '}
        stay on {thisDevice()} only.
      </div>
    </span>
  );
}
