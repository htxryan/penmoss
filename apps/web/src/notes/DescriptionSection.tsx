/**
 * The Metadata tab's Description section (PEN-161, A1656): the note's description, edited here,
 * and under it the AI Description control: the note's own Inherit, On or Off, what that comes to
 * (● On, with where it is inherited from), the describer's status, Describe Now and Clear.
 *
 * Editing the description by hand marks it written by hand; while AI Descriptions is on for the
 * note, Penmoss then asks "Keep Your Description?" (Keep Mine turns the note Off; Let Claude
 * Update It lets the next change rewrite it).
 */
import { aiProviderOf, type AiEffective } from '@penmoss/core/ai-description';
import {
  answerDescriptionAsk,
  clearDescription,
  descriptionAsks,
  descriptionAuthor,
  readAiSetting,
  readDescription,
  setAiSetting,
  setHandDescription,
} from '@penmoss/model/description';
import type { Yjs14Replica } from '@penmoss/model/yjs14';
import type { AiSetting } from '@penmoss/core/ai-description';
import { Icon } from '@penmoss/ui/icons';
import { ConfirmBlock } from '../shell/ConfirmBlock';
import { useEffect, useId, useState, useSyncExternalStore } from 'react';
import { gitNotebookPath, linkHandler, settingsPath } from '../router';
import { shortWhen } from '../shell/when';
import { useAppWorkspace, useSource } from '../sources/hooks';
import { windowDescriber, type DescribeStatus } from './describer';
import './ai-descriptions.css';
import { Segmented } from '../shell/Segmented';

const MODES: readonly { readonly value: AiSetting; readonly label: string }[] = [
  { value: 'inherit', label: 'Inherit' },
  { value: 'on', label: 'On' },
  { value: 'off', label: 'Off' },
];

const NEVER = () => () => undefined;
const IDLE: DescribeStatus = { state: 'idle' };

/** The note's document, read again whenever it changes (it is small: a few attributes). */
function useDocVersion(replica: Yjs14Replica | null): number {
  const [version, setVersion] = useState(0);
  useEffect(() => {
    if (!replica) return;
    return replica.onUpdate(() => setVersion((v) => v + 1));
  }, [replica]);
  return version;
}

/** Where an inherited value comes from, as a chip: a folder, notebook or globe icon and a name. */
function SourceChip({ effective, sourceId }: { effective: AiEffective; sourceId: string }) {
  const { source } = effective;
  if (source.level === 'note') return null;
  if (source.level === 'folder') {
    return (
      <span
        className="ai-src-chip"
        data-testid="ai-source"
        title={`Inherited from the folder ${source.name}`}
      >
        <Icon name="folder" size={12} />
        {source.name}
      </span>
    );
  }
  const notebook = source.level === 'notebook';
  const path = notebook ? gitNotebookPath(sourceId) : settingsPath('ai-descriptions');
  const name = notebook ? source.name : 'Everywhere';
  return (
    <a
      data-ui="submit"
      data-event="note.ai.source"
      className="ai-src-chip"
      data-testid="ai-source"
      href={path}
      onClick={linkHandler(path)}
      title={notebook ? `Inherited from the notebook ${source.name}` : 'Inherited from Settings'}
    >
      <Icon name={notebook ? 'notebook' : 'globe'} size={12} />
      {name}
    </a>
  );
}

function statusText(
  status: DescribeStatus,
  options: { on: boolean; provider: boolean; has: boolean; by: 'ai' | 'hand' | null },
): string {
  if (status.state === 'describing') return 'Describing…';
  if (status.state === 'error') return status.message;
  if (status.state === 'described') return `Described ${shortWhen(status.at).toLowerCase()}`;
  if (!options.on) return options.has ? 'Off: the description stays as it is' : 'Off';
  if (!options.provider) return 'Choose an AI provider in Settings to describe notes';
  if (options.by === 'hand') return 'Written by you: kept until you let Claude update it';
  return options.has ? 'Described' : 'Waiting for the next change';
}

