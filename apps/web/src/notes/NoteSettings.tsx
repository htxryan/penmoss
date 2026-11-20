import {
  METADATA_FIELD_NAMES,
  METADATA_FIELDS,
  STATUS_BAR_FIELDS,
} from '@penmoss/core/note-metadata';
import { Icon } from '@penmoss/ui/icons';
import { useId } from 'react';
import { useKeys } from '../commands/hooks';
import { Kbd } from '../commands/Kbd';
import { AppPreview } from '../theme/AppPreview';
import { PreviewTabs } from '../theme/PreviewTabs';
import { TypeSpecimen } from '../theme/TypeSpecimen';
import { GroupHead, SettingRow, Switch } from '../theme/look-rows';
import { useThemeState } from '../theme/hooks';
import { useNoteMetadataSettings } from './metadata-state';
import { NOTE_BAR_BUTTON_INFO, NOTE_BAR_BUTTONS, useNoteBar } from './note-bar';
import { NOTE_PANEL_MODES, useDefaultPanelMode } from './panel-mode';
import { useFullWidth } from './width';
import { SettingsHeader } from '../pages/SettingsHeader';

/**
 * Settings → Note (PEN-146, the other half of Display, with Note Width and Note Panel from
 * Appearance): how a note is laid out, the buttons its title bar shows (A1134), and the details
 * under its title and in its status bar (T62 item 4), on the Settings tab; the note itself
 * (`AppPreview`, A1564), which redraws with them, on the Preview tab (`PreviewTabs`, A1633). All synced through the Primary Notebook (A827)
 * but Note Panel, which is this device's own (A985).
 */
export function NoteSettings() {
  const id = useId();
  const bar = useNoteBar();
  const metadata = useNoteMetadataSettings();
  return (
    <section
      className="settings-section note-settings lf-page"
      aria-labelledby={`${id}-h`}
      data-testid="note-settings"
    >
      <SettingsHeader
        id={`${id}-h`}
        title="Note"
        intro="How a note is laid out and what its bars show."
      />
      <PreviewTabs
        name="Note"
        testId="note-tabs"
        settings={
          <>
            <GroupHead id={`${id}-layout`}>Layout</GroupHead>
            <div className="lf-group" role="group" aria-labelledby={`${id}-layout`}>
              <NoteWidthSetting name={`${id}-width`} />
              <NotePanelSetting name={`${id}-panel`} />
            </div>

            <GroupHead id={`${id}-bar`} scope>
              Title Bar Buttons
            </GroupHead>
            <div
              className="lf-group lf-group-two"
              role="group"
              aria-labelledby={`${id}-bar`}
              data-setting="title-bar-buttons"
              data-testid="note-bar-settings"
            >
              {NOTE_BAR_BUTTONS.map((button) => {
                const { icon, label, event } = NOTE_BAR_BUTTON_INFO[button];
                return (
                  <SettingRow
                    key={button}
                    setting={kebab(label)}
                    label={
                      <>
                        <Icon name={icon} size={14} />
                        {label}
                      </>
                    }
                    labelFor={`${id}-bar-${button}`}
                  >
                    <Switch
                      id={`${id}-bar-${button}`}
                      checked={bar.shows(button)}
                      disabled={!bar.canChange}
                      data-event={event}
                      data-testid={`display-note-bar-${button}`}
                      onChange={(event) => bar.set(button, event.target.checked)}
                    />
                  </SettingRow>
                );
              })}
            </div>
            <p className="lf-help">Each is also in the note’s ⋯ menu, which always shows.</p>

            <GroupHead id={`${id}-under`} scope>
              Under the Title
            </GroupHead>
            <div
              className="lf-chips"
              role="group"
              aria-labelledby={`${id}-under`}
              data-setting="under-the-title"
              data-testid="metadata-under-title"
            >
              {METADATA_FIELDS.map((field) => (
                <Chip
                  key={field}
                  label={METADATA_FIELD_NAMES[field]}
                  checked={metadata.underTitle.includes(field)}
                  disabled={!metadata.canChange}
                  testId={`metadata-title-${field}`}
                  data-event="settings.note.under-title"
                  onChange={(on) => metadata.setUnderTitle(field, on)}
                />
              ))}
            </div>

            <GroupHead id={`${id}-status`} scope>
              In the Status Bar
            </GroupHead>
            <div
              className="lf-chips"
              role="group"
              aria-labelledby={`${id}-status`}
              data-setting="in-the-status-bar"
              data-testid="metadata-status-bar"
            >
              {STATUS_BAR_FIELDS.map((field) => (
                <Chip
                  key={field}
                  label={METADATA_FIELD_NAMES[field]}
                  checked={metadata.statusBar.includes(field)}
                  disabled={!metadata.canChange}
                  testId={`metadata-status-${field}`}
                  data-event="settings.note.status-bar"
                  onChange={(on) => metadata.setStatusBar(field, on)}
                />
              ))}
            </div>
            <p className="lf-help">
              The status bar shows only what cannot be edited there, so Tags stay under the title or
              in the Metadata tab. The save status always shows at its start.
            </p>
          </>
        }
        preview={
          <>
            <p className="lf-help" data-testid="note-preview-caption">
              A note as the app draws it, with these settings. Change them on Settings.
            </p>
            {/* The note itself (A1564): its title bar, the details under its title, its width,
                its panel as it starts and its status bar, as these settings make them; as large
                as the page allows, since the tab is the larger view (A1633). */}
            <AppPreview sidebar={false} enlarged testId="note-preview" />
            {/* The note's text at its real size: its title, headings, text and code (A1582). */}
            <TypeSpecimen interfaceText={false} testId="note-type-specimen" />
          </>
        }
      />
    </section>
  );
}

