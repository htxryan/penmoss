import type { SidebarItem } from '@penmoss/core/display';
import { Select } from '@penmoss/ui/controls/Select';
import { Icon, type IconName } from '@penmoss/ui/icons';
import { TOOLTIP_DELAY_CHOICES } from '@penmoss/core/tooltips';
import {
  RECENT_COUNT_MAX,
  RECENT_COUNT_MIN,
  SIDEBAR_SECTION_NAMES,
} from '@penmoss/core/sidebar-layout';
import {
  METADATA_FIELD_NAMES,
  METADATA_FIELDS,
  STATUS_BAR_FIELDS,
} from '@penmoss/core/note-metadata';
import { useId, useState } from 'react';
import { useNoteMetadataSettings } from '../notes/metadata-state';
import { NOTE_BAR_BUTTON_INFO, NOTE_BAR_BUTTONS, useNoteBar } from '../notes/note-bar';
import { MenuBarIconSetting } from '../desktop/MenuBarIconSetting';
import { useSidebarDisplay } from './display';
import { useSidebarLayout } from './sidebar-layout-state';
import { useTooltipDelay } from './tooltip-state';

const ITEMS: ReadonlyArray<{
  readonly item: SidebarItem;
  readonly label: string;
  readonly icon: IconName;
}> = [
  { item: 'today', label: 'Today', icon: 'today' },
  { item: 'thisWeek', label: 'This Week', icon: 'week' },
  { item: 'graph', label: 'Graph', icon: 'graph' },
  { item: 'commands', label: 'Commands', icon: 'command' },
];

/**
 * Settings → Display (T42, #104 item 7, A576): which shortcuts the sidebar and its collapsed
 * rail show. Today, This week, Graph and Commands may each be hidden; Search always shows.
 * Synced like the theme, so the choice follows Ryan to every device.
 */
export function DisplaySettings() {
  const { shows, set, canChange } = useSidebarDisplay();
  const id = useId();
  return (
    <section
      className="settings-section"
      aria-labelledby={`${id}-h`}
      data-testid="display-settings"
    >
      <h2 id={`${id}-h`}>Display</h2>
      <p>
        Choose the shortcuts in the sidebar&rsquo;s row of icons under New Note, and in its column
        when the sidebar is collapsed. A hidden one still works from its keys and the command
        palette. Changes sync to your other devices.
      </p>
      <fieldset className="display-toggles" aria-describedby={`${id}-help`}>
        <legend>Show in the sidebar</legend>
        <label className="display-toggle" data-locked="">
          <input type="checkbox" checked disabled aria-describedby={`${id}-search`} />
          <Icon name="search" />
          <span>Search</span>
          <span id={`${id}-search`} className="muted">
            Always shown
          </span>
        </label>
        {ITEMS.map(({ item, label, icon }) => (
          <label key={item} className="display-toggle">
            <input
              type="checkbox"
              checked={shows(item)}
              disabled={!canChange}
              data-testid={`display-${item}`}
              onChange={(event) => set(item, event.target.checked)}
            />
            <Icon name={icon} />
            <span>{label}</span>
          </label>
        ))}
      </fieldset>
      <p id={`${id}-help`} className="muted settings-help">
        New Note, Settings, Feedback and Trash are always on the sidebar.
      </p>
      <SectionSettings />
      <NoteBarSettings />
      <TooltipSettings />
      <MetadataSettings />
      {/* The Mac app only (T51, A945): this Mac's own preference, not synced. */}
      <MenuBarIconSetting />
    </section>
  );
}

/**
 * The sidebar's sections (T53 items 8 and 10, A983): which show (as their ✕ and the sidebar's ⋯
 * menu do), in the order they are dragged into; how many notes Recent Notes shows; and whether
 * Quick Access names each note's notebook. Synced like the shortcuts above.
 */
function SectionSettings() {
  const layout = useSidebarLayout();
  const id = useId();
  // What is typed, until it is a count the setting takes.
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <>
      <fieldset className="display-toggles" data-testid="section-settings">
        <legend>Sections, in the sidebar&rsquo;s order</legend>
        {layout.order.map((section) => (
          <label key={section} className="display-toggle">
            <input
              type="checkbox"
              checked={!layout.hidden.has(section)}
              disabled={!layout.canChange}
              data-testid={`display-section-${section}`}
              onChange={(event) => layout.setHidden(section, !event.target.checked)}
            />
            <span>{SIDEBAR_SECTION_NAMES[section]}</span>
          </label>
        ))}
      </fieldset>
      <p className="muted settings-help">
        Drag a section by the handle on its title to move it, or hide it with its &#x2715;.
      </p>
      <label className="settings-field" htmlFor={`${id}-recent`}>
        <span>Notes in Recent Notes</span>
        <input
          id={`${id}-recent`}
          type="number"
          className="input settings-count"
          inputMode="numeric"
          min={RECENT_COUNT_MIN}
          max={RECENT_COUNT_MAX}
          step={1}
          value={draft ?? String(layout.recentCount)}
          disabled={!layout.canChange}
          data-testid="recent-count"
          onChange={(event) => {
            const text = event.target.value;
            const count = Number(text);
            if (Number.isInteger(count) && count >= RECENT_COUNT_MIN && count <= RECENT_COUNT_MAX) {
              layout.setRecentCount(count);
              setDraft(null);
            } else {
              setDraft(text);
            }
          }}
          onBlur={() => setDraft(null)}
        />
      </label>
      <label className="display-toggle">
        <input
          type="checkbox"
          checked={layout.quickAccessNotebook}
          disabled={!layout.canChange}
          data-testid="quick-access-notebook"
          onChange={(event) => layout.setQuickAccessNotebook(event.target.checked)}
        />
        <span>Show Notebook Names in Quick Access</span>
      </label>
    </>
  );
}