export function DescriptionSection({
  noteId,
  replica,
}: {
  noteId: string;
  replica: Yjs14Replica | null;
}) {
  const id = useId();
  const source = useSource();
  const app = useAppWorkspace();
  useDocVersion(replica);
  // The folder tree and the notebook's own value, and the app's settings, as they change.
  const workspaceState = source ? source.workspace.getState : () => null;
  useSyncExternalStore(source?.workspace.subscribe ?? NEVER, workspaceState, workspaceState);
  useSyncExternalStore(app.subscribe, app.getState, app.getState);
  const describer = windowDescriber();
  const readStatus = () => (describer && source ? describer.status(source.id, noteId) : IDLE);
  const status = useSyncExternalStore(describer?.subscribe ?? NEVER, readStatus, readStatus);
  const doc = replica?.doc ?? null;
  const description = doc ? (readDescription(doc) ?? '') : '';
  const [draft, setDraft] = useState<string | null>(null);
  if (!doc || !source) return null;
  const own = readAiSetting(doc);
  const effective = describer?.effective(source, noteId, doc) ?? {
    on: own === 'on',
    source: { level: 'note' as const },
  };
  const by = descriptionAuthor(doc);
  const asking = descriptionAsks(doc);
  const provider = aiProviderOf(app.settings()) !== 'none';
  const commit = () => {
    if (draft === null) return;
    const text = draft;
    setDraft(null);
    if (text.trim() === description) return;
    setHandDescription(doc, text, { ask: effective.on && text.trim() !== '' });
  };
  const failed = status.state === 'error';
  return (
    <>
      <h3 className="info-subheading" id={`${id}-desc`}>
        Description
      </h3>
      <textarea
        className="input ai-desc-edit"
        data-testid="ai-description"
        aria-labelledby={`${id}-desc`}
        rows={3}
        placeholder="No description yet. Write one, or let Claude."
        value={draft ?? description}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            event.currentTarget.blur();
          } else if (event.key === 'Escape') {
            setDraft(null);
          }
        }}
      />
      {by ? (
        <span className="ai-desc-by" data-testid="ai-description-by">
          {by === 'hand' ? 'Written by you' : 'Written by AI Descriptions'}
        </span>
      ) : null}
      {asking && effective.on ? (
        <ConfirmBlock className="ai-ask" testId="ai-ask" title="Keep Your Description?">
          <span className="muted">Claude would rewrite it the next time this note changes.</span>
          <div className="ai-ask-buttons">
            <button
              data-ui="submit"
              type="button"
              className="btn primary"
              data-event="note.ai.keep-mine"
              onClick={() => answerDescriptionAsk(doc, 'keep')}
            >
              Keep Mine
            </button>
            <button
              data-ui="submit"
              type="button"
              className="btn"
              data-event="note.ai.let-claude"
              onClick={() => answerDescriptionAsk(doc, 'update')}
            >
              Let Claude Update It
            </button>
          </div>
        </ConfirmBlock>
      ) : null}
      <h4 className="info-subsub" id={`${id}-ai`}>
        AI Description
      </h4>
      <div className="ai-row" data-testid="ai-control">
        <Segmented
          name={`${id}-mode`}
          labelledBy={`${id}-ai`}
          value={own}
          options={MODES}
          event="note.ai.mode"
          onChange={(mode) => setAiSetting(doc, mode)}
        />
        <span className="ai-eff" data-testid="ai-effective">
          <span className="ai-res">
            <span className={effective.on ? 'ai-dot' : 'ai-dot off'} aria-hidden="true" />
            {effective.on ? 'On' : 'Off'}
          </span>
          {own === 'inherit' ? <SourceChip effective={effective} sourceId={source.id} /> : null}
        </span>
        <span
          className={failed ? 'ai-status ai-warn' : 'ai-status'}
          role={failed ? 'alert' : 'status'}
          data-testid="ai-status"
        >
          {statusText(status, { on: effective.on, provider, has: description !== '', by })}
        </span>
        <div className="ai-actions">
          {!provider || (failed && /Settings/.test(status.message)) ? (
            <a
              data-ui="submit"
              data-event="note.ai.open-settings"
              className="btn primary"
              href={settingsPath('ai-descriptions')}
              onClick={linkHandler(settingsPath('ai-descriptions'))}
            >
              <Icon name="gear" size={14} />
              Open Settings
            </a>
          ) : null}
          <button
            data-ui="submit"
            type="button"
            className="btn"
            data-testid="ai-describe-now"
            data-event="note.ai.describe-now"
            disabled={!describer || !provider || !effective.on || status.state === 'describing'}
            onClick={() => {
              if (describer) void describer.describeNow(source, noteId);
            }}
          >
            <Icon name={failed ? 'refresh' : 'sparkle'} size={14} />
            {failed ? 'Try Again' : 'Describe Now'}
          </button>
          <button
            data-ui="submit"
            type="button"
            className="btn"
            data-testid="ai-clear"
            data-event="note.ai.clear"
            disabled={description === ''}
            onClick={() => clearDescription(doc)}
          >
            <Icon name="close" size={14} />
            Clear
          </button>
        </div>
      </div>
    </>
  );
}