/** A label in kebab case, for `data-setting`: "Copy Note as Markdown" → copy-note-as-markdown. */
const kebab = (label: string) =>
  label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

/** A field turned on or off: a checkbox drawn as a chip. */
function Chip({
  label,
  checked,
  disabled,
  testId,
  onChange,
  'data-event': tracked,
}: {
  readonly label: string;
  readonly checked: boolean;
  readonly disabled: boolean;
  readonly testId: string;
  readonly onChange: (on: boolean) => void;
  /** Its tracked id (PEN-137). */
  readonly 'data-event'?: string;
}) {
  return (
    <label className="lf-chip">
      <input
        type="checkbox"
        data-event={tracked ?? 'settings.note.field'}
        checked={checked}
        disabled={disabled}
        data-testid={testId}
        onChange={(event) => onChange(event.target.checked)}
      />
      {checked ? <Icon name="check" size={12} /> : null}
      <span>{label}</span>
    </label>
  );
}

/**
 * Note width (T41, A501): the theme's width, or the whole window. The note's Full Width button,
 * its command and its shortcut change the same setting.
 */
function NoteWidthSetting({ name }: { name: string }) {
  const [full, setFull] = useFullWidth();
  const { theme } = useThemeState();
  const keys = useKeys('note.fullWidth');
  const id = useId();
  const themes = `The Theme’s (${theme.editorWidth} rem)`;
  return (
    <SettingRow
      setting="note-width"
      label="Note Width"
      scope
      labelId={`${id}-l`}
      help={
        <>
          Also the Full Width button above a note
          {keys[0] ? (
            <>
              {' '}
              and <Kbd combo={keys[0]} />
            </>
          ) : null}
          .
        </>
      }
      testId="note-width-setting"
    >
      <div className="seg" role="radiogroup" aria-labelledby={`${id}-l`}>
        <label className="seg-option">
          <input
            type="radio"
            data-event="settings.note.width"
            name={name}
            checked={!full}
            onChange={() => setFull(false)}
          />
          <span className="bold-steady" data-label={themes}>
            {themes}
          </span>
        </label>
        <label className="seg-option">
          <input
            type="radio"
            data-event="settings.note.width"
            name={name}
            checked={full}
            onChange={() => setFull(true)}
          />
          <Icon name="widthFull" size={14} />
          <span className="bold-steady" data-label="Full Window">
            Full Window
          </span>
        </label>
      </div>
    </SettingRow>
  );
}

/**
 * Note Panel (T53 item 9, A985): whether a note's panel starts open or closed until the note's
 * own tab icons open or close it, which each note then remembers. This device's own, so it works
 * signed out too.
 */
function NotePanelSetting({ name }: { name: string }) {
  const [mode, setMode] = useDefaultPanelMode();
  const id = useId();
  return (
    <SettingRow
      setting="note-panel"
      label="Note Panel"
      labelId={`${id}-l`}
      scope
      help="How a note’s panel starts: backlinks, outline, comments and details beside the note. Each note then remembers its own."
      testId="note-panel-setting"
    >
      <div className="seg" role="radiogroup" aria-labelledby={`${id}-l`}>
        {NOTE_PANEL_MODES.map((item) => (
          <label key={item.mode} className="seg-option">
            <input
              type="radio"
              data-event="settings.note.panel-mode"
              name={name}
              value={item.mode}
              checked={mode === item.mode}
              onChange={() => setMode(item.mode)}
            />
            <span className="bold-steady" data-label={item.label}>
              {item.label}
            </span>
          </label>
        ))}
      </div>
    </SettingRow>
  );
}
