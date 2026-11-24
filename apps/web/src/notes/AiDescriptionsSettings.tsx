/**
 * Settings → AI Descriptions (PEN-161, A1656), in the Writing group: whether notes are described
 * (the global value, Off unset), when (After a Pause, or At Sync), the pause, this device's AI
 * Provider (filled from the providers the Mac offers; Not Set Up until chosen, never synced), the
 * model, and the prompt with its tokens and Reset to Default. Describe All Notes describes every
 * notebook's notes that want it now, as a notebook's Describe Notes Now does for one.
 */
import {
  AI_DESCRIPTION_GLOBAL_SETTING,
  AI_DESCRIPTION_MODEL_SETTING,
  AI_DESCRIPTION_PAUSE_SETTING,
  AI_DESCRIPTION_PROMPT_SETTING,
  AI_DESCRIPTION_WHEN_SETTING,
  AI_PROVIDER_SETTING,
  aiGlobalOf,
  aiProviderOf,
  DEFAULT_PROMPT,
  describeWhenOf,
  modelOf,
  modelsOf,
  PAUSE_CHOICES_SECONDS,
  pauseSecondsOf,
  promptHasBody,
  promptOf,
  PROMPT_TOKENS,
  type AiProviderId,
} from '@penmoss/core/ai-description';
import { Select } from '@penmoss/ui/controls/Select';
import { Icon } from '@penmoss/ui/icons';
import { useId, useRef, useState } from 'react';
import { desktop, type DesktopAiStatus } from '../desktop/bridge';
import { useAllSources } from '../sources/hooks';
import { useAiStatus } from './ai-status';
import { DescribeNotesDialog, type DescribeGroup } from './DescribeAllDialog';
import { SettingsHeader } from '../pages/SettingsHeader';
import { GroupHead, SettingRow } from '../theme/look-rows';
import { useWorkspace, useWorkspaceState } from '../workspace/hooks';
import './ai-descriptions.css';

const PAUSE_LABELS: Readonly<Record<number, string>> = {
  30: '30 Seconds',
  60: '1 Minute',
  120: '2 Minutes',
  300: '5 Minutes',
  600: '10 Minutes',
};

function Segmented<T extends string>({
  name,
  labelledBy,
  value,
  options,
  event,
  onChange,
  testId,
}: {
  name: string;
  labelledBy: string;
  value: T;
  options: readonly { readonly value: T; readonly label: string }[];
  event: string;
  onChange: (value: T) => void;
  testId: string;
}) {
  return (
    <div className="seg" role="radiogroup" aria-labelledby={labelledBy} data-testid={testId}>
      {options.map((option) => (
        <label key={option.value} className="seg-option">
          <input
            type="radio"
            name={name}
            data-event={event}
            value={option.value}
            checked={value === option.value}
            onChange={() => onChange(option.value)}
          />
          <span className="bold-steady" data-label={option.label}>
            {option.label}
          </span>
        </label>
      ))}
    </div>
  );
}

