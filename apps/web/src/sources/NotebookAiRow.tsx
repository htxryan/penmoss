/**
 * A notebook's AI Descriptions value (PEN-161) on its page: Inherit (from Settings → AI
 * Descriptions), On or Off, kept in the notebook (`ai.description`, a notebook setting, A827) so
 * every device using it agrees. Describe Notes Now describes its notes that need it.
 */
import {
  AI_DESCRIPTION_NOTEBOOK_SETTING,
  aiGlobalOf,
  parseAiSetting,
  type AiSetting,
} from '@penmoss/core/ai-description';
import { Icon } from '@penmoss/ui/icons';
import { useId, useState, useSyncExternalStore } from 'react';
import { DescribeAllDialog } from '../notes/DescribeAllDialog';
import { SettingRow } from '../theme/look-rows';
import { useAppWorkspace } from './hooks';
import { SourceScope } from './context';
import type { GitSource } from './git-source';

const CHOICES: readonly { readonly value: AiSetting; readonly label: string }[] = [
  { value: 'inherit', label: 'Inherit' },
  { value: 'on', label: 'On' },
  { value: 'off', label: 'Off' },
];

export function NotebookAiRow({ source }: { source: GitSource }) {
  const id = useId();
  const app = useAppWorkspace();
  useSyncExternalStore(
    source.workspace.subscribe,
    source.workspace.getState,
    source.workspace.getState,
  );
  useSyncExternalStore(app.subscribe, app.getState, app.getState);
  const notes = useSyncExternalStore(source.notes.subscribe, source.notes.list, source.notes.list);
  const [describing, setDescribing] = useState(false);
  const value = parseAiSetting(source.workspace.settings()[AI_DESCRIPTION_NOTEBOOK_SETTING]);
  const global = aiGlobalOf(app.settings());
  return (
    <SettingRow
      setting="notebook-ai-descriptions"
      label="AI Descriptions"
      labelId={`${id}-l`}
      help={
        value === 'inherit'
          ? `Inherits ${global ? 'On' : 'Off'} from Settings → AI Descriptions. A folder or note can say otherwise.`
          : 'A folder or note can say otherwise.'
      }
      testId="notebook-ai"
    >
      <span className="ai-key-actions">
        <div className="seg" role="radiogroup" aria-labelledby={`${id}-l`}>
          {CHOICES.map((choice) => (
            <label key={choice.value} className="seg-option">
              <input
                type="radio"
                name={`${id}-ai`}
                data-event="folder.ai.mode"
                checked={value === choice.value}
                onChange={() =>
                  source.workspace.setSetting(
                    AI_DESCRIPTION_NOTEBOOK_SETTING,
                    choice.value === 'inherit' ? undefined : choice.value,
                  )
                }
              />
              <span className="bold-steady" data-label={choice.label}>
                {choice.label}
              </span>
            </label>
          ))}
        </div>
        <button
          data-ui="submit"
          type="button"
          className="btn"
          data-event="folder.ai.describe-all"
          data-testid="notebook-describe-all"
          onClick={() => setDescribing(true)}
        >
          <Icon name="sparkle" size={14} />
          Describe Notes Now…
        </button>
      </span>
      {describing ? (
        <SourceScope source={source}>
          <DescribeAllDialog
            name={source.name}
            noteIds={notes.map((note) => note.id)}
            onClose={() => setDescribing(false)}
          />
        </SourceScope>
      ) : null}
    </SettingRow>
  );
}
