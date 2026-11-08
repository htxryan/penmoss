/**
 * The Comments panel (T48): a note's threads beside it, where the Info panel goes, in the order
 * of the text with orphans last, open ones or the resolved ones (A777: kept, behind a filter).
 * Each shows its quote, every comment attributed (an agent's marked ✦), and where delivery to
 * the agent session it was sent to stands (A1061, A1062). Ryan replies, resolves and reopens,
 * edits his own comments, removes an agent's (its undo; an agent's resolve is undone by
 * reopening), and sends a thread to one Claude Code session with Send to… (A1065): the sessions
 * are listed in the notebook's WorkspaceDoc (A1060), and a send syncs the notebook at once and
 * watches for the reply (A1072). Everything is written to the note's document, so it works
 * offline and syncs like an edit, without being one (A770).
 *
 * T52 item 5: a new thread on a passage, and a thread opened from its passage or from this list,
 * float over the note at the passage (CommentPopover.tsx, with this file's `CommentDraft` and
 * `CommentThread`). The list keeps every thread, threads on the note as a whole first; Add Note
 * Comment starts one of those here.
 */
import type { CommentTarget, PlacedThread } from '@penmoss/sync-client/comments';
import { isActive, offeredSessions, type AgentSession } from '@penmoss/sync-client/agent-sessions';
import type { Yjs14Replica } from '@penmoss/sync-client/yjs14';
import type { SelectionAnchor } from '@penmoss/editor';
import { isNoteThread } from '@penmoss/sync-client/comments';
import { Select } from '@penmoss/ui/controls/Select';
import { Icon } from '@penmoss/ui/icons';
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
} from 'react';
import { useCommands } from '../commands/hooks';
import { useSource } from '../sources/hooks';
import { shortWhen } from '../shell/when';
import {
  canEdit,
  canRemove,
  deliveryText,
  deviceAuthor,
  edit,
  remove,
  removeThread,
  reply,
  resolve,
  sendTo,
  startNoteThread,
  startThread,
  targetOf,
} from './comments';

export type CommentsFilter = 'open' | 'resolved';

/** Mod+Enter (Ctrl+Enter) sends what is typed. */
const sends = (event: KeyboardEvent) =>
  event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing;

const sameSessions = (a: readonly AgentSession[], b: readonly AgentSession[]) =>
  a.length === b.length &&
  a.every(
    (one, i) =>
      one.key === b[i]!.key && one.lastSeen === b[i]!.lastSeen && one.label === b[i]!.label,
  );

interface Offered {
  readonly sessions: readonly AgentSession[];
  /** When they were read: what "running" was judged against. */
  readonly now: number;
}

/** The last list read of each WorkspaceDoc, so an unchanged list is the same value. */
const offeredOf = new WeakMap<object, Offered>();

function readOffered(doc: object & Parameters<typeof offeredSessions>[0]): Offered {
  const now = Date.now();
  const sessions = offeredSessions(doc, now);
  const previous = offeredOf.get(doc);
  if (previous && sameSessions(previous.sessions, sessions)) return previous;
  const next = { sessions, now };
  offeredOf.set(doc, next);
  return next;
}

const NO_SUBSCRIPTION = () => () => undefined;

/**
 * The sessions Send to… offers (A1060): those in the note's notebook's WorkspaceDoc seen within
 * 7 days, running ones first, kept current as it syncs. Null outside a notebook (no source).
 */
function useOfferedSessions(): Offered | null {
  const source = useSource();
  const read = () => (source ? readOffered(source.workspace.doc) : null);
  return useSyncExternalStore(source?.workspace.subscribe ?? NO_SUBSCRIPTION, read, read);
}

/**
 * After a Send to, or Ryan's comment in a thread sent to a session (A1061, A1072): the notebook
 * syncs at once and watches the thread for its reply.
 */
function useAgentSent(noteId: string): (threadId: string) => void {
  const source = useSource();
  return useCallback(
    (threadId: string) => void source?.agentSent(noteId, threadId).catch(() => undefined),
    [source, noteId],
  );
}

/** How a session reads in the picker: its label, and its name when another shares the label. */
function sessionText(session: AgentSession, all: readonly AgentSession[], now: number): string {
  const label = all.some((other) => other !== session && other.label === session.label)
    ? `${session.label} · ${session.name}`
    : session.label;
  return isActive(session, now)
    ? label
    : `${label} (last seen ${shortWhen(session.lastSeen, now)})`;
}

