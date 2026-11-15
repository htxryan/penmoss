import {
  METADATA_FIELD_NAMES,
  METADATA_FIELDS,
  STATUS_BAR_FIELDS,
  type MetadataField,
} from '@penmoss/core/note-metadata';
import { Icon } from '@penmoss/ui/icons';
import { useId } from 'react';
import { useKeys } from '../commands/hooks';
import { Kbd } from '../commands/Kbd';
import { GroupHead, SettingRow, Switch } from '../theme/look-rows';
import { useThemeState } from '../theme/hooks';
import { useNoteMetadataSettings } from './metadata-state';
import { NOTE_BAR_BUTTON_INFO, NOTE_BAR_BUTTONS, useNoteBar, type NoteBarButton } from './note-bar';
import { NOTE_PANEL_MODES, useDefaultPanelMode, type NotePanelMode } from './panel-mode';
import { useFullWidth } from './width';

/**
 * Settings → Note (PEN-146, the other half of Display, with Note Width and Note Panel from
 * Appearance): how a note is laid out, the buttons its title bar shows (A1134), and the details
 * under its title and in its status bar (T62 item 4), beside a miniature note frame that redraws
 * with them. All synced through the Primary Notebook (A827) but Note Panel, which is this
 * device's own (A985).
 */
export function NoteSettings() {
  const id = useId();
  const bar = useNoteBar();
  const metadata = useNoteMetadataSettings();
  const [full] = useFullWidth();
  const [panel] = useDefaultPanelMode();
  return (
    <section
      className="settings-section note-settings lf-page"
      aria-labelledby={`${id}-h`}
      data-testid="note-settings"
    >
      <h2 id={`${id}-h`}>Note</h2>
      <p>How a note is laid out and what its bars show. Changes sync to your other devices.</p>
      <div className="lf-split lf-split-narrow">
        <div className="lf-controls">
          <GroupHead id={`${id}-layout`}>Layout</GroupHead>
          <div className="lf-group" role="group" aria-labelledby={`${id}-layout`}>
            <NoteWidthSetting name={`${id}-width`} />
            <NotePanelSetting name={`${id}-panel`} />
          </div>

          <GroupHead id={`${id}-bar`}>Title Bar Buttons</GroupHead>
          <div
            className="lf-group lf-group-two"
            role="group"
            aria-labelledby={`${id}-bar`}
            data-setting="title-bar-buttons"
            data-testid="note-bar-settings"
          >
            {NOTE_BAR_BUTTONS.map((button) => {
              const { icon, label } = NOTE_BAR_BUTTON_INFO[button];
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
                    data-testid={`display-note-bar-${button}`}
                    onChange={(event) => bar.set(button, event.target.checked)}
                  />
                </SettingRow>
              );
            })}
          </div>
          <p className="lf-help">Each is also in the note’s ⋯ menu, which always shows.</p>

          <GroupHead id={`${id}-under`}>Under the Title</GroupHead>
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
                onChange={(on) => metadata.setUnderTitle(field, on)}
              />
            ))}
          </div>

          <GroupHead id={`${id}-status`}>In the Status Bar</GroupHead>
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
                onChange={(on) => metadata.setStatusBar(field, on)}
              />
            ))}
          </div>
          <p className="lf-help">
            The status bar shows only what cannot be edited there, so Tags stay under the title or
            in the Metadata tab. The save status always shows at its start.
          </p>
        </div>

        <aside className="lf-preview-col" aria-label="Preview">
          <p className="lf-label">Preview</p>
          <NotePreview
            buttons={NOTE_BAR_BUTTONS.filter((button) => bar.shows(button))}
            underTitle={metadata.underTitle}
            statusBar={metadata.statusBar}
            full={full}
            panel={panel}
          />
        </aside>
      </div>
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
}: {
  readonly label: string;
  readonly checked: boolean;
  readonly disabled: boolean;
  readonly testId: string;
  readonly onChange: (on: boolean) => void;
}) {
  return (
    <label className="lf-chip">
      <input
        type="checkbox"
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
          <input type="radio" name={name} checked={!full} onChange={() => setFull(false)} />
          <span className="bold-steady" data-label={themes}>
            {themes}
          </span>
        </label>
        <label className="seg-option">
          <input type="radio" name={name} checked={full} onChange={() => setFull(true)} />
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

/** What each detail reads as in the preview. */
const SAMPLE: Readonly<Record<MetadataField, string>> = {
  notebook: 'Personal',
  folder: 'Projects',
  created: 'Created 12 Oct',
  edited: 'Edited 4:02 PM',
  tags: '#garden',
  words: '412 words',
  characters: '2,190 characters',
  reading: '2 min',
  tokens: '560 tokens',
};

/** A miniature note frame: its title bar's buttons, title, details, text and status bar. */
function NotePreview({
  buttons,
  underTitle,
  statusBar,
  full,
  panel,
}: {
  readonly buttons: readonly NoteBarButton[];
  readonly underTitle: readonly MetadataField[];
  readonly statusBar: readonly MetadataField[];
  readonly full: boolean;
  readonly panel: NotePanelMode;
}) {
  return (
    <div
      className="lf-preview lf-note-preview"
      data-testid="note-preview"
      data-full={full ? '' : undefined}
      data-panel={panel}
      aria-hidden="true"
    >
      <div className="lf-np-bar">
        {buttons.map((button) => (
          <span key={button} className="lf-np-button" data-button={button}>
            <Icon name={NOTE_BAR_BUTTON_INFO[button].icon} size={12} />
          </span>
        ))}
        <span className="lf-np-button">
          <Icon name="more" size={12} />
        </span>
      </div>
      <div className="lf-np-body">
        <div className="lf-np-page">
          <span className="lf-np-title">Garden Plan</span>
          {underTitle.length ? (
            <span className="lf-np-meta" data-testid="note-preview-under-title">
              {underTitle.map((field) => SAMPLE[field]).join(' · ')}
            </span>
          ) : null}
          <span className="lf-line" />
          <span className="lf-line" />
          <span className="lf-line lf-short" />
          <span className="lf-line" />
          <span className="lf-line lf-short" />
        </div>
        {panel === 'open' ? <span className="lf-np-panel" /> : null}
      </div>
      <div className="lf-np-status" data-testid="note-preview-status-bar">
        {['Saved', ...statusBar.map((field) => SAMPLE[field])].join(' · ')}
      </div>
    </div>
  );
}
