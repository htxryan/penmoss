import { useRef } from 'react';
import { useScrollArea } from '../analytics/scroll';
import { Calendar } from '../journal/Calendar';
import { QuickAccessSection } from '../notes/QuickAccessSection';
import { RecentSection } from '../notes/RecentSection';
import { SourceScope } from '../sources/context';
import { JournalScope } from '../sources/JournalScope';
import { NotebooksSection } from '../sources/NotebooksSection';
import type { Source } from '../sources/registry';
import { SourceSection } from '../sources/SourceSection';
import { TagPane, TagsPageLink } from '../tags/TagPane';
import { SidebarSections } from './sidebar-layout';
import type { SidebarLayout } from './sidebar-layout-state';
import { SidebarShortcuts } from './SidebarShortcuts';

/** Where the window is, as the sidebar marks it: the open note, the graph, the Tags page. */
export interface SidebarPlace {
  /** The note the page shows; its rows are marked as the current page. */
  readonly activeId: string | null;
  /** The note the graph opens around (T17). */
  readonly openNote: string | null;
  readonly graphOpen: boolean;
  readonly tagsOpen: boolean;
}

/** The notebooks' sections: which notebook leads, and the folder new notes go to. */
export interface SidebarNotebooks {
  /** Every notebook, a section each (A828). */
  readonly shown: readonly Source[];
  /** The notebook that takes new notes and answers the tree commands (A862). */
  readonly active: Source;
  /** The notebook last used in the sidebar, and its folder (null: the top level). */
  readonly current: string | null;
  readonly currentFolder: string | null;
  readonly onCurrentFolderChange: (sourceId: string, folderId: string | null) => void;
  readonly onActivate: (sourceId: string) => void;
}

/**
 * The sidebar's body (T36 onwards): its row of shortcuts with New Note first, then its sections
 * in the person's order (T53 item 8, A983), each the app's own component. The main window draws
 * it in its sidebar; Settings → Sidebar draws the same thing in its preview (A1564), inert, so a
 * change there shows exactly as the sidebar will show it.
 */
export function SidebarBody({
  layout,
  place,
  notebooks,
  rail,
}: {
  readonly layout: SidebarLayout;
  readonly place: SidebarPlace;
  readonly notebooks: SidebarNotebooks;
  /** The sidebar is the icon rail (T41): the notebooks' trees are not drawn. */
  readonly rail: boolean;
}) {
  const { activeId } = place;
  // How far down the list is (PEN-175), as `scroll sidebar`.
  const list = useRef<HTMLElement>(null);
  useScrollArea('sidebar', list, null);
  return (
    <>
      <div className="sb-actions">
        {/* New Note first, in the accent, then the shortcuts: one row of icons (T52). */}
        <SidebarShortcuts
          openNote={place.openNote}
          graphOpen={place.graphOpen}
          tagsOpen={place.tagsOpen}
          shownNote={activeId}
        />
      </div>
      <nav ref={list} className="sb-list" aria-label="All notes">
        {/* The sections in the person's order, each hidden or shown (T53 item 8, A983). */}
        <SidebarSections
          layout={layout}
          // The Tags page from the Tags section's title row (PEN-68).
          leads={{ tags: <TagsPageLink current={place.tagsOpen} /> }}
          render={{
            // The pinned notes (T51, A946).
            quickAccess: (tools) => <QuickAccessSection activeId={activeId} tools={tools} />,
            recent: (tools) => (
              <RecentSection activeId={activeId} count={layout.recentCount} tools={tools} />
            ),
            notebooks: (tools) => (
              <NotebooksSection tools={tools}>
                {notebooks.shown.map((source) => (
                  <SourceScope key={source.id} source={source}>
                    <SourceSection
                      source={source}
                      activeId={activeId}
                      currentFolder={
                        notebooks.current === source.id ? notebooks.currentFolder : null
                      }
                      onCurrentFolderChange={(folderId) =>
                        notebooks.onCurrentFolderChange(source.id, folderId)
                      }
                      active={notebooks.active.id === source.id}
                      onActivate={() => notebooks.onActivate(source.id)}
                      shown={!rail}
                    />
                  </SourceScope>
                ))}
              </NotebooksSection>
            ),
            // The Journal notebook's calendar (A827), whichever note is open.
            calendar: (tools) => (
              <JournalScope>
                <Calendar activeId={activeId} tools={tools} />
              </JournalScope>
            ),
            tags: (tools) => (
              <SourceScope source={notebooks.active}>
                <TagPane tools={tools} />
              </SourceScope>
            ),
          }}
        />
      </nav>
    </>
  );
}
