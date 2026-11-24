/**
 * A tag's AI description on the Tags page (A1677): Generate All, which asks first (how many
 * tags, and that each goes to the AI provider), then describes them two at a time with progress
 * and Stop, as Describe Notes Now does for notes; and the ask for a provider when there is none,
 * pointing to Settings → AI Descriptions, as a note's Describe Now does.
 */
import { AI_DESCRIPTION_COPY } from '@penmoss/core/ai-description';
import { Icon } from '@penmoss/ui/icons';
import { useEffect, useMemo, useRef, useState } from 'react';
import { windowDescriber, type TagDescriberSource, type TagGroup } from '../notes/describer';
import { generateAllWords, generateGroups } from './generate';
import { linkHandler, settingsPath } from '../router';
import { ConfirmDialog } from '../shell/ConfirmDialog';

/** Generate All Tag Descriptions? over every notebook on the page. */
export function GenerateTagsDialog({
  sources,
  onClose,
}: {
  readonly sources: readonly TagDescriberSource[];
  readonly onClose: () => void;
}) {
  const describer = windowDescriber();
  const [replace, setReplace] = useState(false);
  // Counted when asked; fixed once it starts, so progress is out of what was confirmed.
  const counted = useMemo(() => generateGroups(sources, replace), [sources, replace]);
  const [going, setGoing] = useState<readonly TagGroup[] | null>(null);
  const [done, setDone] = useState<number | null>(null);
  const [failed, setFailed] = useState<{ count: number; message: string | null } | null>(null);
  const stop = useRef<AbortController | null>(null);
  useEffect(() => () => stop.current?.abort(), []);
  const groups = going ?? counted;
  const total = groups.reduce((sum, group) => sum + group.tags.length, 0);
  const running = done !== null && done < total;
  const finished = done !== null && done >= total;
  const start = () => {
    if (!describer || total === 0) return;
    const controller = new AbortController();
    stop.current = controller;
    setGoing(counted);
    setDone(0);
    void describer
      .describeTags(counted, { signal: controller.signal, onProgress: setDone })
      .then((out) => {
        if (out.failed > 0) setFailed({ count: out.failed, message: out.message });
      });
  };
  return (
    <ConfirmDialog
      title="Generate All Tag Descriptions?"
      testId="generate-tags"
      dialog="tagsGenerate"
      onCancel={() => {
        stop.current?.abort();
        onClose();
      }}
      onSubmit={() => (finished ? onClose() : start())}
    >
      <p data-testid="generate-tags-count">{generateAllWords(total, replace)}</p>
      {done === null ? (
        <label className="tags-generate-replace">
          <input
            type="checkbox"
            data-event="tags.generate.replace"
            checked={replace}
            onChange={(event) => setReplace(event.target.checked)}
            data-testid="generate-tags-replace"
          />
          <span>Replace Existing Descriptions</span>
        </label>
      ) : (
        <>
          <progress className="ai-progress" max={total} value={done} aria-label="Tags described" />
          <p className="muted" role="status" data-testid="generate-tags-progress">
            {finished ? `Generated ${done} of ${total}.` : `Generating ${done + 1} of ${total}…`}
          </p>
          {finished && failed ? (
            <p className="ai-warn" role="alert" data-testid="generate-tags-failed">
              {failed.count === 1
                ? '1 couldn’t be described'
                : `${failed.count} couldn’t be described`}
              {failed.message ? `: ${failed.message}` : '.'}
            </p>
          ) : null}
        </>
      )}
      <div className="confirm-actions">
        {running ? (
          <button
            data-ui="dismiss"
            type="button"
            className="btn"
            data-event="tags.generate.stop"
            onClick={() => {
              stop.current?.abort();
              onClose();
            }}
          >
            Stop
          </button>
        ) : (
          <button
            type="button"
            className="btn"
            data-ui="dismiss"
            data-event="tags.generate.cancel"
            onClick={onClose}
            autoFocus
          >
            {finished ? 'Close' : 'Cancel'}
          </button>
        )}
        {!finished && !running ? (
          <button
            type="submit"
            className="btn primary"
            data-ui="submit"
            data-event="tags.generate.start"
            disabled={total === 0}
          >
            <Icon name="sparkle" size={14} />
            {total === 1 ? 'Generate 1 Description' : `Generate ${total} Descriptions`}
          </button>
        ) : null}
      </div>
    </ConfirmDialog>
  );
}

/** Generating needs an AI provider: where to choose one (the phone's ChooseAiProviderDialog). */
export function ChooseAiProviderDialog({ onClose }: { readonly onClose: () => void }) {
  const path = settingsPath('ai-descriptions');
  return (
    <ConfirmDialog
      title="Choose an AI Provider"
      testId="choose-ai-provider"
      dialog="aiProvider"
      onCancel={onClose}
      onSubmit={onClose}
    >
      <p>{AI_DESCRIPTION_COPY['chooseProvider.body']}</p>
      <div className="confirm-actions">
        <button
          type="button"
          className="btn"
          data-ui="dismiss"
          data-event="tags.generate.cancel"
          onClick={onClose}
          autoFocus
        >
          Cancel
        </button>
        <a
          className="btn primary"
          data-ui="submit"
          data-event="tags.generate.open-settings"
          href={path}
          onClick={(event) => {
            onClose();
            linkHandler(path)(event);
          }}
        >
          <Icon name="gear" size={14} />
          Open Settings
        </a>
      </div>
    </ConfirmDialog>
  );
}
