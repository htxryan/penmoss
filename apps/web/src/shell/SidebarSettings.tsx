import type { SidebarItem } from '@penmoss/core/display';
import {
  RECENT_COUNT_MAX,
  RECENT_COUNT_MIN,
  SIDEBAR_SECTION_NAMES,
  type SidebarSection,
} from '@penmoss/core/sidebar-layout';
import { Icon, type IconName } from '@penmoss/ui/icons';
import { useId, type CSSProperties } from 'react';
import { PreviewCommands } from '../commands/CommandsRoot';
import { useSourcesState } from '../sources/hooks';
import { GroupHead, SettingRow, Switch } from '../theme/look-rows';
import { PreviewZoom } from '../theme/PreviewZoom';
import { useSidebarDisplay } from './display';
import { usePaneSize } from './pane-widths';
import { useReorder } from './reorder';
import { SidebarBody, type SidebarPlace } from './SidebarBody';
import { useSidebarLayout, type SidebarLayout } from './sidebar-layout-state';
import { SettingsHeader } from '../pages/SettingsHeader';

const ITEMS: ReadonlyArray<{
  readonly item: SidebarItem;
  readonly label: string;
  readonly icon: IconName;
}> = [
  // The Tags page, after Search (Ryan's review of #193, R2-9).
  { item: 'tags', label: 'Tags', icon: 'hash' },
  { item: 'today', label: 'Today', icon: 'today' },
  { item: 'thisWeek', label: 'This Week', icon: 'week' },
  { item: 'graph', label: 'Graph', icon: 'graph' },
  { item: 'commands', label: 'Commands', icon: 'command' },
];

/** A section's row id for Search Settings. */
const SECTION_SETTING: Readonly<Record<SidebarSection, string>> = {
  quickAccess: 'quick-access',
  recent: 'recent-notes',
  notebooks: 'notebooks',
  calendar: 'calendar',
  tags: 'tags-section',
};

/**
 * Settings → Sidebar (PEN-146, half of what Display was): the shortcuts in the sidebar's row of
 * icons and its collapsed rail (T42, A576; Search always shows), and its sections (T53 item 8,
 * A983): which show, in what order (dragged by a row's handle, or Alt+↑ and Alt+↓, here as in
 * the sidebar), how many notes Recent Notes shows and whether Quick Access names each note's
 * notebook. The sidebar itself beside them (A1564) hides and moves with the switches. Synced
 * through the Primary Notebook (A827).
 */
export function SidebarSettings() {
  const display = useSidebarDisplay();
  const layout = useSidebarLayout();
  const id = useId();
  return (
    <section
      className="settings-section sidebar-settings lf-page"
      aria-labelledby={`${id}-h`}
      data-testid="settings-sidebar"
    >
      <SettingsHeader
        id={`${id}-h`}
        title="Sidebar"
        intro="What the sidebar shows, and in what order."
      />
      <div className="lf-split lf-split-narrow">
        <div className="lf-controls">
          <GroupHead id={`${id}-shortcuts`} scope>
            Shortcuts
          </GroupHead>
          <div
            className="lf-group"
            role="group"
            aria-labelledby={`${id}-shortcuts`}
            data-testid="display-settings"
          >
            <SettingRow
              setting="search"
              label={
                <>
                  <Icon name="search" size={14} />
                  Search
                </>
              }
              help={<span id={`${id}-search`}>Always shown</span>}
            >
              <Switch checked disabled aria-describedby={`${id}-search`} aria-label="Search" />
            </SettingRow>
            {ITEMS.map(({ item, label, icon }) => (
              <SettingRow
                key={item}
                setting={kebab(label)}
                label={
                  <>
                    <Icon name={icon} size={14} />
                    {label}
                  </>
                }
                labelFor={`${id}-${item}`}
              >
                <Switch
                  id={`${id}-${item}`}
                  checked={display.shows(item)}
                  disabled={!display.canChange}
                  data-testid={`display-${item}`}
                  onChange={(event) => display.set(item, event.target.checked)}
                />
              </SettingRow>
            ))}
          </div>
          <p className="lf-help">
            New Note, Settings, Feedback and Trash are always on the sidebar. A hidden shortcut
            still works from its keys and the command palette.
          </p>

          <SectionSettings layout={layout} />
        </div>

        <aside className="lf-preview-col" aria-label="Preview">
          <p className="lf-label">Preview</p>
          <PreviewZoom name="Sidebar" testId="sidebar-preview-zoom">
            {(enlarged) => <SidebarPreview layout={layout} enlarged={enlarged} />}
          </PreviewZoom>
        </aside>
      </div>
    </section>
  );
}

const kebab = (label: string) => label.toLowerCase().replace(/[^a-z0-9]+/g, '-');