/** Send to…: one agent session of the note's notebook, or nobody (A1065). */
function SendTo({
  value,
  onChange,
  testId,
  autoFocus = false,
  draft = false,
}: {
  /** The thread's target now (null: nobody). */
  readonly value: CommentTarget | null;
  readonly onChange: (target: CommentTarget | null) => void;
  readonly testId: string;
  readonly autoFocus?: boolean;
  /** A new thread's: nothing is being sent yet, so there is nothing to stop. */
  readonly draft?: boolean;
}) {
  const id = useId();
  const offered = useOfferedSessions();
  const field = useRef<HTMLSelectElement>(null);
  // Once the sessions are read: before then there is no field.
  const shown = offered !== null;
  useEffect(() => {
    if (autoFocus && shown) field.current?.focus();
  }, [autoFocus, shown]);
  if (!offered) return null;
  const { sessions, now } = offered;
  const running = sessions.filter((session) => isActive(session, now));
  const others = sessions.filter((session) => !isActive(session, now));
  const current = value?.session ?? '';
  const option = (session: AgentSession) => (
    <option
      key={session.key}
      value={session.key}
      className={isActive(session, now) ? undefined : 'comment-send-idle'}
      data-running={isActive(session, now) ? 'true' : 'false'}
    >
      {sessionText(session, sessions, now)}
    </option>
  );
  return (
    <span className="comment-send">
      <label htmlFor={id}>Send to</label>
      <Select
        id={id}
        ref={field}
        value={current}
        data-testid={testId}
        onChange={(event) => {
          const chosen = sessions.find((session) => session.key === event.target.value);
          onChange(chosen ? targetOf(chosen) : null);
        }}
      >
        <option value="">{value && !draft ? 'Stop sending' : 'Nobody'}</option>
        {value && !sessions.some((session) => session.key === value.session) ? (
          // Sent to a session no longer offered (not seen for a week): it stays named.
          <option value={value.session} disabled>
            {value.label}
          </option>
        ) : null}
        {running.length > 0 ? <optgroup label="Running">{running.map(option)}</optgroup> : null}
        {others.length > 0 ? <optgroup label="Not running">{others.map(option)}</optgroup> : null}
      </Select>
      {sessions.length === 0 ? (
        <span className="comment-send-error" data-testid={`${testId}-none`}>
          No agent sessions yet: start one with <code>penmoss mcp --notebook … --channel</code>{' '}
          (Settings → Git Notebooks → Agents on This Mac).
        </span>
      ) : null}
    </span>
  );
}

function Composer({
  label,
  placeholder,
  onSend,
  onCancel,
  autoFocus,
  initial = '',
  testId,
}: {
  readonly label: string;
  readonly placeholder: string;
  readonly onSend: (body: string) => void;
  readonly onCancel?: () => void;
  readonly autoFocus?: boolean;
  readonly initial?: string;
  readonly testId: string;
}) {
  const [body, setBody] = useState(initial);
  const field = useRef<HTMLTextAreaElement>(null);
  const sendButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (autoFocus) field.current?.focus();
  }, [autoFocus]);
  const send = () => {
    const text = body.trim();
    if (!text) return;
    onSend(text);
    setBody('');
    // Send, emptied, turns disabled and would drop its focus to the page, where Escape no longer
    // reaches the thread it sits in: back to the field. Not when sending moved focus on (a new
    // thread's composer closes and gives the note its focus back).
    if (document.activeElement === sendButton.current) field.current?.focus();
  };
  return (
    <div className="comment-composer">
      <textarea
        ref={field}
        className="input"
        rows={2}
        aria-label={label}
        placeholder={placeholder}
        value={body}
        data-testid={testId}
        onChange={(event) => setBody(event.target.value)}
        onKeyDown={(event) => {
          if (sends(event)) {
            event.preventDefault();
            send();
          } else if (event.key === 'Escape' && onCancel) {
            event.preventDefault();
            onCancel();
          }
        }}
      />
      <span className="comment-composer-actions">
        {onCancel ? (
          <button type="button" className="btn quiet" data-ui="dismiss" onClick={onCancel}>
            Cancel
          </button>
        ) : null}
        <button
          ref={sendButton}
          type="button"
          className="btn primary"
          data-ui="submit"
          disabled={body.trim() === ''}
          onClick={send}
          data-testid={`${testId}-send`}
        >
          {label}
        </button>
      </span>
    </div>
  );
}

