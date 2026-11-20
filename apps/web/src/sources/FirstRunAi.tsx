/**
 * AI Descriptions on the first run (PEN-161, A1656): asked once after Setting Up, "Describe Notes
 * for Agents?", with Not Now picked. Turn On asks which AI writes them, with none picked: Claude
 * Code on this Mac, or Anthropic with an API key (checked and kept, encrypted, before it goes on).
 * Nothing is turned on until a provider is picked and works; Back or Not Now leaves it off.
 */
import {
  AI_DESCRIPTION_GLOBAL_SETTING,
  AI_PROVIDER_SETTING,
  type AiProviderId,
} from '@penmoss/core/ai-description';
import { useId, useState } from 'react';
import { desktop } from '../desktop/bridge';
import { useAiStatus } from '../notes/ai-status';
import { useAppWorkspace } from './hooks';
import { Action, Frame, Options } from './FirstRunFrame';

/** Describe Notes for Agents?: Turn On for All Notes, or Not Now (the default). */
export function AiQuestion({ back, onNext }: { back: () => void; onNext: (on: boolean) => void }) {
  const [choice, setChoice] = useState<'on' | 'off'>('off');
  return (
    <Frame
      name="ai"
      step={3}
      title="Describe Notes for Agents?"
      back={back}
      actions={
        <Action primary testId="first-run-continue" onClick={() => onNext(choice === 'on')}>
          {choice === 'on' ? 'Continue' : 'Start Writing'}
        </Action>
      }
    >
      <p>
        AI writes a short description into each note’s frontmatter, so agents see what a note holds
        before opening it.
      </p>
      <Options
        label="AI Descriptions"
        value={choice}
        onChange={setChoice}
        items={[
          {
            value: 'on',
            title: 'Turn On for All Notes',
            line: 'Next, pick the AI provider. Any notebook, folder or note can still say Off.',
            testId: 'first-run-ai-on',
          },
          {
            value: 'off',
            title: 'Not Now',
            line: 'It stays off. Settings → AI Descriptions turns it on later.',
            testId: 'first-run-ai-off',
          },
        ]}
      />
      <p className="muted">
        A note’s text is sent to the AI provider you pick next. Nothing is sent while descriptions
        are off.
      </p>
    </Frame>
  );
}

type Pick = Exclude<AiProviderId, 'none'> | null;

/** Which AI Should Write Descriptions?: Claude Code, or Anthropic with a key checked here. */
export function AiProviderStep({ back, onDone }: { back: () => void; onDone: () => void }) {
  const id = useId();
  const workspace = useAppWorkspace();
  const status = useAiStatus();
  const ai = desktop()?.ai;
  const [pick, setPick] = useState<Pick>(null);
  const [key, setKey] = useState('');
  const [said, setSaid] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const cc = status?.claudeCode.state;
  const keySaved = status?.anthropic.saved === true && !status.anthropic.problem;
  const ready = pick === 'claude-code' ? cc === 'ready' : pick === 'anthropic' ? keySaved : false;
  const check = async () => {
    if (!ai || !key.trim()) return;
    setBusy(true);
    setSaid({ ok: true, text: 'Checking…' });
    const answer = await ai.saveKey(key.trim());
    setBusy(false);
    if (answer?.ok) {
      setKey('');
      setSaid({ ok: true, text: 'Anthropic accepted the key. It’s kept on this Mac, encrypted.' });
    } else setSaid(answer ? { ok: false, text: answer.message } : null);
  };
  const ccLine =
    cc === 'ready'
      ? 'Found and signed in. Penmoss runs claude -p with its sign-in, so your Claude plan covers the calls.'
      : cc === 'signed-out'
        ? 'Found, but not signed in. Run claude in Terminal to sign in, then pick it again.'
        : cc === 'missing'
          ? 'Not found on this Mac. Install Claude Code to use it.'
          : 'Looking for Claude Code…';
  return (
    <Frame
      name="ai-provider"
      step={3}
      title="Which AI Should Write Descriptions?"
      back={back}
      actions={
        <Action
          primary
          testId="first-run-continue"
          disabled={!ready}
          onClick={() => {
            if (!pick) return;
            workspace.setSetting(AI_PROVIDER_SETTING, pick);
            workspace.setSetting(AI_DESCRIPTION_GLOBAL_SETTING, true);
            onDone();
          }}
        >
          {pick ? 'Turn On and Start Writing' : 'Pick One to Continue'}
        </Action>
      }
    >
      <Options<Exclude<Pick, null> | ''>
        label="AI Provider"
        value={pick ?? ''}
        onChange={(value) => {
          setPick(value === '' ? null : value);
          setSaid(null);
        }}
        items={[
          {
            value: 'anthropic',
            title: 'Anthropic, With an API Key',
            line: 'Calls go straight to Anthropic and are billed to the key.',
            testId: 'first-run-ai-anthropic',
          },
          {
            value: 'claude-code',
            title: 'Claude Code on This Mac',
            line: ccLine,
            testId: 'first-run-ai-claude-code',
          },
        ]}
      />
      {pick === 'anthropic' ? (
        keySaved ? (
          <p className="muted" role="status" data-testid="first-run-ai-key-state">
            {said?.text ?? 'A key is saved on this Mac.'}
          </p>
        ) : (
          <form
            className="ai-field"
            onSubmit={(event) => {
              event.preventDefault();
              void check();
            }}
          >
            <label className="lab" htmlFor={`${id}-key`}>
              Anthropic API Key
            </label>
            <span className="ai-key-form">
              <input
                id={`${id}-key`}
                className="input ai-key-input"
                type="password"
                autoComplete="off"
                spellCheck={false}
                placeholder="sk-ant-…"
                value={key}
                data-testid="first-run-ai-key"
                onChange={(event) => setKey(event.target.value)}
              />
              <button
                data-ui="submit"
                type="submit"
                className="btn"
                disabled={busy || !key.trim()}
                data-testid="first-run-ai-check-key"
                data-event="firstrun.ai.check-key"
              >
                Check Key
              </button>
            </span>
            {said ? (
              <span
                className={said.ok ? 'muted' : 'ai-warn'}
                role="status"
                data-testid="first-run-ai-key-state"
              >
                {said.text}
              </span>
            ) : null}
          </form>
        )
      ) : null}
      <p className="muted">
        The key stays on this Mac, encrypted. You can switch in Settings → AI Descriptions. Your
        phone asks for its own key, or leaves its notes for this Mac to describe.
      </p>
    </Frame>
  );
}