export function AiDescriptionsSettings() {
  const workspace = useWorkspace();
  useWorkspaceState(); // re-render when settings change (here or by sync)
  const settings = workspace.settings();
  const id = useId();
  const status = useAiStatus();
  const global = aiGlobalOf(settings);
  const when = describeWhenOf(settings);
  const provider = aiProviderOf(settings);
  const providers = status?.providers ?? [];
  const model = modelOf(settings, provider);
  const prompt = promptOf(settings);
  const { all } = useAllSources();
  // What there was when Describe All Notes was chosen: the dialog counts these once.
  const [describing, setDescribing] = useState<readonly DescribeGroup[] | null>(null);
  return (
    <section
      className="settings-section ai-settings"
      aria-labelledby={`${id}-h`}
      data-testid="ai-descriptions-settings"
    >
      <SettingsHeader id={`${id}-h`} title="AI Descriptions" />
      <div className="lf-group">
        <SettingRow
          setting="describe-notes"
          label="Describe Notes"
          labelId={`${id}-global`}
          help={
            global
              ? 'Every notebook describes its notes, unless a notebook, folder or note says Off.'
              : 'Nothing is described unless a notebook, folder or note says On.'
          }
          testId="ai-global-setting"
        >
          <Segmented
            name={`${id}-global`}
            labelledBy={`${id}-global`}
            value={global ? 'on' : 'off'}
            options={[
              { value: 'on', label: 'On' },
              { value: 'off', label: 'Off' },
            ]}
            event="settings.ai.global"
            testId="ai-global"
            onChange={(value) =>
              workspace.setSetting(AI_DESCRIPTION_GLOBAL_SETTING, value === 'on')
            }
          />
        </SettingRow>
        <SettingRow
          setting="describe-a-note"
          label="Describe a Note"
          labelId={`${id}-when`}
          help={
            when === 'pause'
              ? 'The pause restarts with every edit, so a note is described once you stop.'
              : 'Notes whose text changed are described after each sync finishes.'
          }
          testId="ai-when-setting"
        >
          <Segmented
            name={`${id}-when`}
            labelledBy={`${id}-when`}
            value={when}
            options={[
              { value: 'pause', label: 'After a Pause' },
              { value: 'sync', label: 'At Sync' },
            ]}
            event="settings.ai.when"
            testId="ai-when"
            onChange={(value) => workspace.setSetting(AI_DESCRIPTION_WHEN_SETTING, value)}
          />
        </SettingRow>
        {when === 'pause' ? (
          <SettingRow
            setting="after-a-pause-of"
            label="After a Pause Of"
            labelFor={`${id}-pause`}
            testId="ai-pause-setting"
          >
            <Select
              id={`${id}-pause`}
              className="settings-choice"
              value={String(pauseSecondsOf(settings))}
              data-event="settings.ai.pause"
              data-testid="ai-pause"
              onChange={(event) =>
                workspace.setSetting(AI_DESCRIPTION_PAUSE_SETTING, Number(event.target.value))
              }
            >
              {PAUSE_CHOICES_SECONDS.map((seconds) => (
                <option key={seconds} value={String(seconds)}>
                  {PAUSE_LABELS[seconds] ?? `${seconds} seconds`}
                </option>
              ))}
            </Select>
          </SettingRow>
        ) : null}
        <SettingRow
          setting="describe-all-notes"
          label="Describe All Notes"
          help={
            provider === 'none'
              ? 'Pick an AI provider below first.'
              : 'Every notebook’s notes with no description, or changed since theirs, now. Notes set to Off are left out.'
          }
          testId="ai-describe-all-setting"
        >
          <button
            data-ui="submit"
            data-event="settings.ai.describe-all"
            type="button"
            className="btn"
            disabled={provider === 'none'}
            data-testid="ai-describe-all"
            onClick={() =>
              setDescribing(
                all.map((source) => ({
                  source,
                  noteIds: source.notes.list().map((note) => note.id),
                })),
              )
            }
          >
            <Icon name="sparkle" size={14} />
            Describe Notes Now…
          </button>
        </SettingRow>
      </div>
      {describing ? (
        <DescribeNotesDialog groups={describing} onClose={() => setDescribing(null)} />
      ) : null}
      <GroupHead scope="device">AI Provider</GroupHead>
      <div className="lf-group">
        <SettingRow
          setting="ai-provider"
          label="AI Provider"
          labelFor={`${id}-provider`}
          help="Penmoss uses only the provider you pick, and never switches on its own. Keys stay on this Mac, encrypted. This choice doesn’t sync."
          scope="device"
          testId="ai-provider-setting"
        >
          <Select
            id={`${id}-provider`}
            className="settings-choice"
            value={provider}
            data-testid="ai-provider"
            data-event="settings.ai.provider"
            onChange={(event) =>
              workspace.setSetting(
                AI_PROVIDER_SETTING,
                event.target.value === 'none' ? undefined : event.target.value,
              )
            }
          >
            <option value="none">Not Set Up</option>
            {providers.map((each) => (
              <option key={each.id} value={each.id}>
                {each.label}
              </option>
            ))}
          </Select>
        </SettingRow>
        <ProviderDetail key={provider} provider={provider} status={status} />
        {provider !== 'none' ? (
          <SettingRow
            setting="model"
            label="Model"
            labelFor={`${id}-model`}
            help="The models this provider offers. The fastest is picked for you."
            testId="ai-model-setting"
          >
            <Select
              id={`${id}-model`}
              className="settings-choice"
              value={model ?? ''}
              data-event="settings.ai.model"
              data-testid="ai-model"
              onChange={(event) =>
                workspace.setSetting(AI_DESCRIPTION_MODEL_SETTING, event.target.value)
              }
            >
              {modelsOf(provider).map((each, index) => (
                <option key={each.id} value={each.id}>
                  {index === 0 ? `${each.label} (Fastest)` : each.label}
                </option>
              ))}
            </Select>
          </SettingRow>
        ) : null}
      </div>
      <GroupHead>Prompt</GroupHead>
      <PromptEditor
        prompt={prompt}
        custom={settings[AI_DESCRIPTION_PROMPT_SETTING] !== undefined}
        onSave={(next) =>
          workspace.setSetting(
            AI_DESCRIPTION_PROMPT_SETTING,
            next === DEFAULT_PROMPT ? undefined : next,
          )
        }
      />
    </section>
  );
}