function Quote({ placed, onShow }: { readonly placed: PlacedThread; readonly onShow: () => void }) {
  const { thread, anchor } = placed;
  if (isNoteThread(thread)) {
    return (
      <p className="comment-quote comment-quote-whole" data-testid="comment-note-level">
        <Icon name="comment" size={12} />
        The note as a whole
      </p>
    );
  }
  if (anchor.orphaned) {
    return (
      <p className="comment-quote orphaned" data-testid="comment-orphaned">
        <span className="comment-quote-note">The text this was on was deleted</span>
        {thread.quote ? <s>{thread.quote}</s> : null}
      </p>
    );
  }
  const point = thread.anchor?.to == null;
  return (
    <button
      type="button"
      className="comment-quote"
      data-ui="item"
      onClick={onShow}
      title="Show in the Note"
      data-testid="comment-quote"
    >
      {point ? <span className="comment-quote-note">At a point in</span> : null}
      {thread.quote || 'The note as a whole'}
    </button>
  );
}

/** One thread: in the Comments list, or floating over the note at its passage (`floating`). */
export function CommentThread({
  placed,
  noteId,
  replica,
  active,
  onActivate,
  onResolved,
  compose = true,
  floating = false,
}: {
  readonly placed: PlacedThread;
  readonly noteId: string;
  readonly replica: Yjs14Replica;
  readonly active: boolean;
  readonly onActivate: (reveal: boolean) => void;
  /** Resolved: no longer the thread picked, so the open list stays shown. */
  readonly onResolved: () => void;
  /** Reply and Send to… while active (in the list: unless it is floating over the note). */
  readonly compose?: boolean;
  /** Floating over the note (CommentPopover): the list does not scroll to it. */
  readonly floating?: boolean;
}) {
  const { thread } = placed;
  const author = () => deviceAuthor();
  const sent = useAgentSent(noteId);
  const [editing, setEditing] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  /** Send to again, after the session was gone (A1062): the picker, wherever the thread is. */
  const [again, setAgain] = useState(false);
  const ref = useRef<HTMLDivElement & HTMLLIElement>(null);
  useEffect(() => {
    if (active && !floating) ref.current?.scrollIntoView?.({ block: 'nearest' });
  }, [active, floating]);
  const Root = floating ? 'div' : 'li';
  const delivery = deliveryText(thread);
  const resolved = thread.status === 'resolved';
  const gone = thread.delivery?.state === 'failed' && thread.delivery.reason === 'gone';
  const send = (target: CommentTarget | null) => {
    setAgain(false);
    if (sendTo(replica, thread.id, target)) sent(thread.id);
  };
  const composing = active && compose && !resolved;
  return (
    <Root
      ref={ref}
      className="comment-thread"
      data-active={active ? 'true' : undefined}
      data-status={thread.status}
      data-thread={thread.id}
      data-testid={floating ? 'comment-floating-thread' : 'comment-thread'}
    >
      <Quote placed={placed} onShow={() => onActivate(true)} />
      <ol className="comment-list">
        {thread.comments.map((comment, index) => (
          <li
            key={comment.id}
            className="comment"
            data-author={comment.author.kind}
            data-testid="comment"
          >
            <p className="comment-meta">
              <span className="comment-author" data-testid="comment-author">
                {comment.author.kind === 'agent' ? '✦ ' : ''}
                {comment.author.label}
              </span>
              <span className="comment-when">
                {shortWhen(comment.at)}
                {comment.edited ? ' · edited' : ''}
              </span>
              <span className="comment-tools">
                {canEdit(comment.author) && !comment.removed && editing !== comment.id ? (
                  <button
                    type="button"
                    className="icon-btn"
                    data-ui="item"
                    aria-label="Edit Comment"
                    data-tip="Edit"
                    onClick={() => setEditing(comment.id)}
                  >
                    <Icon name="pencil" size={14} />
                  </button>
                ) : null}
                {canRemove(thread, index) ? (
                  <button
                    type="button"
                    className="icon-btn"
                    aria-label={
                      comment.author.kind === 'agent'
                        ? `Remove ${comment.author.label}’s Comment`
                        : 'Delete Comment'
                    }
                    data-tip={comment.author.kind === 'agent' ? 'Remove' : 'Delete'}
                    data-ui="item"
                    data-testid="comment-remove"
                    onClick={() => remove(replica, thread.id, comment.id)}
                  >
                    <Icon name={comment.author.kind === 'agent' ? 'undo' : 'trash'} size={14} />
                  </button>
                ) : null}
              </span>
            </p>
            {editing === comment.id ? (
              <Composer
                label="Save"
                placeholder="Comment"
                initial={comment.body}
                autoFocus
                testId="comment-edit"
                onSend={(body) => {
                  edit(replica, thread.id, comment.id, body);
                  setEditing(null);
                }}
                onCancel={() => setEditing(null)}
              />
            ) : comment.removed ? (
              <p className="comment-body comment-removed" data-testid="comment-removed">
                Comment removed
              </p>
            ) : (
              <p className="comment-body" data-testid="comment-body">
                {comment.body}
              </p>
            )}
          </li>
        ))}
      </ol>
      {resolved && thread.resolvedBy ? (
        <p className="comment-state" data-testid="comment-resolved-by">
          Resolved by {thread.resolvedBy.kind === 'agent' ? '✦ ' : ''}
          {thread.resolvedBy.label}
          {thread.resolvedAt ? ` · ${shortWhen(thread.resolvedAt)}` : ''}
        </p>
      ) : null}
      {delivery && !resolved ? (
        <p
          className="comment-state"
          data-state={thread.delivery?.state ?? 'sending'}
          data-testid="comment-delivery"
        >
          {delivery}
          {gone && !again && !composing ? (
            <>
              {' '}
              <button
                type="button"
                className="btn quiet comment-send-again"
                data-ui="item"
                data-testid="comment-send-again"
                onClick={() => setAgain(true)}
              >
                Send to again
              </button>
            </>
          ) : null}
        </p>
      ) : null}
      {composing ? (
        <>
          <Composer
            label="Reply"
            placeholder="Reply"
            testId="comment-reply"
            onSend={(body) => {
              if (reply(replica, thread.id, body, author())) sent(thread.id);
            }}
          />
          <SendTo
            value={thread.target ?? null}
            testId="comment-send-to"
            autoFocus={again}
            onChange={send}
          />
        </>
      ) : again && !resolved ? (
        <SendTo value={thread.target ?? null} testId="comment-send-to" autoFocus onChange={send} />
      ) : null}
      <span className="comment-thread-actions">
        <button
          type="button"
          className="btn quiet"
          data-ui="item"
          data-testid={resolved ? 'comment-reopen' : 'comment-resolve'}
          onClick={() => {
            resolve(replica, thread.id, resolved, author());
            if (!resolved && active) onResolved();
          }}
        >
          <Icon name={resolved ? 'undo' : 'check'} size={14} />
          {resolved ? 'Reopen' : 'Resolve'}
        </button>
        {!active || !compose ? (
          <button
            type="button"
            className="btn quiet"
            data-ui="item"
            onClick={() => onActivate(true)}
          >
            Reply
          </button>
        ) : null}
        <button
          type="button"
          className="btn quiet danger"
          data-ui="item"
          aria-expanded={deleting}
          data-testid="comment-delete-thread"
          onClick={() => setDeleting((open) => !open)}
        >
          <Icon name="trash" size={14} />
          Delete Thread
        </button>
      </span>
      {deleting ? (
        <div className="comment-confirm" role="alertdialog" aria-label="Delete this thread?">
          <p>
            Delete this thread and its{' '}
            {thread.comments.length === 1 ? 'comment' : `${thread.comments.length} comments`} on
            every device? To keep them, resolve it instead.
          </p>
          <span className="comment-composer-actions">
            <button
              type="button"
              className="btn quiet"
              data-ui="dismiss"
              data-testid="comment-delete-cancel"
              onClick={() => setDeleting(false)}
            >
              Cancel
            </button>
            <button
              type="button"
              className="btn danger"
              data-ui="submit"
              data-testid="comment-delete-confirm"
              onClick={() => {
                setDeleting(false);
                if (active) onResolved();
                removeThread(replica, thread.id);
              }}
            >
              Delete
            </button>
          </span>
        </div>
      ) : null}
    </Root>
  );
}

