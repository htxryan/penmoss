import { useLayoutEffect, useRef, useState, type CSSProperties, type RefObject } from 'react';
import { PreviewCommands } from '../commands/CommandsRoot';
import { NoteSourceScope } from '../sources/NoteSourceScope';
import { NoteView } from '../notes/NoteView';
import { lastOpenedNote, readOpened } from '../notes/recent';
import { deviceStorage } from '../shell/device-pref';
import { usePaneSize } from '../shell/pane-widths';
import { SidebarBody, type SidebarPlace } from '../shell/SidebarBody';
import { useSidebarLayout } from '../shell/sidebar-layout-state';
import { Home } from '../shell/Home';
import { useNarrowWindow } from '../shell/media';
import { JournalScope } from '../sources/JournalScope';
import { useSourcesState } from '../sources/hooks';
import { useEveryOpenNoteList } from '../sources/lists';

/** The window the preview draws, in rem, before it is scaled to its column: a small one. */
const WINDOW = { width: 64, height: 40 } as const;
/** Without the sidebar (Settings → Note): wide enough for the panel beside the note (60rem). */
const NOTE_ONLY = { width: 62, height: 38 } as const;
/** On a phone: the phone's own screen, the note alone with its app bar, as the app shows it. */
const PHONE = { width: 24, height: 36 } as const;

const ignore = () => undefined;

/**
 * Penmoss itself in miniature (A1564), for Settings → Appearance, the theme editor and Settings →
 * Note: the app's own sidebar (`SidebarBody`) and note view (`NoteView`, in its preview mode) on
 * the note this device opened last, drawn as a window and scaled to the column. Nothing in it is
 * a look-alike, so a theme, a font, a size, a title bar button or a detail under the title shows
 * exactly as the app will show it. It is inert (no click, focus or screen reader reaches it), and
 * its commands are registered apart (`PreviewCommands`), so it never answers a key.
 *
 * The theme editor lays the edited variant's variables over it (`style`); Appearance lays a size
 * being dragged. Settings → Note draws the note alone (`sidebar` false), and on a phone it is the
 * phone's screen: the note with its app bar, the sidebar a closed drawer. With no note yet, it is
 * the app's page for no note open (`Home`).
 */
export function AppPreview({
  style,
  testId = 'app-preview',
  sidebar = true,
  enlarged = false,
}: {
  /** Variables laid over the page's: the theme being edited, or a size being dragged. */
  readonly style?: CSSProperties | undefined;
  readonly testId?: string | undefined;
  /** The sidebar beside the note; Settings → Note draws the note alone. */
  readonly sidebar?: boolean | undefined;
  /**
   * In the larger preview's dialog (A1589): as wide as the dialog, and no taller than the window
   * leaves it, so the whole window shows; at its real size when there is room.
   */
  readonly enlarged?: boolean | undefined;
}) {
  const frame = useRef<HTMLDivElement>(null);
  const phone = useNarrowWindow();
  // A phone's app has no sidebar beside the note: it is a drawer, closed.
  const withSidebar = sidebar && !phone;
  const size = phone ? PHONE : withSidebar ? WINDOW : NOTE_ONLY;
  const zoom = useFitZoom(frame, size.width);
  const noteId = usePreviewNote();
  const [sidebarWidth] = usePaneSize('sidebar');
  return (
    <PreviewCommands>
      <div
        ref={frame}
        className="app-preview"
        style={{
          ...style,
          height: `${size.height * zoom}rem`,
          ...(enlarged
            ? {
                width: `min(100%, ${size.width}rem, calc(var(--preview-zoom-height) * ${size.width / size.height}))`,
                marginInline: 'auto',
              }
            : {}),
        }}
        data-testid={testId}
        inert
        aria-hidden="true"
      >
        <div
          className="notes-app app-preview-window"
          data-preview-note={noteId ?? undefined}
          style={{
            width: `${size.width}rem`,
            height: `${size.height}rem`,
            zoom,
            ...(withSidebar
              ? { '--pm-sidebar-width': `${sidebarWidth}rem` }
              : { gridTemplateColumns: 'minmax(0, 1fr)' }),
          }}
        >
          {withSidebar ? <PreviewSidebar /> : null}
          <main className="note-main">
            {noteId ? (
              <NoteSourceScope id={noteId}>
                <NoteView id={noteId} preview />
              </NoteSourceScope>
            ) : (
              // No note yet: the app's own page for no note open.
              <JournalScope>
                <Home phone={phone} />
              </JournalScope>
            )}
          </main>
        </div>
      </div>
    </PreviewCommands>
  );
}

/** The note the preview shows: the one this device opened last, else the first there is. */
function usePreviewNote(): string | null {
  const list = useEveryOpenNoteList();
  const [opened] = useState(() => readOpened(deviceStorage()));
  return lastOpenedNote(list, opened) ?? list[0]?.id ?? null;
}

/** The scale that fits a window `widthRem` wide to the frame's width, never above 1. */
function useFitZoom(frame: RefObject<HTMLElement | null>, widthRem: number): number {
  const [zoom, setZoom] = useState(0.3);
  useLayoutEffect(() => {
    const element = frame.current;
    if (!element) return;
    const fit = () => {
      const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
      const next = Math.min(1, element.clientWidth / (widthRem * rem));
      if (next > 0) setZoom((was) => (Math.abs(was - next) < 0.001 ? was : next));
    };
    fit();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(fit);
    observer.observe(element);
    return () => observer.disconnect();
  }, [frame, widthRem]);
  return zoom;
}

const NOWHERE: SidebarPlace = { activeId: null, openNote: null, graphOpen: false, tagsOpen: false };

/** The window's sidebar, as the main window draws it (`SidebarBody`). */
function PreviewSidebar() {
  const layout = useSidebarLayout();
  const sources = useSourcesState();
  return (
    <aside className="sidebar">
      <SidebarBody
        layout={layout}
        place={NOWHERE}
        notebooks={{
          shown: sources.all,
          active: sources.journal,
          current: null,
          currentFolder: null,
          onCurrentFolderChange: ignore,
          onActivate: ignore,
        }}
        rail={false}
      />
    </aside>
  );
}