/** The sections, in the sidebar's order, each with its switch and its own options. */
function SectionSettings({ layout }: { readonly layout: SidebarLayout }) {
  const id = useId();
  const reorder = useReorder({
    ids: layout.order,
    type: 'application/x-penmoss-settings-section',
    disabled: !layout.canChange,
    onMove: (section, index) => layout.move(section, index),
    describe: (section, index, total) =>
      `${SIDEBAR_SECTION_NAMES[section]} moved to ${index + 1} of ${total}.`,
  });
  return (
    <>
      <GroupHead id={`${id}-h`} scope hint="Drag, or Alt+↑ and Alt+↓, to reorder">
        Sections
      </GroupHead>
      <ol
        className="lf-group lf-reorder"
        aria-labelledby={`${id}-h`}
        data-testid="section-settings"
      >
        {layout.order.map((section, index) => {
          const name = SIDEBAR_SECTION_NAMES[section];
          return (
            <li key={section} className="lf-reorder-item" {...reorder.rowProps(section)}>
              <SettingRow
                setting={SECTION_SETTING[section]}
                label={name}
                labelFor={`${id}-${section}`}
                lead={
                  <button
                    type="button"
                    className="icon-btn lf-grip"
                    data-ui="item"
                    aria-label={`Move ${name}, ${index + 1} of ${layout.order.length}`}
                    aria-description="Drag, or press Alt and the up or down arrow"
                    data-tip={`Drag to Move ${name}`}
                    data-testid={`display-section-move-${section}`}
                    disabled={!layout.canChange}
                    {...reorder.handleProps(section)}
                  >
                    <Icon name="grip" size={14} />
                  </button>
                }
                help={
                  section === 'quickAccess' ? (
                    <QuickAccessNotebook layout={layout} />
                  ) : section === 'recent' ? (
                    `Shows ${layout.recentCount} ${layout.recentCount === 1 ? 'note' : 'notes'}`
                  ) : undefined
                }
              >
                {section === 'recent' ? <RecentCount layout={layout} /> : null}
                <Switch
                  id={`${id}-${section}`}
                  checked={!layout.hidden.has(section)}
                  disabled={!layout.canChange}
                  data-testid={`display-section-${section}`}
                  onChange={(event) => layout.setHidden(section, !event.target.checked)}
                />
              </SettingRow>
            </li>
          );
        })}
      </ol>
      <p className="sr-only" role="status" data-testid="section-move-said">
        {reorder.said}
      </p>
    </>
  );
}

/** Show Notebook Names, under Quick Access (A984). */
function QuickAccessNotebook({ layout }: { readonly layout: SidebarLayout }) {
  return (
    <label className="lf-suboption" data-setting="show-notebook-names">
      <input
        type="checkbox"
        checked={layout.quickAccessNotebook}
        disabled={!layout.canChange}
        data-testid="quick-access-notebook"
        onChange={(event) => layout.setQuickAccessNotebook(event.target.checked)}
      />
      <span>Show Notebook Names</span>
    </label>
  );
}

/** How many notes Recent Notes shows, 1 to 50, a − and + stepper as on Android. */
function RecentCount({ layout }: { readonly layout: SidebarLayout }) {
  const count = layout.recentCount;
  const step = (by: number) =>
    layout.setRecentCount(Math.min(RECENT_COUNT_MAX, Math.max(RECENT_COUNT_MIN, count + by)));
  return (
    <span className="lf-stepper" role="group" aria-label="Notes in Recent Notes">
      <button
        type="button"
        className="btn quiet"
        data-ui="item"
        aria-label="Fewer Recent Notes"
        data-tip="Fewer"
        data-testid="recent-count-fewer"
        disabled={!layout.canChange || count <= RECENT_COUNT_MIN}
        onClick={() => step(-1)}
      >
        <Icon name="minus" size={14} />
      </button>
      <output className="lf-stepper-value" aria-live="polite" data-testid="recent-count">
        {count}
      </output>
      <button
        type="button"
        className="btn quiet"
        data-ui="item"
        aria-label="More Recent Notes"
        data-tip="More"
        data-testid="recent-count-more"
        disabled={!layout.canChange || count >= RECENT_COUNT_MAX}
        onClick={() => step(1)}
      >
        <Icon name="plus" size={14} />
      </button>
    </span>
  );
}

/** Nowhere in particular: no note open, nor the graph nor Tags. */
const NOWHERE: SidebarPlace = { activeId: null, openNote: null, graphOpen: false, tagsOpen: false };

const ignore = () => undefined;

/** The preview column's width (`.lf-split-narrow`). */
const PREVIEW_REM = 16;

/**
 * The sidebar itself (A1564): the main window's `SidebarBody`, New Note, the shortcuts and the
 * sections in order with their notes, notebooks, calendar and tags, as this device's settings
 * show it, at the sidebar's own width, scaled to the column. Inert: nothing in it can be clicked,
 * focused or read out, and its commands are registered apart (`PreviewCommands`).
 */
function SidebarPreview({
  layout,
  enlarged = false,
}: {
  readonly layout: SidebarLayout;
  /** In the larger preview's dialog (A1589): at the sidebar's real size. */
  readonly enlarged?: boolean;
}) {
  const sources = useSourcesState();
  const [width] = usePaneSize('sidebar');
  return (
    <PreviewCommands>
      <div
        className={
          enlarged ? 'lf-preview lf-sidebar-preview large' : 'lf-preview lf-sidebar-preview'
        }
        data-testid={enlarged ? 'sidebar-preview-large' : 'sidebar-preview'}
        style={{ '--lf-sidebar-width': `${width}rem` } as CSSProperties}
        inert
        aria-hidden="true"
      >
        {/* Its own width, scaled to the 16rem column: the shortcuts fit as they do there. */}
        <div className="sidebar" style={{ zoom: enlarged ? 1 : Math.min(1, PREVIEW_REM / width) }}>
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
        </div>
      </div>
    </PreviewCommands>
  );
}
