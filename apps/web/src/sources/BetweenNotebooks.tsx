/** All Notebooks' Between Notebooks group, and the Copy Settings… panel it shares with a notebook's Overview (GitNotebooksSettings.tsx). */
import { Icon } from '@penmoss/ui/icons';
import { Select } from '@penmoss/ui/controls/Select';
import { useId, useState } from 'react';
import { useSourcesRegistry, useSourcesState } from './hooks';
import { copySettings } from './copy-settings';
import { setSettingsInStep, useSettingsInStepChoice } from './settings-in-step';
import { useCopyTagsDefault } from '../workspace/copy-tags-state';
import { GroupHead, SettingRow, Switch } from '../theme/look-rows';
import { withoutRecording } from '../analytics/track';
import { ALL_OTHERS } from './notebook-settings-shared';

/**
 * The Primary Notebook (A1101; PEN-146): the one whose daily and weekly notes, Calendar, Inbox
 * and Quick Capture the app uses, and whose settings it reads. This Mac's choice, made here once
 * for all the notebooks; the first notebook until one is chosen. Between Notebooks' first row
 * (A1558), since it is where the settings the other rows copy come from.
 */
function PrimaryPicker() {
  const registry = useSourcesRegistry();
  const state = useSourcesState();
  const id = useId();
  return (
    <SettingRow
      setting="primary-notebook"
      label="Primary Notebook"
      labelFor={`${id}-select`}
      help="Holds your journal, Inbox and these settings"
      helpId={`${id}-help`}
      testId="git-primary"
      scope
    >
      <Select
        id={`${id}-select`}
        value={state.journal.id}
        aria-describedby={`${id}-help`}
        data-event="settings.git-notebooks.journal"
        data-testid="git-primary-picker"
        disabled={state.all.length < 2}
        onChange={(event) => registry.setJournal(event.currentTarget.value)}
      >
        {state.all.map((source) => (
          <option key={source.id} value={source.id}>
            {source.name}
          </option>
        ))}
      </Select>
    </SettingRow>
  );
}

/**
 * Between Notebooks: the Primary Notebook first, then what goes from one notebook to another.
 * Keep Settings in Step (A1137, this
 * Mac's choice) copies each change of the primary's settings to the others; Copy Tags When
 * Copying Notes (A1353, synced) is where Copy to Notebook's Copy Tags starts; Copy Settings…
 * copies one notebook's settings into another, once.
 */
export function BetweenNotebooks() {
  const state = useSourcesState();
  const inStep = useSettingsInStepChoice();
  const { copies, set, canChange } = useCopyTagsDefault();
  const [copying, setCopying] = useState(false);
  const id = useId();
  const several = state.all.length > 1;
  return (
    <>
      <GroupHead>Between Notebooks</GroupHead>
      <div className="lf-group">
        <PrimaryPicker />
        {several ? (
          <SettingRow
            setting="keep-settings-in-step"
            label="Keep Settings in Step"
            labelFor={`${id}-step`}
            help={`A change to ${state.journal.name}’s settings goes to the other notebooks`}
            scope
          >
            <Switch
              id={`${id}-step`}
              checked={inStep}
              data-event="settings.git-notebooks.in-step"
              data-testid="git-settings-in-step"
              onChange={(event) => setSettingsInStep(event.target.checked)}
            />
          </SettingRow>
        ) : null}
        <SettingRow
          setting="copy-tags-when-copying-notes"
          label="Copy Tags When Copying Notes"
          labelFor={`${id}-tags`}
          help="Where Copy Tags starts in Copy to Notebook; tags typed in a note’s text always go with it"
          testId="copy-to-notebook-settings"
        >
          <Switch
            id={`${id}-tags`}
            checked={copies}
            disabled={!canChange}
            data-event="settings.git-notebooks.copy-tags"
            data-testid="copy-tags-default"
            onChange={(event) => set(event.target.checked)}
          />
        </SettingRow>
        {several ? (
          <SettingRow
            setting="copy-settings"
            label="Copy Settings…"
            help="From one notebook to another, once"
          >
            <button
              data-event="settings.git-notebooks.copy-settings.open"
              data-ui="item"
              type="button"
              className="btn"
              aria-expanded={copying}
              data-testid="git-copy-settings-open"
              onClick={() => setCopying((was) => !was)}
            >
              <Icon name="copy" size={14} />
              Copy…
            </button>
          </SettingRow>
        ) : null}
        {several && copying ? (
          <CopySettingsPanel
            from={state.journal.id}
            to={ALL_OTHERS}
            onClose={() => setCopying(false)}
          />
        ) : null}
      </div>
    </>
  );
}