/**
 * A new thread being written: on a selection or the caret (`draft`; floating over the note), or
 * on the note as a whole (null).
 */
export function CommentDraft({
  noteId,
  replica,
  draft,
  onCancel,
  onCreated,
}: {
  readonly noteId: string;
  readonly replica: Yjs14Replica;
  readonly draft: SelectionAnchor | null;
  readonly onCancel: () => void;
  readonly onCreated: (id: string) => void;
}) {
  const [target, setTarget] = useState<CommentTarget | null>(null);
  const sent = useAgentSent(noteId);
  return (
    <div
      className="comment-thread comment-draft"
      data-testid={draft ? 'comment-draft' : 'comment-note-draft'}
    >
      <p className={draft ? 'comment-quote' : 'comment-quote comment-quote-whole'}>
        {draft?.kind === 'point' ? <span className="comment-quote-note">At a point in</span> : null}
        {draft?.quote || 'The note as a whole'}
      </p>
      <Composer
        label="Comment"
        placeholder="Add a comment"
        autoFocus
        testId="comment-new"
        onSend={(body) => {
          const id = draft
            ? startThread(replica, draft, body, deviceAuthor(), target)
            : startNoteThread(replica, body, deviceAuthor(), target);
          if (target) sent(id);
          onCreated(id);
        }}
        onCancel={onCancel}
      />
      <SendTo value={target} testId="comment-new-send-to" draft onChange={setTarget} />
    </div>
  );
}

