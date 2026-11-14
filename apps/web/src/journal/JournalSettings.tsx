import { DEFAULT_TIME_ZONE, type PeriodKind } from '@penmoss/core/periodic';
import { Icon } from '@penmoss/ui/icons';
import { Select } from '@penmoss/ui/controls/Select';
import { useId, useState } from 'react';
import { DESTINATION_SETTING, destinationOf, type CaptureDestination } from '../capture/save';
import { useWorkspace, useWorkspaceState } from '../workspace/hooks';
import { TIME_ZONE_SETTING, templateOf, templateSetting, timeZoneOf, today } from './journal';

/** Every IANA zone this browser knows, or the default alone where it cannot list them. */
function timeZones(): string[] {
  const intl = Intl as unknown as { supportedValuesOf?: (key: string) => string[] };
  const zones = intl.supportedValuesOf?.('timeZone') ?? [];
  return zones.includes(DEFAULT_TIME_ZONE) ? zones : [DEFAULT_TIME_ZONE, ...zones];
}

/** Where Quick Capture starts (T51 item 19, A947), in the order Settings offers them. */
const CAPTURE_DESTINATIONS: ReadonlyArray<{
  readonly value: CaptureDestination;
  readonly label: string;
}> = [
  { value: 'daily', label: 'Today’s Note' },
  { value: 'inbox', label: 'New Note in Inbox' },
];

/**
 * Settings → Daily Notes (T19): the time zone that decides which day "today"
 * is (synced, so every device agrees; America/Chicago by default), the
 * daily and weekly templates (markdown with placeholders), and where Quick
 * Capture starts (T51 item 19, A947). Changing a template affects notes
 * created afterwards.
 */
export function JournalSettings() {
  const workspace = useWorkspace();
  useWorkspaceState(); // re-render when settings change (here or by sync)
  const settings = workspace.settings();
  const zone = timeZoneOf(settings);
  const zoneId = useId();
  return (
    <section
      className="settings-section"
      aria-labelledby={`${zoneId}-h`}
      data-testid="journal-settings"
    >
      <h2 id={`${zoneId}-h`}>Daily Notes</h2>
      <p className="muted">
        Today is {today(settings).toString()} in {zone}. Changes sync to your other devices. Daily
        notes are kept in your Primary Notebook, chosen in Settings → Notebooks.
      </p>
      <label className="settings-field" htmlFor={zoneId}>
        <span>Time zone</span>
        <Select
          id={zoneId}
          value={zone}
          onChange={(event) => workspace.setSetting(TIME_ZONE_SETTING, event.target.value)}
        >
          {timeZones().map((each) => (
            <option key={each} value={each}>
              {each}
            </option>
          ))}
        </Select>
      </label>
      <TemplateField kind="daily" label="Daily template" />
      <TemplateField kind="weekly" label="Weekly template" />
      <p className="muted settings-help">
        Placeholders: <code>{'{{date}}'}</code> 2026-10-21, <code>{'{{longDate}}'}</code> Wednesday
        21 October 2026, <code>{'{{weekday}}'}</code>, <code>{'{{week}}'}</code> 2026-W43,{' '}
        <code>{'{{year}}'}</code>, <code>{'{{month}}'}</code>.
      </p>
      <fieldset className="appearance-group" data-testid="capture-default-setting">
        <legend>Quick Capture</legend>
        <div className="seg" data-testid="capture-default">
          {CAPTURE_DESTINATIONS.map((item) => (
            <label key={item.value} className="seg-option">
              <input
                type="radio"
                name={`${zoneId}-capture`}
                value={item.value}
                checked={destinationOf(settings) === item.value}
                onChange={() => workspace.setSetting(DESTINATION_SETTING, item.value)}
              />
              <span className="bold-steady" data-label={item.label}>
                {item.label}
              </span>
            </label>
          ))}
        </div>
        <p className="muted appearance-note">
          Where Quick Capture saves unless you choose otherwise in its window. Synced to your other
          devices.
        </p>
      </fieldset>
    </section>
  );
}

function TemplateField({ kind, label }: { kind: PeriodKind; label: string }) {
  const workspace = useWorkspace();
  const saved = templateOf(workspace.settings(), kind);
  const [draft, setDraft] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const id = useId();
  const value = draft ?? saved;
  return (
    <div className="settings-field">
      <label htmlFor={id}>{label}</label>
      <textarea
        id={id}
        className="input template-input"
        rows={6}
        spellCheck={false}
        value={value}
        onChange={(event) => {
          setStatus(null);
          setDraft(event.target.value);
        }}
      />
      <div className="settings-actions">
        <button
          type="button"
          className="btn primary"
          data-ui="submit"
          disabled={draft === null || draft === saved}
          onClick={() => {
            workspace.setSetting(templateSetting(kind), value);
            setDraft(null);
            setStatus('Saved');
          }}
        >
          <Icon name="check" size={14} />
          Save
        </button>
        <button
          type="button"
          className="btn"
          data-ui="item"
          onClick={() => {
            workspace.setSetting(templateSetting(kind), undefined);
            setDraft(null);
            setStatus('Back to the default');
          }}
        >
          <Icon name="undo" size={14} />
          Use the Default
        </button>
        <span role="status" className="muted">
          {status}
        </span>
      </div>
    </div>
  );
}