/**
 * Copy Settings… (A1137; PEN-146): one notebook's settings written into another, or into every
 * other, replacing theirs, once. Quick Access stays as it is: its pins are each notebook's own.
 */
export function CopySettingsPanel({
  from: firstFrom,
  to: firstTo,
  onClose,
}: {
  from: string;
  to: string;
  onClose: () => void;
}) {
  const state = useSourcesState();
  const [from, setFrom] = useState(firstFrom);
  const [to, setTo] = useState(firstTo);
  const [done, setDone] = useState<string | null>(null);
  const id = useId();
  const source = state.all.find((each) => each.id === from) ?? state.journal;
  const others = state.all.filter((each) => each.id !== source.id);
  // Every other notebook, or one: the only other one when there is one, the first when the one
  // chosen became From.
  const target =
    to === ALL_OTHERS
      ? others.length === 1
        ? others[0]!
        : null
      : (others.find((each) => each.id === to) ?? others[0] ?? null);
  const targets = target ? [target] : others;
  const copy = () => {
    const changed = targets.reduce(
      (sum, each) => sum + withoutRecording(() => copySettings(source.workspace, each.workspace)),
      0,
    );
    const where = target ? target.name : 'the other notebooks';
    setDone(
      changed === 0
        ? `${target ? target.name : 'The other notebooks'} already had these settings.`
        : `Copied ${source.name}’s settings to ${where}.`,
    );
  };
  return (
    <div className="nset-panel" data-testid="git-settings-copy">
      <div className="nset-panel-fields">
        <label className="settings-field" htmlFor={`${id}-from`}>
          <span>From</span>
        </label>
        <Select
          id={`${id}-from`}
          value={source.id}
          data-event="settings.git-notebooks.copy-settings.from"
          data-testid="git-copy-from"
          onChange={(event) => {
            setFrom(event.currentTarget.value);
            setDone(null);
          }}
        >
          {state.all.map((each) => (
            <option key={each.id} value={each.id}>
              {each.name}
            </option>
          ))}
        </Select>
        <label className="settings-field" htmlFor={`${id}-to`}>
          <span>To</span>
        </label>
        <Select
          id={`${id}-to`}
          value={target ? target.id : ALL_OTHERS}
          data-event="settings.git-notebooks.copy-settings.to"
          data-testid="git-copy-to"
          onChange={(event) => {
            setTo(event.currentTarget.value);
            setDone(null);
          }}
        >
          {others.length > 1 ? <option value={ALL_OTHERS}>Every Other Notebook</option> : null}
          {others.map((each) => (
            <option key={each.id} value={each.id}>
              {each.name}
            </option>
          ))}
        </Select>
      </div>
      <p className="t-help nset-panel-note">
        Replaces {target ? `${target.name}’s` : 'their'} settings with {source.name}’s: the theme,
        the sidebar, shortcuts and the rest. Quick Access stays as it is.
      </p>
      <div className="settings-actions">
        <button
          data-event="settings.git-notebooks.copy-settings.copy"
          data-ui="item"
          type="button"
          className="btn primary"
          data-testid="git-copy-settings"
          disabled={targets.length === 0}
          onClick={copy}
        >
          <Icon name="copy" size={14} />
          Copy Settings
        </button>
        <button
          data-event="settings.git-notebooks.copy-settings.cancel"
          data-ui="item"
          type="button"
          className="btn"
          onClick={onClose}
        >
          {done ? 'Done' : 'Cancel'}
        </button>
      </div>
      {done ? (
        <p className="t-help" role="status" data-testid="git-copy-settings-done">
          {done}
        </p>
      ) : null}
    </div>
  );
}