/**
 * Pinned metadata (T62 item 4): which of a note's details show under its title (any, Tags with
 * its + included), and which in the status bar along its bottom (read-only ones only). Synced
 * like the sections above.
 */
function MetadataSettings() {
  const metadata = useNoteMetadataSettings();
  return (
    <>
      <fieldset className="display-toggles" data-testid="metadata-under-title">
        <legend>Note Metadata Under the Title</legend>
        {METADATA_FIELDS.map((field) => (
          <label key={field} className="display-toggle">
            <input
              type="checkbox"
              checked={metadata.underTitle.includes(field)}
              disabled={!metadata.canChange}
              data-testid={`metadata-title-${field}`}
              onChange={(event) => metadata.setUnderTitle(field, event.target.checked)}
            />
            <span>{METADATA_FIELD_NAMES[field]}</span>
          </label>
        ))}
      </fieldset>
      <fieldset className="display-toggles" data-testid="metadata-status-bar">
        <legend>Note Metadata in the Status Bar</legend>
        {STATUS_BAR_FIELDS.map((field) => (
          <label key={field} className="display-toggle">
            <input
              type="checkbox"
              checked={metadata.statusBar.includes(field)}
              disabled={!metadata.canChange}
              data-testid={`metadata-status-${field}`}
              onChange={(event) => metadata.setStatusBar(field, event.target.checked)}
            />
            <span>{METADATA_FIELD_NAMES[field]}</span>
          </label>
        ))}
      </fieldset>
      <p className="muted settings-help">
        The status bar shows only what cannot be edited there, so Tags stay under the title or in
        the Metadata tab. The save status always shows at its start.
      </p>
    </>
  );
}

/**
 * The note title bar's buttons (Quanta feedback 3, item 5; A1134): which of the ⋯ menu's
 * actions also show as a button at the bar's end. ⋯ itself always shows.
 */
function NoteBarSettings() {
  const { shows, set, canChange } = useNoteBar();
  return (
    <>
      <fieldset className="display-toggles" data-testid="note-bar-settings">
        <legend>Buttons in the note&rsquo;s title bar</legend>
        {NOTE_BAR_BUTTONS.map((button) => {
          const { icon, label } = NOTE_BAR_BUTTON_INFO[button];
          return (
            <label key={button} className="display-toggle">
              <input
                type="checkbox"
                checked={shows(button)}
                disabled={!canChange}
                data-testid={`display-note-bar-${button}`}
                onChange={(event) => set(button, event.target.checked)}
              />
              <Icon name={icon} />
              <span>{label}</span>
            </label>
          );
        })}
      </fieldset>
      <p className="muted settings-help">
        Each is also in the note&rsquo;s &#x22EF; menu, which always shows.
      </p>
    </>
  );
}

/**
 * Show Tooltips After (PEN-70, A1247): how long the mouse rests on a control before its
 * tooltip shows, or Never. Keyboard focus shows a tooltip at once whatever it says. Synced like
 * the rest of Display.
 */
function TooltipSettings() {
  const { choice, set, canChange } = useTooltipDelay();
  const id = useId();
  return (
    <>
      <label className="settings-field" htmlFor={id}>
        <span>Show Tooltips After</span>
        <Select
          id={id}
          className="settings-choice"
          value={String(choice)}
          disabled={!canChange}
          aria-describedby={`${id}-help`}
          data-testid="tooltip-delay"
          onChange={(event) => {
            const picked = TOOLTIP_DELAY_CHOICES.find(
              (each) => String(each.value) === event.target.value,
            );
            if (picked) set(picked.value);
          }}
        >
          {TOOLTIP_DELAY_CHOICES.map(({ value, label }) => (
            <option key={value} value={String(value)}>
              {label}
            </option>
          ))}
        </Select>
      </label>
      <p id={`${id}-help`} className="muted settings-help" data-testid="tooltip-delay-help">
        How long the pointer rests on a button before its name shows. Tabbing to a button shows it
        at once. Changes sync to your other devices.
      </p>
    </>
  );
}
