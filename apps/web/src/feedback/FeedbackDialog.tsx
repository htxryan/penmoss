/**
 * The Send feedback form (T49, D41) on the web and in the Mac app: type, priority, title, a
 * description in the Penmoss editor's reduced schema (A790), screenshots, and the captured
 * context exactly as the issue will hold it, with a checkbox per group (A791), and in the Mac
 * app a bug report's anonymised logs, exactly as attached (PEN-137). An unsent form is a draft
 * kept on this device; a sent one goes through the outbox, so offline it waits (A796), with the
 * logs it previewed.
 */
import { countBucket } from '@penmoss/core/analytics';
import {
  contextMarkdown,
  FEEDBACK_GROUP_TITLES,
  FEEDBACK_LIMITS,
  FEEDBACK_PRIORITIES,
  FEEDBACK_PRIORITY_LABELS,
  FEEDBACK_TYPE_LABELS,
  FEEDBACK_TYPES,
  withoutGroups,
} from '@penmoss/core/feedback';
import {
  createFeedbackEditor,
  feedbackMarkdown,
  loadFeedbackMarkdown,
  FEEDBACK_FORMATS,
  type FeedbackEditor,
} from '@penmoss/editor/feedback';
import { ariaKeyShortcuts, formatCombo } from '@penmoss/editor/keys';
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
import { useTrackedDialog, type TrackedDialog } from '../analytics/dialog';
import { useTypedChars, useTypedLength } from '../analytics/typed';
import { record } from '../analytics/record';
import { useCommands } from '../commands/hooks';
import { DialogClose } from '../shell/DialogClose';
import { Segmented } from '../shell/Segmented';
import { buildContext, type ContextFacts } from './context';
import { checkImage, nameFor, outputType, prepareImage, type Screenshot } from './images';
import { appVersion } from './open';
import type { Attempt } from './outbox';
import { problemsOf, sizeProblem, type Problems } from './problems';
import { useFeedbackDraft } from './draft';
import { FeedbackOutbox } from './FeedbackOutbox';
import { FeedbackFormatting } from './FeedbackFormatting';
import { FeedbackLogs } from './FeedbackLogs';
import { FeedbackOutcome, type Status } from './FeedbackOutcome';
import { FeedbackScreenshots } from './FeedbackScreenshots';
import { useReportLogs } from './report-logs';
import { useFeedbackService } from './service';
import type { OutboxEntry } from './store';

const SEND_KEYS = 'Mod+Enter';

/** What the form was opened with: the context and the Mac's capture, read before it drew. */
export interface FeedbackSnapshot {
  readonly facts: ContextFacts;
  readonly capture: Blob | null;
}

/** The description's length in characters, each line break one, as Android counts its field's. */
const bodyLength = (editor: {
  getText: (options?: { readonly blockSeparator?: string }) => string;
}): number => editor.getText({ blockSeparator: '\n' }).length;

export function FeedbackDialog({
  snapshot,
  onClose,
}: {
  snapshot: FeedbackSnapshot;
  onClose: (restoreFocus?: boolean) => void;
}) {
  // Edit after a refusal reads the report back from the outbox: the form starts again with it.
  const [round, setRound] = useState(0);
  const tracked = useTrackedDialog('feedback');
  return (
    <FeedbackForm
      key={round}
      snapshot={snapshot}
      tracked={tracked}
      onClose={onClose}
      onReopen={() => setRound((n) => n + 1)}
    />
  );
}

