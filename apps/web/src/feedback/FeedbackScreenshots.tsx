/** Send Feedback's Screenshots field (FeedbackDialog.tsx). */
import { FEEDBACK_LIMITS } from '@penmoss/core/feedback';
import { Icon } from '@penmoss/ui/icons';
import { useRef, type Dispatch, type SetStateAction } from 'react';
import type { Screenshot } from './images';

/** The screenshots, each with Send, Move Earlier, Move Later and Remove, and Add Images…. */
export function FeedbackScreenshots({
  id,
  shots,
  setShots,
  thumbs,
  addFiles,
  imageError,
}: {
  id: string;
  shots: readonly Screenshot[];
  setShots: Dispatch<SetStateAction<Screenshot[]>>;
  /** Each screenshot's thumbnail URL, by its id. */
  thumbs: ReadonlyMap<string, string>;
  addFiles: (files: readonly File[]) => void;
  imageError: string | null;
}) {
  const fileInput = useRef<HTMLInputElement>(null);
  const move = (index: number, by: -1 | 1) =>
    setShots((current) => {
      const next = [...current];
      const [shot] = next.splice(index, 1);
      next.splice(index + by, 0, shot!);
      return next;
    });

  return (
    <div className="feedback-field">
      <span className="feedback-label" id={`${id}-shots`}>
        Screenshots
      </span>
      <p className="muted feedback-hint">
        Up to {FEEDBACK_LIMITS.screenshots} PNG, JPEG, WebP or GIF images, 10 MB each: paste, drop
        or choose them.
      </p>
      {shots.length > 0 ? (
        <ul className="feedback-shots" aria-labelledby={`${id}-shots`} data-testid="feedback-shots">
          {shots.map((shot, index) => (
            <li key={shot.id} className="feedback-shot" data-testid="feedback-shot">
              <img src={thumbs.get(shot.id)} alt={`Screenshot ${index + 1}: ${shot.name}`} />
              <label className="feedback-shot-include">
                <input
                  type="checkbox"
                  checked={shot.included}
                  data-event="feedback.screenshot.include"
                  data-testid="feedback-shot-include"
                  onChange={(event) => {
                    const included = event.target.checked;
                    setShots((current) =>
                      current.map((item) => (item.id === shot.id ? { ...item, included } : item)),
                    );
                  }}
                />
                {shot.source === 'window'
                  ? 'Send this capture of the window'
                  : shot.source === 'tab'
                    ? 'Send this capture of the tab'
                    : 'Send'}
              </label>
              <span className="row">
                <button
                  type="button"
                  className="icon-btn"
                  data-ui="item"
                  data-event="feedback.screenshot.earlier"
                  aria-label={`Move Screenshot ${index + 1} Earlier`}
                  data-tip="Move Earlier"
                  disabled={index === 0}
                  onClick={() => move(index, -1)}
                >
                  <Icon name="arrowL" />
                </button>
                <button
                  type="button"
                  className="icon-btn"
                  data-ui="item"
                  data-event="feedback.screenshot.later"
                  aria-label={`Move Screenshot ${index + 1} Later`}
                  data-tip="Move Later"
                  disabled={index === shots.length - 1}
                  onClick={() => move(index, 1)}
                >
                  <Icon name="arrowR" />
                </button>
                <button
                  type="button"
                  className="icon-btn"
                  data-ui="item"
                  aria-label={`Remove Screenshot ${index + 1}`}
                  data-tip="Remove"
                  data-event="feedback.screenshot.remove"
                  data-testid="feedback-shot-remove"
                  onClick={() =>
                    setShots((current) => current.filter((item) => item.id !== shot.id))
                  }
                >
                  <Icon name="trash" />
                </button>
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="row feedback-shot-actions">
        <button
          type="button"
          className="btn"
          data-ui="item"
          data-event="feedback.screenshot.add"
          data-testid="feedback-add-image"
          onClick={() => fileInput.current?.click()}
        >
          <Icon name="plus" />
          Add Images…
        </button>
        <input
          ref={fileInput}
          type="file"
          hidden
          multiple
          accept="image/png,image/jpeg,image/webp,image/gif"
          data-testid="feedback-file"
          onChange={(event) => {
            addFiles([...(event.target.files ?? [])]);
            event.target.value = '';
          }}
        />
      </div>
      {imageError ? (
        <p role="alert" className="field-error" data-testid="feedback-image-error">
          {imageError}
        </p>
      ) : null}
    </div>
  );
}