export function CommentsPanel({
  noteId,
  replica,
  threads,
  active,
  onActive,
  noteDraft,
  onNoteDraftDone,
  floating,
}: {
  readonly noteId: string;
  readonly replica: Yjs14Replica | null;
  readonly threads: readonly PlacedThread[];
  readonly active: string | null;
  /** A thread was picked (`reveal`: scroll the note to its passage). */
  readonly onActive: (id: string | null, reveal: boolean) => void;
  /** A new thread on the note as a whole is being written (Add Note Comment, T52 item 5). */
  readonly noteDraft: boolean;
  readonly onNoteDraftDone: () => void;
  /** The thread floating over the note at its passage (it composes there, not here). */
  readonly floating: string | null;
}) {
  const commands = useCommands();
  const [filter, setFilter] = useState<CommentsFilter>('open');
  const open = threads.filter((placed) => placed.thread.status === 'open');
  const resolved = threads.filter((placed) => placed.thread.status === 'resolved');
  // The thread picked from the note shows, whatever the filter.
  const activeThread = threads.find((placed) => placed.thread.id === active);
  const effective: CommentsFilter =
    activeThread && activeThread.thread.status !== filter ? activeThread.thread.status : filter;
  const shown = effective === 'open' ? open : resolved;

  return (
    <section className="comments-panel" aria-label="Comments" data-testid="comments-panel">
      <header className="comments-header">
        <h2 className="info-heading">Comments</h2>
        <span className="comments-filter" role="group" aria-label="Show">
          <button
            type="button"
            className="btn quiet"
            data-ui="option"
            aria-pressed={effective === 'open'}
            data-testid="comments-filter-open"
            onClick={() => {
              setFilter('open');
              if (activeThread?.thread.status === 'resolved') onActive(null, false);
            }}
          >
            Open <span className="info-count">{open.length}</span>
          </button>
          <button
            type="button"
            className="btn quiet"
            data-ui="option"
            aria-pressed={effective === 'resolved'}
            data-testid="comments-filter-resolved"
            onClick={() => {
              setFilter('resolved');
              if (activeThread?.thread.status === 'open') onActive(null, false);
            }}
          >
            Resolved <span className="info-count">{resolved.length}</span>
          </button>
        </span>
        {/* Closed from the side panel's tab strip (T51, A936). */}
      </header>
      {/* T52 item 5: a thread on the note as a whole, with no passage. */}
      {replica && !noteDraft ? (
        <button
          type="button"
          className="btn quiet comments-add-note"
          data-command="note.addNoteComment"
          onClick={() => commands.run('note.addNoteComment')}
          data-testid="comments-add-note"
        >
          <Icon name="plus" size={14} />
          Add Note Comment
        </button>
      ) : null}
      {noteDraft && replica ? (
        <CommentDraft
          noteId={noteId}
          replica={replica}
          draft={null}
          onCancel={onNoteDraftDone}
          onCreated={(id) => {
            onNoteDraftDone();
            setFilter('open');
            onActive(id, false);
          }}
        />
      ) : null}
      {shown.length === 0 && !noteDraft ? (
        <p className="muted comments-empty" data-testid="comments-empty">
          {effective === 'open'
            ? 'No open comments. Select text and choose Comment, or add a comment on the whole note.'
            : 'No resolved comments.'}
        </p>
      ) : null}
      {replica ? (
        <ol className="comment-threads">
          {shown.map((placed: PlacedThread) => (
            <CommentThread
              key={placed.thread.id}
              placed={placed}
              noteId={noteId}
              replica={replica}
              active={placed.thread.id === active}
              compose={placed.thread.id !== floating}
              onActivate={(reveal) => onActive(placed.thread.id, reveal)}
              onResolved={() => onActive(null, false)}
            />
          ))}
        </ol>
      ) : null}
    </section>
  );
}