function FeedbackForm({
  snapshot,
  tracked,
  onClose,
  onReopen,
}: {
  snapshot: FeedbackSnapshot;
  tracked: TrackedDialog;
  onClose: (restoreFocus?: boolean) => void;
  onReopen: () => void;
}) {
  const feedback = useFeedbackService();
  const commands = useCommands();
  const id = useId();
  const { facts } = snapshot;

  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const draft = useFeedbackDraft(feedback, snapshot.capture, status.kind === 'idle');
  const {
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
    keptLogs,
  } = draft;
  const logs = useReportLogs(loaded, keptLogs, facts.private.logNames ?? facts.private.names);
  /** Attach Anonymised Logs: ticked for a bug report (O6). */
  const [attachLogs, setAttachLogs] = useState(true);
  const sendsLogs = type === 'bug' && attachLogs && logs !== null && logs.lines.length > 0;
  const [problems, setProblems] = useState<Problems>({});
  const [imageError, setImageError] = useState<string | null>(null);
  const [linkHref, setLinkHref] = useState<string | null>(null);
  // What is typed in the title and a link's address, by length only (PEN-177).
  const typedTitle = useTypedLength('feedback', 'title', title);
  const typedLink = useTypedLength('feedback', 'url', linkHref ?? '');
  // And the description's, once its editor holds the draft (the draft's length is where it starts).
  const [bodyChars, setBodyChars] = useState<number | null>(null);
  const typedBody = useTypedChars('feedback', 'body', bodyChars);
  /** Which formats the selection has, for the toolbar's pressed states (read on each change). */
  const [active, setActive] = useState<ReadonlySet<string>>(new Set());
  const dialog = useRef<HTMLDivElement>(null);
  const editorHost = useRef<HTMLDivElement>(null);
  const editorRef = useRef<FeedbackEditor | null>(null);
  const firstField = useRef<HTMLInputElement>(null);
  const titleField = useRef<HTMLInputElement>(null);
  const priorityField = useRef<HTMLInputElement>(null);
  const done = status.kind === 'queued' || status.kind === 'failed' || status.kind === 'elsewhere';

  // The dispatcher stands aside while the form is open: its keys are the form's and the
  // description editor's (bold, italic, lists), not the app's (T49).
  useEffect(() => commands.suspend(), [commands]);
  // The markdown codec now, while the connection may still be up (an offline send needs it).
  useEffect(() => {
    loadFeedbackMarkdown().catch(() => undefined);
  }, []);

  // The description editor, once the draft is read.
  useEffect(() => {
    const host = editorHost.current;
    if (!loaded || !host) return;
    const editor = createFeedbackEditor({
      element: host,
      content: initialDescription.current,
      label: 'Description',
      describedBy: `${id}-desc-hint`,
      onUpdate: (current) => {
        setDescription(current.getJSON());
        setBodyChars(bodyLength(current));
      },
    });
    setBodyChars(bodyLength(editor));
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
    // Made once, from the draft as read; the editor holds the description after that (the ref
    // and the setter never change).
  }, [loaded, id, initialDescription, setDescription]);

  // Focus is in the form from the moment it shows, so Escape closes it even before the draft is
  // read (on a slow disk Escape did nothing, and the button behind kept focus); the first field
  // takes it once the draft is in.
  useLayoutEffect(() => {
    if (!dialog.current?.contains(document.activeElement)) dialog.current?.focus();
  }, []);
  useLayoutEffect(() => {
    if (loaded) firstField.current?.focus();
  }, [loaded]);

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
        client: 'mac',
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
          // Exactly the lines the form showed (PEN-137); kept with the entry while it waits.
          ...(sendsLogs ? { logs: logs.lines } : {}),
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
          ...(logs ? { logs: logs.lines } : {}),
          updatedAt: Date.now(),
        },
      };
      draft.keeping(false);
      const attempt = await feedback.outbox.enqueue(entry);
      // The report by name (PEN-137): its type and priority, and counts, never its words.
      tracked.done();
      record('feedback', 'sent', {
        type: type!,
        priority: priority!,
        screenshots: countBucket(included.length),
        logs: sendsLogs,
        groupsLeftOut: countBucket(omitted.size),
      });
      // The entry holds the report now, with the form as sent; the form's draft can go.
      await draft.clear();
      answer(attempt);
    } catch (error) {
      console.error('[feedback] could not send', error);
      draft.keeping(true);
      setStatus({ kind: 'idle' });
      setImageError(error instanceof Error ? error.message : 'Could not prepare the feedback.');
    }
  };

  const discardDraft = async () => {
    draft.keeping(false);
    await draft.clear();
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
    <div className="overlay feedback-overlay" data-testid="feedback-dialog">
      <div
        ref={dialog}
        tabIndex={-1}
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
              {/* Reports not sent yet wait here, where they were written (PEN-146). */}
              <FeedbackOutbox
                feedback={feedback}
                onEdit={async (entryId) => {
                  // The form's own draft must not be written over the one Edit reads back.
                  draft.keeping(false);
                  const result = await feedback.editEntry(entryId);
                  if (result === 'ok') onReopen();
                  else draft.keeping(true);
                  return result;
                }}
              />
              <fieldset
                className="feedback-choice"
                aria-describedby={problems.type ? `${id}-type-error` : undefined}
              >
                <legend>Type</legend>
                <Segmented
                  name={`${id}-type`}
                  value={type}
                  options={FEEDBACK_TYPES.map((value) => ({
                    value,
                    label: FEEDBACK_TYPE_LABELS[value],
                    testId: `feedback-type-${value}`,
                  }))}
                  event="feedback.type"
                  invalid={Boolean(problems.type)}
                  firstRef={firstField}
                  onChange={setType}
                />
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
                <Segmented
                  name={`${id}-priority`}
                  value={priority}
                  options={FEEDBACK_PRIORITIES.map((value) => ({
                    value,
                    label: FEEDBACK_PRIORITY_LABELS[value],
                    testId: `feedback-priority-${value}`,
                  }))}
                  event="feedback.priority"
                  invalid={Boolean(problems.priority)}
                  firstRef={priorityField}
                  onChange={setPriority}
                />
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
                  {...typedTitle}
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
                <FeedbackFormatting
                  id={id}
                  editorRef={editorRef}
                  active={active}
                  linkHref={linkHref}
                  setLinkHref={setLinkHref}
                  typedLink={typedLink}
                />
                <div
                  ref={editorHost}
                  className="feedback-editor"
                  aria-labelledby={`${id}-desc-label`}
                  {...typedBody}
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
              <FeedbackScreenshots
                id={id}
                shots={shots}
                setShots={setShots}
                thumbs={thumbs}
                addFiles={addFiles}
                imageError={imageError}
              />
              {kept ? (
                <p className="muted feedback-hint" data-testid="feedback-context-kept">
                  This report keeps the context it was captured with, not this screen’s.
                </p>
              ) : null}
              <details className="feedback-context" data-testid="feedback-context">
                <summary data-event="feedback.context.preview">Captured Context</summary>
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
                        data-event="feedback.context.group"
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
              {/* A bug report's logs, after the context (PEN-137, O6): none for a feature request. */}
              {logs && type !== 'feature' ? (
                <FeedbackLogs id={id} logs={logs} attach={attachLogs} onAttach={setAttachLogs} />
              ) : null}
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
                  data-event="feedback.discard"
                  data-testid="feedback-discard"
                  onClick={() => void discardDraft()}
                >
                  Discard
                </button>
                <button
                  type="submit"
                  className="btn primary"
                  data-ui="submit"
                  data-event="feedback.send"
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