/** What the chosen provider needs: the key with Test Key, or Claude Code's status. */
function ProviderDetail({
  provider,
  status,
}: {
  provider: AiProviderId;
  status: DesktopAiStatus | null;
}) {
  const id = useId();
  const [key, setKey] = useState('');
  const [shown, setShown] = useState(false);
  const [said, setSaid] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const ai = desktop()?.ai;
  if (provider === 'none') {
    return (
      <p className="lf-help ai-via" data-testid="ai-via">
        <b>Not set up: nothing is sent.</b> Pick a provider to describe notes on this Mac. Until
        then, notes set to On wait.
      </p>
    );
  }
  const test = async () => {
    if (!ai) return;
    setBusy(true);
    setSaid({ ok: true, text: 'Checking…' });
    const answer = await ai.test(provider);
    setBusy(false);
    setSaid(answer ? { ok: answer.ok, text: answer.message } : null);
  };
  if (provider === 'claude-code') {
    const cc = status?.claudeCode;
    const words =
      cc?.state === 'ready'
        ? `Found${cc.version ? ` (version ${cc.version})` : ''} and signed in. Penmoss runs claude -p with Claude Code’s own sign-in, so your Claude plan covers the calls.`
        : cc?.state === 'signed-out'
          ? 'Found, but not signed in. Run claude in Terminal to sign in.'
          : cc?.state === 'missing'
            ? 'Not found on this Mac. Install Claude Code, then check again.'
            : 'Checking for Claude Code…';
    return (
      <SettingRow
        setting="claude-code"
        label="Claude Code on This Mac"
        help={<span data-testid="ai-claude-code-status">{words}</span>}
        extra={
          said ? (
            <span className="lf-row-note" role="status" data-testid="ai-test-result">
              {said.text}
            </span>
          ) : null
        }
        testId="ai-claude-code"
      >
        <button
          data-ui="submit"
          data-event="settings.ai.test"
          type="button"
          className="btn"
          disabled={busy}
          data-testid="ai-test"
          onClick={() => void test()}
        >
          <Icon name="refresh" size={14} />
          Check Claude Code
        </button>
      </SettingRow>
    );
  }
  const anthropic = status?.anthropic;
  return (
    <SettingRow
      setting="anthropic-api-key"
      label="Anthropic API Key"
      labelFor={`${id}-key`}
      help={
        anthropic?.saved
          ? (anthropic.problem ?? 'Saved on this Mac, encrypted. Calls go straight to Anthropic.')
          : anthropic && !anthropic.keychain
            ? 'This Mac can’t keep a key: the Keychain isn’t available.'
            : 'Calls go straight to Anthropic with this key.'
      }
      extra={
        said ? (
          <span className="lf-row-note" role="status" data-testid="ai-test-result">
            {said.text}
          </span>
        ) : null
      }
      testId="ai-key-setting"
    >
      {anthropic?.saved ? (
        <span className="ai-key-actions">
          <button
            data-ui="submit"
            data-event="settings.ai.test"
            type="button"
            className="btn"
            disabled={busy}
            data-testid="ai-test"
            onClick={() => void test()}
          >
            Test Key
          </button>
          <button
            data-ui="submit"
            data-event="settings.ai.remove-key"
            type="button"
            className="btn"
            data-testid="ai-remove-key"
            onClick={() => void ai?.removeKey()}
          >
            Remove
          </button>
        </span>
      ) : (
        <form
          className="ai-key-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (!ai || !key.trim()) return;
            setBusy(true);
            void ai.saveKey(key).then((answer) => {
              setBusy(false);
              if (answer?.ok) {
                setKey('');
                setSaid({ ok: true, text: 'Saved. Anthropic accepted the key.' });
              } else if (answer) setSaid({ ok: false, text: answer.message });
            });
          }}
        >
          <input
            id={`${id}-key`}
            className="input ai-key-input"
            type={shown ? 'text' : 'password'}
            autoComplete="off"
            spellCheck={false}
            placeholder="sk-ant-…"
            value={key}
            data-testid="ai-key"
            onChange={(event) => setKey(event.target.value)}
          />
          <button
            data-ui="submit"
            type="button"
            className="btn"
            data-event="settings.ai.show-key"
            onClick={() => setShown(!shown)}
          >
            {shown ? 'Hide' : 'Show'}
          </button>
          <button
            data-ui="submit"
            data-event="settings.ai.save-key"
            type="submit"
            className="btn primary"
            disabled={busy || !key.trim()}
            data-testid="ai-save-key"
          >
            Save
          </button>
        </form>
      )}
    </SettingRow>
  );
}

