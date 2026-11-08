/**
 * The Send feedback form (T49, D41) on the web and in the Mac app: type, priority, title, a
 * description in the Penmoss editor's reduced schema (A790), screenshots, and the captured
 * context exactly as the issue will hold it, with a checkbox per group (A791). An unsent form
 * is a draft kept on this device; a sent one goes through the outbox, so offline it waits
 * (A796).
 */
import { ulid } from '@penmoss/core/ids';
import {
  contextMarkdown,
  FEEDBACK_GROUP_TITLES,
  FEEDBACK_LIMITS,
  FEEDBACK_PRIORITIES,
  FEEDBACK_PRIORITY_LABELS,
  FEEDBACK_TYPE_LABELS,
  FEEDBACK_TYPES,
  withoutGroups,
  type FeedbackContext,
  type FeedbackGroupId,
  type FeedbackPriority,
  type FeedbackType,
} from '@penmoss/core/feedback';
import {
  createFeedbackEditor,
  feedbackMarkdown,
  loadFeedbackMarkdown,
  FEEDBACK_FORMATS,
  setFeedbackLink,
  type FeedbackEditor,
  type JSONContent,
} from '@penmoss/editor/feedback';
import { ariaKeyShortcuts, formatCombo } from '@penmoss/editor/keys';
import { Icon, type IconName } from '@penmoss/ui/icons';
import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
} from 'react';
import { useCommands } from '../commands/hooks';
import { desktop } from '../desktop/bridge';
import { DialogClose } from '../shell/DialogClose';
import { buildContext, type ContextFacts } from './context';
import {
  captureThisTab,
  checkImage,
  nameFor,
  outputType,
  prepareImage,
  type Screenshot,
} from './images';
import { appVersion } from './open';
import type { Attempt } from './outbox';
import { problemsOf, sizeProblem, type Problems } from './problems';
import { useFeedback, type FeedbackService } from './service';
import type { FeedbackDraftText, OutboxEntry, OutboxError } from './store';

function writeDraft(feedback: FeedbackService, draft: FeedbackDraftText): void {
  void feedback.store
    .writeDraft(draft)
    .catch((error: unknown) => console.error('[feedback] could not keep the draft', error));
}

const SEND_KEYS = 'Mod+Enter';

/** What the form was opened with: the context and the Mac's capture, read before it drew. */
export interface FeedbackSnapshot {
  readonly facts: ContextFacts;
  readonly capture: Blob | null;
}

type Status =
  | { readonly kind: 'idle' }
  | { readonly kind: 'sending' }
  | { readonly kind: 'queued'; readonly error: OutboxError | null }
  | { readonly kind: 'elsewhere' }
  | { readonly kind: 'failed'; readonly error: OutboxError };

const keysOf = (keys: string) =>
  keys
    .split('-')
    .map((part) => (part.length === 1 ? part.toUpperCase() : part))
    .join('+');

export function FeedbackDialog({
  snapshot,
  onClose,
}: {
  snapshot: FeedbackSnapshot;
  onClose: (restoreFocus?: boolean) => void;
}) {
  // Edit after a refusal reads the report back from the outbox: the form starts again with it.
  const [round, setRound] = useState(0);
  return (
    <FeedbackForm
      key={round}
      snapshot={snapshot}
      onClose={onClose}
      onReopen={() => setRound((n) => n + 1)}
    />
  );
}

