import {
  CAPTURE_DESTINATION_SETTING,
  captureDestinationOf,
  type CaptureDestination,
} from '@penmoss/core/settings';
import { Icon } from '@penmoss/ui/icons';
import { useContext, useId, useSyncExternalStore } from 'react';
import { desktop } from '../desktop/bridge';
import { CaptureHotkeySetting } from '../desktop/CaptureHotkeySetting';
import { MenuBarIconSetting } from '../desktop/MenuBarIconSetting';
import { gitNotebookPath, linkHandler } from '../router';
import { SourcesContext } from '../sources/hooks';
import type { SourcesState } from '../sources/registry';
import { useWorkspace, useWorkspaceState } from '../workspace/hooks';
import { WritingGroup, WritingRow, WritingSubhead } from './writing-rows';

/** Where Quick Capture saves (T51 item 19, A947), in the order Settings offers them. */
const DESTINATIONS: ReadonlyArray<{
  readonly value: CaptureDestination;
  readonly label: string;
  readonly setting: string;
  readonly help: string;
}> = [
  {
    value: 'daily',
    label: 'Today’s Note',
    setting: 'todays-note',
    help: 'At the end of ## Captures, with the time',
  },
  {
    value: 'inbox',
    label: 'New Note in Inbox',
    setting: 'new-note-in-inbox',
    help: 'Titled by its first line',
  },
];

const NO_SOURCES: SourcesState = { all: [], journal: null, journalPicked: false, loaded: false };
const noSubscribe = () => () => undefined;
const noSources = () => NO_SOURCES;

/**
 * Settings → Quick Capture (PEN-146 option B), in the Writing group, as Android has it: where a
 * capture saves (synced, `capture.destination`, A947), the notebook it files into (the Primary
 * Notebook, A827, chosen on its page), and under This Mac the system-wide hotkey (A226), recorded
 * by pressing keys, and the menu bar icon (A945), which was on Display. The This Mac group shows
 * only in the Mac app, where the desktop bridge is.
 */
export function QuickCaptureSettings() {
  const workspace = useWorkspace();
  useWorkspaceState(); // re-render when settings change (here or by sync)
  const destination = captureDestinationOf(workspace.settings());
  const id = useId();
  return (
    <section
      className="settings-section"
      aria-labelledby={`${id}-h`}
      data-testid="quick-capture-settings"
    >
      <h2 id={`${id}-h`}>Quick Capture</h2>
      <p>
        Jot something down from anywhere without opening a note. The capture window can choose the
        other place for a single capture.
      </p>
      <WritingSubhead id={`${id}-saves`}>Saves To</WritingSubhead>
      <WritingGroup
        role="radiogroup"
        aria-labelledby={`${id}-saves`}
        data-testid="capture-default-setting"
      >
        {DESTINATIONS.map((item) => (
          <label
            key={item.value}
            className="wr-row wr-choice"
            data-setting={item.setting}
            htmlFor={`${id}-${item.value}`}
          >
            <input
              id={`${id}-${item.value}`}
              type="radio"
              name={`${id}-destination`}
              value={item.value}
              checked={destination === item.value}
              aria-labelledby={`${id}-${item.value}-label`}
              aria-describedby={`${id}-${item.value}-help`}
              onChange={() => workspace.setSetting(CAPTURE_DESTINATION_SETTING, item.value)}
            />
            <span className="wr-row-text">
              <span className="wr-row-label" id={`${id}-${item.value}-label`}>
                {item.label}
              </span>
              <span className="wr-row-help" id={`${id}-${item.value}-help`}>
                {item.help}
              </span>
            </span>
          </label>
        ))}
      </WritingGroup>
      <PrimaryNotebookRow />
      {desktop() ? (
        <>
          <WritingSubhead>This Mac</WritingSubhead>
          <WritingGroup data-testid="capture-this-mac">
            <CaptureHotkeySetting />
            <MenuBarIconSetting />
          </WritingGroup>
        </>
      ) : null}
    </section>
  );
}

/** The notebook captures file into: the Primary Notebook, with a link to its page. */
function PrimaryNotebookRow() {
  // Read without `useAllSources`, so the page also renders where no sources are provided.
  const sources = useContext(SourcesContext);
  const state = useSyncExternalStore(
    sources?.subscribe ?? noSubscribe,
    sources?.getState ?? noSources,
    sources?.getState ?? noSources,
  );
  const journal = state.journal;
  return (
    <WritingGroup>
      <WritingRow
        setting="notebook"
        label="Notebook"
        help="Your Primary Notebook. Make another one primary on its page."
        testId="capture-notebook"
      >
        {journal ? (
          <a
            className="btn quiet wr-go"
            data-ui="item"
            href={gitNotebookPath(journal.id)}
            onClick={linkHandler(gitNotebookPath(journal.id))}
          >
            {journal.name}
            <Icon name="chevR" size={12} />
          </a>
        ) : null}
      </WritingRow>
    </WritingGroup>
  );
}
