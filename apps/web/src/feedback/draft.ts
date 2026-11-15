/**
 * The Send Feedback form's draft (T49, A796): read as the form opens, written once typing pauses
 * and as the form closes, until it is sent or discarded. The screenshots are written only when
 * they change, not with every keystroke's save.
 */
import { ulid } from '@penmoss/core/ids';
import type {
  FeedbackContext,
  FeedbackGroupId,
  FeedbackPriority,
  FeedbackType,
} from '@penmoss/core/feedback';
import type { JSONContent } from '@penmoss/editor/feedback';
import {
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from 'react';
import type { Screenshot } from './images';
import type { FeedbackService } from './service';
import type { FeedbackDraftText } from './store';

/** How long typing pauses before the draft is written. */
const WRITE_DELAY_MS = 400;

function writeDraft(feedback: FeedbackService, draft: FeedbackDraftText): void {
  void feedback.store
    .writeDraft(draft)
    .catch((error: unknown) => console.error('[feedback] could not keep the draft', error));
}

/** The form's fields as the draft holds them, with their setters. */
export interface FeedbackDraftFields {
  /** The draft is read: the form can be filled in. */
  readonly loaded: boolean;
  readonly submissionId: string;
  readonly type: FeedbackType | null;
  readonly setType: Dispatch<SetStateAction<FeedbackType | null>>;
  readonly priority: FeedbackPriority | null;
  readonly setPriority: Dispatch<SetStateAction<FeedbackPriority | null>>;
  readonly title: string;
  readonly setTitle: Dispatch<SetStateAction<string>>;
  readonly description: JSONContent | null;
  readonly setDescription: Dispatch<SetStateAction<JSONContent | null>>;
  /** The description the editor opens with: the draft's, as read. */
  readonly initialDescription: RefObject<JSONContent | null>;
  readonly shots: Screenshot[];
  readonly setShots: Dispatch<SetStateAction<Screenshot[]>>;
  readonly omitted: ReadonlySet<FeedbackGroupId>;
  readonly setOmitted: Dispatch<SetStateAction<ReadonlySet<FeedbackGroupId>>>;
  /** A report taken back by Edit: the context it was captured with, not this screen's. */
  readonly kept: FeedbackContext | null;
  /** Whether the draft is still written (false from Send or Discard; true again if Send fails). */
  readonly keeping: (keep: boolean) => void;
  /** Removes the draft, screenshots too. */
  readonly clear: () => Promise<void>;
}

/**
 * The draft, if one waits; the Mac's `capture` of the window behind is offered unticked. While
 * `idle` (nothing sent yet) the fields are written back.
 */
export function useFeedbackDraft(
  feedback: FeedbackService,
  capture: Blob | null,
  idle: boolean,
): FeedbackDraftFields {
  const [loaded, setLoaded] = useState(false);
  const [submissionId, setSubmissionId] = useState(() => ulid());
  const [type, setType] = useState<FeedbackType | null>(null);
  const [priority, setPriority] = useState<FeedbackPriority | null>(null);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState<JSONContent | null>(null);
  const [shots, setShots] = useState<Screenshot[]>([]);
  const [omitted, setOmitted] = useState<ReadonlySet<FeedbackGroupId>>(new Set());
  const [kept, setKept] = useState<FeedbackContext | null>(null);
  const initialDescription = useRef<JSONContent | null>(null);

  useEffect(() => {
    let live = true;
    void feedback.store
      .readDraft()
      .catch(() => null)
      .then((draft) => {
        if (!live) return;
        // A ticked capture, and every chosen image, stays with the draft; the window behind is
        // captured afresh each time the form opens.
        const kept = draft?.screenshots ?? [];
        const behind: Screenshot[] = capture
          ? [
              {
                id: `capture-${Date.now()}`,
                name: 'This window.png',
                type: 'image/png',
                blob: capture,
                included: false,
                source: 'window',
              },
            ]
          : [];
        if (draft) {
          setSubmissionId(draft.submissionId);
          setType(draft.type);
          setPriority(draft.priority);
          setTitle(draft.title);
          setDescription(draft.description);
          initialDescription.current = draft.description;
          setOmitted(new Set(draft.omitted));
          setKept(draft.context ?? null);
        }
        setShots([...behind, ...kept]);
        setLoaded(true);
      });
    return () => {
      live = false;
    };
  }, [feedback, capture]);

  // The draft is written once typing pauses, and as the form closes, until it is sent.
  const unsaved = useRef<FeedbackDraftText | null>(null);
  const keepDraft = useRef(true);
  useEffect(() => {
    if (!loaded || !idle) {
      unsaved.current = null;
      return;
    }
    unsaved.current = {
      submissionId,
      type,
      priority,
      title,
      description,
      omitted: [...omitted],
      ...(kept ? { context: kept } : {}),
      updatedAt: Date.now(),
    };
    const timer = setTimeout(() => {
      const draft = unsaved.current;
      unsaved.current = null;
      if (draft) writeDraft(feedback, draft);
    }, WRITE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [
    feedback,
    loaded,
    idle,
    submissionId,
    type,
    priority,
    title,
    description,
    shots,
    omitted,
    kept,
  ]);
  // The screenshots, only when they change (not with every keystroke's save).
  useEffect(() => {
    if (!loaded || !idle || !keepDraft.current) return;
    void feedback.store
      .writeDraftScreenshots(shots)
      .catch((error: unknown) => console.error('[feedback] could not keep the screenshots', error));
  }, [feedback, loaded, idle, shots]);
  useEffect(
    () => () => {
      if (keepDraft.current && unsaved.current) writeDraft(feedback, unsaved.current);
    },
    [feedback],
  );

  return {
    loaded,
    submissionId,
    type,
    setType,
    priority,
    setPriority,
    title,
    setTitle,
    description,
    setDescription,
    initialDescription,
    shots,
    setShots,
    omitted,
    setOmitted,
    kept,
    keeping: (keep) => {
      keepDraft.current = keep;
    },
    clear: () => feedback.store.writeDraft(null).catch(() => undefined),
  };
}