function FeedbackForm({
  snapshot,
  onClose,
  onReopen,
}: {
  snapshot: FeedbackSnapshot;
  onClose: (restoreFocus?: boolean) => void;
  onReopen: () => void;
}) {
  const feedback = useFeedback() as FeedbackService;
  const commands = useCommands();
  const id = useId();
  const { facts } = snapshot;

  const [loaded, setLoaded] = useState(false);
  const [submissionId, setSubmissionId] = useState(() => ulid());
  const [type, setType] = useState<FeedbackType | null>(null);
  const [priority, setPriority] = useState<FeedbackPriority | null>(null);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState<JSONContent | null>(null);
  const [shots, setShots] = useState<Screenshot[]>([]);
  const [omitted, setOmitted] = useState<ReadonlySet<FeedbackGroupId>>(new Set());
  /** A report taken back by Edit: the context it was captured with, not this screen's. */
  const [kept, setKept] = useState<FeedbackContext | null>(null);
  const [problems, setProblems] = useState<Problems>({});
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const [imageError, setImageError] = useState<string | null>(null);
  const [hidden, setHidden] = useState(false);
  const [linkHref, setLinkHref] = useState<string | null>(null);
  /** Which formats the selection has, for the toolbar's pressed states (read on each change). */
  const [active, setActive] = useState<ReadonlySet<string>>(new Set());
  const editorHost = useRef<HTMLDivElement>(null);
  const editorRef = useRef<FeedbackEditor | null>(null);
  /** The description the editor opens with: the draft's, as read. */
  const initialDescription = useRef<JSONContent | null>(null);
  const firstField = useRef<HTMLInputElement>(null);
  const titleField = useRef<HTMLInputElement>(null);
  const priorityField = useRef<HTMLInputElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const done = status.kind === 'queued' || status.kind === 'failed' || status.kind === 'elsewhere';

  // The dispatcher stands aside while the form is open: its keys are the form's and the
  // description editor's (bold, italic, lists), not the app's (T49).
  useEffect(() => commands.suspend(), [commands]);
  // The markdown codec now, while the connection may still be up (an offline send needs it).
  useEffect(() => {
    loadFeedbackMarkdown().catch(() => undefined);
  }, []);

  // The draft, if one waits; the Mac's capture of the window behind is offered unticked.
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
        const capture: Screenshot[] = snapshot.capture
          ? [
              {
                id: `capture-${Date.now()}`,
                name: 'This window.png',
                type: 'image/png',
                blob: snapshot.capture,
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
        setShots([...capture, ...kept]);
        setLoaded(true);
      });
    return () => {
      live = false;
    };
  }, [feedback, snapshot.capture]);

  // The description editor, once the draft is read.
  useEffect(() => {
    const host = editorHost.current;
    if (!loaded || !host) return;
    const editor = createFeedbackEditor({
      element: host,
      content: initialDescription.current,
      label: 'Description',
      describedBy: `${id}-desc-hint`,
      onUpdate: (current) => setDescription(current.getJSON()),
    });
    const bump = () => {
      const on = new Set<string>();
      for (const format of FEEDBACK_FORMATS) if (format.active(editor)) on.add(format.id);
      if (editor.isActive('link')) on.add('link');
      setActive(on);
    };
    editor.on('transaction', bump);
    editorRef.current = editor;
    return () => {
      editor.off('transaction', bump);
      editor.destroy();
      editorRef.current = null;
    };
    // Made once, from the draft as read; the editor holds the description after that.
  }, [loaded, id]);

  useLayoutEffect(() => {
    if (loaded) firstField.current?.focus();
  }, [loaded]);

  // The draft is written once typing pauses, and as the form closes, until it is sent.
  const unsaved = useRef<FeedbackDraftText | null>(null);
  const keepDraft = useRef(true);
  useEffect(() => {
    if (!loaded || status.kind !== 'idle') {
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
    }, 400);
    return () => clearTimeout(timer);
  }, [
    feedback,
    loaded,
    status.kind,
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
    if (!loaded || status.kind !== 'idle' || !keepDraft.current) return;
    void feedback.store
      .writeDraftScreenshots(shots)
      .catch((error: unknown) => console.error('[feedback] could not keep the screenshots', error));
  }, [feedback, loaded, status.kind, shots]);
  useEffect(
    () => () => {
      if (keepDraft.current && unsaved.current) writeDraft(feedback, unsaved.current);
    },
    [feedback],
  );

  const context = useMemo(() => kept ?? buildContext(facts), [kept, facts]);
  const sent = useMemo(() => withoutGroups(context, omitted), [context, omitted]);
  const preview = useMemo(() => contextMarkdown(sent), [sent]);

  const thumbs = useMemo(
    () => new Map(shots.map((shot) => [shot.id, URL.createObjectURL(shot.blob)])),
    [shots],
  );
  useEffect(
    () => () => {
      for (const url of thumbs.values()) URL.revokeObjectURL(url);
    },
    [thumbs],
  );

  const addFiles = (files: readonly File[]) => {
    setImageError(null);
    const added: Screenshot[] = [];
    for (const file of files) {
      const refused = checkImage(file);
      if (refused) {
        setImageError(refused);
        continue;
      }
      if (shots.length + added.length >= FEEDBACK_LIMITS.screenshots) {
        setImageError(`At most ${FEEDBACK_LIMITS.screenshots} screenshots.`);
        break;
      }
      added.push({
        id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        name: file.name || 'image',
        type: file.type,
        blob: file,
        included: true,
      });
    }
    if (added.length > 0) setShots((current) => [...current, ...added]);
  };

  const imageFiles = (list: FileList | null | undefined) =>
    [...(list ?? [])].filter((file) => file.type.startsWith('image/'));

  const onPaste = (event: ClipboardEvent<HTMLElement>) => {
    const files = imageFiles(event.clipboardData.files);
    if (files.length === 0) return;
    event.preventDefault();
    event.stopPropagation();
    addFiles(files);
  };

  const onDragOver = (event: DragEvent<HTMLElement>) => {
    if ([...event.dataTransfer.types].includes('Files')) event.preventDefault();
  };

  const onDrop = (event: DragEvent<HTMLElement>) => {
    const files = imageFiles(event.dataTransfer.files);
    if (files.length === 0) return;
    event.preventDefault();
    event.stopPropagation();
    addFiles(files);
  };

  const move = (index: number, by: -1 | 1) =>
    setShots((current) => {
      const next = [...current];
      const [shot] = next.splice(index, 1);
      next.splice(index + by, 0, shot!);
      return next;
    });

  const canCaptureTab =
    !desktop() &&
    // Never a git notebook's screen (A889).
    facts.where.git !== true &&
    typeof navigator !== 'undefined' &&
    typeof navigator.mediaDevices?.getDisplayMedia === 'function';

  const captureTab = async () => {
    setImageError(null);
    if (shots.length >= FEEDBACK_LIMITS.screenshots) {
      setImageError(`At most ${FEEDBACK_LIMITS.screenshots} screenshots.`);
      return;
    }
    try {
      const blob = await captureThisTab(setHidden);
      if (!blob) return;
      setShots((current) => [
        ...current,
        {
          id: `tab-${Date.now()}`,
          name: 'This tab.png',
          type: 'image/png',
          blob,
          included: true,
          source: 'tab',
        },
      ]);
    } catch {
      setImageError('The browser did not share this tab.');
    }
  };

  const answer = (attempt: Attempt) => {
    if (attempt.kind === 'sent') {
      // The toast says "Sent as #n" with the issue's link (FeedbackToasts).
      onClose();
      return;
    }
    setStatus(
      attempt.kind === 'failed'
        ? { kind: 'failed', error: attempt.error }
        : attempt.kind === 'elsewhere'
          ? { kind: 'elsewhere' }
          : { kind: 'queued', error: attempt.error },
    );
  };

  const send = async () => {
    if (status.kind !== 'idle') return;
    const found = problemsOf({ type, priority, title });
    setProblems(found);
    if (found.type) return firstField.current?.focus();
    if (found.priority) return priorityField.current?.focus();
    if (found.title) return titleField.current?.focus();
    setStatus({ kind: 'sending' });
    try {
      const current = editorRef.current?.getJSON() ?? description;
      const markdown = await feedbackMarkdown(current);
      const included = shots.filter((item) => item.included);
      const tooLong = sizeProblem({
        markdown,
        context: sent,
        screenshots: included.length,
        client: desktop() ? 'mac' : 'web',
        version: appVersion(),
        submissionId,
      });
      if (tooLong) {
        setProblems({ description: tooLong });
        setStatus({ kind: 'idle' });
        editorRef.current?.commands.focus();
        return;
      }
      const screenshots: Array<{ name: string; type: string; blob: Blob }> = [];
      for (const shot of included) {
        const blob = await prepareImage(shot.blob);
        const kind = blob === shot.blob ? shot.type : outputType(shot.type);
        screenshots.push({ name: nameFor(kind, screenshots.length), type: kind, blob });
      }
      const entry: OutboxEntry = {
        id: submissionId,
        createdAt: Date.now(),
        title: title.trim(),
        payload: JSON.stringify({
          submissionId,
          type,
          priority,
          title: title.trim(),
          description: markdown,
          version: appVersion(),
          context: sent,
        }),
        screenshots,
        state: 'queued',
        attempts: 0,
        nextAt: 0,
        error: null,
        // Kept with the entry until it is filed or discarded: a refusal can be edited (A796).
        draft: {
          submissionId,
          type,
          priority,
          title,
          description: current,
          omitted: [...omitted],
          context,
          updatedAt: Date.now(),
        },
      };
      keepDraft.current = false;
      const attempt = await feedback.outbox.enqueue(entry);
      // The entry holds the report now, with the form as sent; the form's draft can go.
      await feedback.store.writeDraft(null).catch(() => undefined);
      answer(attempt);
    } catch (error) {
      console.error('[feedback] could not send', error);
      keepDraft.current = true;
      setStatus({ kind: 'idle' });
      setImageError(error instanceof Error ? error.message : 'Could not prepare the feedback.');
    }
  };

  const discardDraft = async () => {
    keepDraft.current = false;
    await feedback.store.writeDraft(null).catch(() => undefined);
    onClose();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key === 'Escape') {
      if (linkHref !== null) {
        event.preventDefault();
        event.stopPropagation();
        setLinkHref(null);
        editorRef.current?.commands.focus();
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      onClose();
    } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      event.stopPropagation();
      if (!done) void send();
    }
  };

  const groupsShown = context.groups.map((group) => group.id);

  return (
    <div
      className="overlay feedback-overlay"
      data-testid="feedback-dialog"
      style={hidden ? { visibility: 'hidden' } : undefined}
    >
      <div
        className="dialog feedback-dlg"
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-h`}
        onKeyDown={onKeyDown}
        onPasteCapture={onPaste}
        onDragOver={onDragOver}
        onDrop={onDrop}
      >
        <header className="dlg-title">
          <h2 id={`${id}-h`}>Send Feedback</h2>
          <DialogClose label="Close" onClose={() => onClose()} />
        </header>
        {done ? (
          <FeedbackOutcome
            status={status}
            onClose={() => onClose()}
            onRetry={() => {
              setStatus({ kind: 'sending' });
              void feedback.outbox.retry(submissionId).then(answer);
            }}
            onDiscard={() => {
              void feedback.outbox.discard(submissionId).then(() => onClose());
            }}
            onEdit={() => {
              void feedback.editEntry(submissionId).then((result) => {
                if (result === 'ok') onReopen();
                else onClose();
              });
            }}
          />
        ) : (
          <form
            className="feedback-form"
            data-testid="feedback-form"
            noValidate
            aria-busy={!loaded || status.kind === 'sending'}
            onSubmit={(event) => {
              event.preventDefault();
              void send();
            }}
          >
            <div className="feedback-body">
              <p className="muted feedback-intro">
                Files an issue on the Penmoss board for Ryan. It says where you are in the app and
                what is on screen, never what your notes say.
              </p>
              <fieldset
                className="feedback-choice"
                aria-describedby={problems.type ? `${id}-type-error` : undefined}
              >
                <legend>Type</legend>
                <div className="segmented">
                  {FEEDBACK_TYPES.map((value, index) => (
                    <label key={value} className="segment">
                      <input
                        ref={index === 0 ? firstField : undefined}
                        type="radio"
                        name={`${id}-type`}
                        value={value}
                        checked={type === value}
                        aria-invalid={problems.type ? true : undefined}
                        data-testid={`feedback-type-${value}`}
                        onChange={() => setType(value)}
                      />
                      <span data-label={FEEDBACK_TYPE_LABELS[value]}>
                        {FEEDBACK_TYPE_LABELS[value]}
                      </span>
                    </label>
                  ))}
                </div>
                {problems.type ? (
                  <p id={`${id}-type-error`} className="field-error">
                    {problems.type}
                  </p>
                ) : null}
              </fieldset>
              <fieldset
                className="feedback-choice"
                aria-describedby={problems.priority ? `${id}-priority-error` : undefined}
              >
                <legend>Priority</legend>
                <div className="segmented">
                  {FEEDBACK_PRIORITIES.map((value, index) => (
                    <label key={value} className="segment">
                      <input
                        ref={index === 0 ? priorityField : undefined}
                        type="radio"
                        name={`${id}-priority`}
                        value={value}
                        checked={priority === value}
                        aria-invalid={problems.priority ? true : undefined}
                        data-testid={`feedback-priority-${value}`}
                        onChange={() => setPriority(value)}
                      />
                      <span data-label={FEEDBACK_PRIORITY_LABELS[value]}>
                        {FEEDBACK_PRIORITY_LABELS[value]}
                      </span>
                    </label>
                  ))}
                </div>
                {problems.priority ? (
                  <p id={`${id}-priority-error`} className="field-error">
                    {problems.priority}
                  </p>
                ) : null}
              </fieldset>
              <div className="feedback-field">
                <label htmlFor={`${id}-title`}>Title</label>
                <input
                  ref={titleField}
                  id={`${id}-title`}
                  className="feedback-title"
                  data-testid="feedback-title"
                  value={title}
                  maxLength={FEEDBACK_LIMITS.titleMax}
                  autoComplete="off"
                  aria-invalid={problems.title ? true : undefined}
                  aria-describedby={`${id}-title-count${problems.title ? ` ${id}-title-error` : ''}`}
                  onChange={(event) => setTitle(event.target.value.replace(/[\r\n]+/g, ' '))}
                />
                <span id={`${id}-title-count`} className="muted feedback-count">
                  {title.length}/{FEEDBACK_LIMITS.titleMax}
                </span>
                {problems.title ? (
                  <p id={`${id}-title-error`} className="field-error">
                    {problems.title}
                  </p>
                ) : null}
              </div>
              <div className="feedback-field">
                <span id={`${id}-desc-label`} className="feedback-label">
                  Description
                </span>
                <div className="feedback-toolbar" role="toolbar" aria-label="Formatting">
                  {FEEDBACK_FORMATS.map((format) => (
                    <button
                      key={format.id}
                      type="button"
                      className="icon-btn feedback-format"
                      data-ui="option"
                      data-testid={`feedback-format-${format.id}`}
                      aria-pressed={
                        ['indent', 'outdent'].includes(format.id)
                          ? undefined
                          : active.has(format.id)
                      }
                      aria-keyshortcuts={ariaKeyShortcuts([keysOf(format.keys)]) || undefined}
                      data-tip={`${format.label} (${formatCombo(keysOf(format.keys))})`}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => {
                        const editor = editorRef.current;
                        if (editor) format.run(editor);
                      }}
                    >
                      {ICONS[format.id] ? (
                        <Icon name={ICONS[format.id]!} />
                      ) : (
                        <span className="feedback-format-glyph" aria-hidden="true">
                          {GLYPHS[format.id]}
                        </span>
                      )}
                      <span className="sr-only">{format.label}</span>
                    </button>
                  ))}
                  <button
                    type="button"
                    className="icon-btn feedback-format"
                    data-ui="option"
                    data-testid="feedback-format-link"
                    aria-pressed={active.has('link')}
                    aria-expanded={linkHref !== null}
                    data-tip="Link"
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() =>
                      setLinkHref(
                        linkHref === null
                          ? ((editorRef.current?.getAttributes('link')['href'] as
                              string | undefined) ?? '')
                          : null,
                      )
                    }
                  >
                    <Icon name="link" />
                    <span className="sr-only">Link</span>
                  </button>
                </div>
                {linkHref !== null ? (
                  <div className="feedback-link">
                    <label className="sr-only" htmlFor={`${id}-link`}>
                      Link address
                    </label>
                    <input
                      id={`${id}-link`}
                      type="url"
                      autoFocus
                      placeholder="https://"
                      value={linkHref}
                      data-testid="feedback-link-href"
                      onChange={(event) => setLinkHref(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          event.preventDefault();
                          if (editorRef.current && setFeedbackLink(editorRef.current, linkHref))
                            setLinkHref(null);
                        }
                      }}
                    />
                    <button
                      type="button"
                      className="btn"
                      data-ui="submit"
                      onClick={() => {
                        if (editorRef.current && setFeedbackLink(editorRef.current, linkHref))
                          setLinkHref(null);
                      }}
                    >
                      Apply
                    </button>
                    <button
                      type="button"
                      className="btn quiet"
                      data-ui="dismiss"
                      onClick={() => {
                        if (editorRef.current) setFeedbackLink(editorRef.current, '');
                        setLinkHref(null);
                      }}
                    >
                      Remove Link
                    </button>
                  </div>
                ) : null}
                <div
                  ref={editorHost}
                  className="feedback-editor"
                  aria-labelledby={`${id}-desc-label`}
                />
                <p id={`${id}-desc-hint`} className="muted feedback-hint">
                  Sent as GitHub markdown: bold, italic, lists, links, code and quotes. Tab and
                  Shift+Tab nest list items.
                </p>
                {problems.description ? (
                  <p role="alert" className="field-error" data-testid="feedback-description-error">
                    {problems.description}
                  </p>
                ) : null}
              </div>
              <div className="feedback-field">
                <span className="feedback-label" id={`${id}-shots`}>
                  Screenshots
                </span>
                <p className="muted feedback-hint">
                  Up to {FEEDBACK_LIMITS.screenshots} PNG, JPEG, WebP or GIF images, 10 MB each:
                  paste, drop or choose them.
                </p>
                {shots.length > 0 ? (
                  <ul
                    className="feedback-shots"
                    aria-labelledby={`${id}-shots`}
                    data-testid="feedback-shots"
                  >
                    {shots.map((shot, index) => (
                      <li key={shot.id} className="feedback-shot" data-testid="feedback-shot">
                        <img
                          src={thumbs.get(shot.id)}
                          alt={`Screenshot ${index + 1}: ${shot.name}`}
                        />
                        <label className="feedback-shot-include">
                          <input
                            type="checkbox"
                            checked={shot.included}
                            data-testid="feedback-shot-include"
                            onChange={(event) => {
                              const included = event.target.checked;
                              setShots((current) =>
                                current.map((item) =>
                                  item.id === shot.id ? { ...item, included } : item,
                                ),
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
                    data-testid="feedback-add-image"
                    onClick={() => fileInput.current?.click()}
                  >
                    <Icon name="plus" />
                    Add Images…
                  </button>
                  {canCaptureTab ? (
                    <button
                      type="button"
                      className="btn"
                      data-ui="item"
                      data-testid="feedback-capture-tab"
                      onClick={() => void captureTab()}
                    >
                      Capture This Window
                    </button>
                  ) : null}
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
              {kept ? (
                <p className="muted feedback-hint" data-testid="feedback-context-kept">
                  This report keeps the context it was captured with, not this screen’s.
                </p>
              ) : null}
              <details className="feedback-context" data-testid="feedback-context">
                <summary>Captured Context</summary>
                <p className="muted feedback-hint">
                  Exactly what the issue will hold besides your words and screenshots. Untick a
                  group to leave it out.
                </p>
                <fieldset className="feedback-groups">
                  <legend className="sr-only">Groups to send</legend>
                  {groupsShown.map((group) => (
                    <label key={group}>
                      <input
                        type="checkbox"
                        checked={!omitted.has(group)}
                        data-testid={`feedback-group-${group}`}
                        onChange={(event) => {
                          const next = new Set(omitted);
                          if (event.target.checked) next.delete(group);
                          else next.add(group);
                          setOmitted(next);
                        }}
                      />
                      {FEEDBACK_GROUP_TITLES[group]}
                    </label>
                  ))}
                </fieldset>
                <pre
                  className="feedback-preview"
                  data-testid="feedback-preview"
                  tabIndex={0}
                  aria-label="The captured context as the issue will hold it"
                >
                  {preview || 'Nothing: every group is left out.'}
                </pre>
              </details>
            </div>
            <footer className="feedback-foot">
              <span role="status" className="muted" data-testid="feedback-status">
                {status.kind === 'sending' ? 'Sending…' : ''}
              </span>
              <span className="row">
                <button
                  type="button"
                  className="btn quiet"
                  data-ui="dismiss"
                  data-testid="feedback-discard"
                  onClick={() => void discardDraft()}
                >
                  Discard
                </button>
                <button
                  type="submit"
                  className="btn primary"
                  data-ui="submit"
                  data-testid="feedback-send"
                  disabled={!loaded || status.kind === 'sending'}
                  aria-keyshortcuts={ariaKeyShortcuts([SEND_KEYS])}
                >
                  Send <span className="keys">{formatCombo(SEND_KEYS)}</span>
                </button>
              </span>
            </footer>
          </form>
        )}
      </div>
    </div>
  );
}

/** The toolbar's icons, and glyphs where the icon set has none. */
const ICONS: Readonly<Record<string, IconName>> = {
  bold: 'bold',
  italic: 'italic',
  code: 'code',
  bulletList: 'list',
};
const GLYPHS: Readonly<Record<string, string>> = {
  orderedList: '1.',
  indent: '→',
  outdent: '←',
  blockquote: '❝',
  codeBlock: '{ }',
};

/** After Send, when it did not go at once: queued (offline) or kept with its error. */
function FeedbackOutcome({
  status,
  onClose,
  onRetry,
  onDiscard,
  onEdit,
}: {
  status: Status;
  onClose: () => void;
  onRetry: () => void;
  onDiscard: () => void;
  onEdit: () => void;
}) {
  const close = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => close.current?.focus(), []);
  return (
    <div className="feedback-outcome" data-testid="feedback-outcome">
      {status.kind === 'queued' && status.error?.code === 'no_github_token' ? (
        // The Mac files it with the person's own token (T57, A1012): it waits for one.
        <p role="status" data-testid="feedback-queued">
          Queued. {status.error.message}
        </p>
      ) : status.kind === 'queued' ? (
        <p role="status" data-testid="feedback-queued">
          Queued, will send when you’re online.
          {status.error && status.error.status !== 0 ? ` (${status.error.message})` : ''}
        </p>
      ) : status.kind === 'elsewhere' ? (
        <p role="status" data-testid="feedback-elsewhere">
          Queued: another Penmoss window is sending feedback now, and this goes next.
        </p>
      ) : status.kind === 'failed' ? (
        <p role="alert" data-testid="feedback-failed">
          Not sent: {status.error.message.replace(/\.$/, '')}. It’s kept in Settings → Status, where
          you can edit, retry or discard it.
        </p>
      ) : null}
      <div className="row">
        {status.kind === 'failed' ? (
          <>
            <button type="button" className="btn quiet" data-ui="dismiss" onClick={onDiscard}>
              Discard
            </button>
            <button
              type="button"
              className="btn"
              data-ui="item"
              data-testid="feedback-edit"
              onClick={onEdit}
            >
              Edit
            </button>
            <button type="button" className="btn" data-ui="submit" onClick={onRetry}>
              Retry
            </button>
          </>
        ) : null}
        <button
          ref={close}
          type="button"
          className="btn primary"
          data-ui="dismiss"
          data-testid="feedback-close"
          onClick={onClose}
        >
          Close
        </button>
      </div>
    </div>
  );
}