/** The prompt, its token buttons (inserted at the cursor) and Reset to Default. */
function PromptEditor({
  prompt,
  custom,
  onSave,
}: {
  prompt: string;
  custom: boolean;
  onSave: (prompt: string) => void;
}) {
  const id = useId();
  const area = useRef<HTMLTextAreaElement>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const text = draft ?? prompt;
  const save = (next: string) => {
    setDraft(null);
    if (next !== prompt) onSave(next);
  };
  return (
    <div className="ai-prompt-field" data-setting="prompt" data-testid="ai-prompt-setting">
      <label className="lf-row-label" htmlFor={`${id}-prompt`}>
        Prompt
      </label>
      <textarea
        ref={area}
        id={`${id}-prompt`}
        className="input ai-prompt"
        data-testid="ai-prompt"
        value={text}
        spellCheck={false}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => save(text)}
      />
      <div className="ai-tokens">
        <span className="muted">Insert:</span>
        {PROMPT_TOKENS.map((token) => (
          <button
            data-ui="submit"
            data-event="settings.ai.token"
            key={token}
            type="button"
            className="btn ai-token"
            data-testid={`ai-token-${token}`}
            // Keeps the cursor where it is in the prompt.
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              const field = area.current;
              const at = field?.selectionStart ?? text.length;
              const end = field?.selectionEnd ?? at;
              const insert = `{{${token}}}`;
              const next = text.slice(0, at) + insert + text.slice(end);
              save(next);
              requestAnimationFrame(() => {
                field?.focus();
                field?.setSelectionRange(at + insert.length, at + insert.length);
              });
            }}
          >
            {`{{${token}}}`}
          </button>
        ))}
        <button
          data-ui="submit"
          data-event="settings.ai.reset-prompt"
          type="button"
          className="btn ai-reset"
          data-testid="ai-reset-prompt"
          disabled={!custom && draft === null}
          onClick={() => {
            setDraft(null);
            onSave(DEFAULT_PROMPT);
          }}
        >
          Reset to Default
        </button>
      </div>
      {!promptHasBody(text) ? (
        <p className="ai-warn" role="alert" data-testid="ai-no-body">
          This prompt has no {'{{body}}'} token, so Claude won’t see the note’s text.
        </p>
      ) : null}
    </div>
  );
}
