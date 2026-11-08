import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  GitNotebookEngine,
  MemorySecrets,
  MemoryStorage,
  NotebookOps,
} from '@penmoss/git-notebook';
import { NodeGitTransport } from '@penmoss/git-notebook/node';
import { recordAgentSession, sessionKey } from '@penmoss/sync-client/agent-sessions';
import {
  addComment,
  createNoteThread,
  readThread,
  readThreads,
  setThreadDelivery,
  type ThreadData,
} from '@penmoss/sync-client/comments';
import { expect, seeded, test, type GitHost, type Page } from './fixtures';
import { NEW_NOTE } from './keys';

// T60 (D50, A1060–A1065, A1070–A1074): Send to… in a git notebook. The agent here is a second
// clone of the notebook's bare repository, of kind agent, playing what the channel and the local
// MCP's tools write: its session entry in the WorkspaceDoc, then `sent`, a reply and `replied`.
// The page is the Mac app's (its engine syncs through the stand-in main process's git).

const ULID = /\/notes\/([0-9A-HJKMNP-TV-Z]{26})$/;
const RUN = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
/** Where screenshots go: docs/evidence/t60 when EVIDENCE_DIR names it, else the test's output. */
const EVIDENCE_DIR = process.env['EVIDENCE_DIR'];
const DAY = 24 * 60 * 60_000;

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(error.message));
  return errors;
}

/** The agent's own clone (T54): its own git directory and writer, of kind agent. */
async function agentClone(host: GitHost, remote: string, label: string) {
  const dir = mkdtempSync(join(host.root, 'agent-'));
  const transport = new NodeGitTransport({
    gitDir: join(dir, 'repo.git'),
    remote,
    branch: 'main',
    root: '',
    author: { name: label, email: 'agent@example.invalid' },
    env: host.env,
    sign: false,
  });
  await transport.init();
  const engine = await GitNotebookEngine.open({
    transport,
    storage: new MemoryStorage(),
    secrets: new MemorySecrets(),
    writer: { kind: 'agent', label },
  });
  await engine.sync();
  const writer = engine.writer!.id;
  return {
    engine,
    ops: new NotebookOps(engine),
    writer,
    author: { id: `agent:${writer}`, kind: 'agent', label } as const,
    /** Pulls, then the thread as the agent's clone has it. */
    async thread(noteId: string, threadId?: string): Promise<ThreadData | null> {
      await engine.sync();
      const doc = new NotebookOps(engine).note(noteId);
      if (!doc) return null;
      return threadId ? readThread(doc, threadId) : (readThreads(doc)[0] ?? null);
    },
    close: () => rmSync(dir, { recursive: true, force: true }),
  };
}

const body = (page: Page) => page.getByTestId('note-body').locator('.ProseMirror');
const popover = (page: Page) => page.getByTestId('comment-popover');
const panel = (page: Page) => page.getByTestId('comments-panel');

async function newNote(page: Page, title: string, text: string): Promise<string> {
  await expect(page.locator('button[data-command="note.new"]')).toBeVisible();
  await page.keyboard.press(NEW_NOTE);
  await expect(page).toHaveURL(ULID);
  await expect(page.getByTestId('note-title')).toBeFocused();
  await page.keyboard.type(title);
  await page.keyboard.press('Enter');
  await page.keyboard.type(text);
  await expect(page.getByTestId('note-view')).toHaveAttribute('data-ready', 'true');
  return ULID.exec(new URL(page.url()).pathname)![1]!;
}

async function selectText(page: Page, text: string): Promise<void> {
  await expect(async () => {
    await body(page).evaluate((root, wanted) => {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const at = node.textContent?.indexOf(wanted) ?? -1;
        if (at < 0) continue;
        const range = document.createRange();
        range.setStart(node, at);
        range.setEnd(node, at + wanted.length);
        const selection = window.getSelection()!;
        selection.removeAllRanges();
        selection.addRange(range);
        (root as HTMLElement).focus();
        return;
      }
      throw new Error(`no "${wanted}"`);
    }, text);
    await expect(page.getByTestId('selection-toolbar')).toBeVisible({ timeout: 1_000 });
  }).toPass({ timeout: 15_000 });
}

/** Light and dark screenshots of `target`, into the evidence folder or the test's output. */
async function shoot(page: Page, target: ReturnType<Page['locator']>, name: string, dir: string) {
  mkdirSync(dir, { recursive: true });
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    // The theme follows the system (the default): one frame to repaint.
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
    await target.screenshot({ path: join(dir, `${name}-${scheme}.png`), animations: 'disabled' });
  }
  await page.emulateMedia({ colorScheme: 'light' });
}

test('Send to… a Claude Code session through the repository: waiting, sent, replied (A1061, A1065)', async ({
  page,
  host,
  notebook,
}, info) => {
  test.setTimeout(180_000);
  const errors = collectErrors(page);
  const { remote } = seeded(notebook);
  const dir = EVIDENCE_DIR ?? info.outputPath('agent-comments');

  // The agent's channel lists its session (and an older one of the same agent) and pushes.
  const agent = await agentClone(host, remote, 'Claude Code');
  const name = 'mac:/src/penmoss';
  const key = await sessionKey(agent.writer, name);
  const label = 'Claude Code · penmoss';
  const now = Date.now();
  recordAgentSession(agent.ops.workspace, {
    key,
    writer: agent.writer,
    label,
    name,
    host: 'mac',
    lastSeen: now,
  });
  recordAgentSession(agent.ops.workspace, {
    key: await sessionKey(agent.writer, 'mac:/src/notes'),
    writer: agent.writer,
    label: 'Claude Code · notes',
    name: 'mac:/src/notes',
    host: 'mac',
    lastSeen: now - 2 * DAY,
  });
  await agent.engine.sync();

  await page.goto('/');
  const id = await newNote(page, `Ask Claude ${RUN}`, 'The garden plan needs work.');

  // A new thread sent as it is written: the picker lists the running session first.
  await selectText(page, 'garden plan');
  await page.getByTestId('selection-toolbar').getByRole('button', { name: 'Comment' }).click();
  const draft = popover(page).getByTestId('comment-draft');
  const picker = draft.getByTestId('comment-new-send-to');
  await expect(picker.locator('optgroup[label="Running"] option')).toHaveText([label], {
    timeout: 30_000,
  });
  await expect(picker.locator('optgroup[label="Not running"] option')).toHaveText([
    /^Claude Code · notes \(last seen .+\)$/,
  ]);
  await page.getByTestId('comment-new').fill('Which tomatoes should I plant?');
  await picker.selectOption(key);
  await shoot(page, popover(page), 'send-to-picker', dir);
  // The picker's list, which a screenshot of the native popup cannot show: drawn open in place.
  await picker.evaluate((select) => {
    (select as HTMLSelectElement).size = 6;
    (select as HTMLSelectElement).style.height = 'auto';
  });
  await shoot(page, popover(page), 'send-to-picker-list', dir);
  await picker.evaluate((select) => {
    (select as HTMLSelectElement).size = 0;
    (select as HTMLSelectElement).style.height = '';
  });
  await page.getByTestId('comment-new-send').click();
  const sentAt = Date.now();

  // Waiting, and pushed at once: the agent's clone has it well before the 12 s push delay.
  await page.getByTestId('note-tab-comments').click();
  const thread = panel(page).getByTestId('comment-thread');
  await expect(thread.getByTestId('comment-delivery')).toHaveText(`Waiting for ${label}`);
  await expect
    .poll(async () => (await agent.thread(id))?.delivery?.state ?? null, {
      timeout: 9_000,
      intervals: [500],
    })
    .toBe('waiting');
  expect(Date.now() - sentAt).toBeLessThan(12_000);
  const theirs = (await agent.thread(id))!;
  expect(theirs.target).toEqual({ writer: agent.writer, session: key, label });
  expect(theirs.delivery).toMatchObject({ commentId: theirs.comments[0]!.id, session: key });

  // The channel notified Claude Code: `sent`, pushed. The Mac pulls every 10 s after a Send to,
  // not once a minute, so it shows within 15 s.
  const doc = () => agent.ops.note(id)!;
  setThreadDelivery(doc(), theirs.id, { ...theirs.delivery!, state: 'sent', at: Date.now() });
  await agent.engine.sync();
  await expect(thread.getByTestId('comment-delivery')).toHaveText(`Sent to ${label}`, {
    timeout: 15_000,
  });

  // Claude reads it (seen), then replies (replied), each pushed at once.
  setThreadDelivery(doc(), theirs.id, { ...theirs.delivery!, state: 'seen', at: Date.now() });
  await agent.engine.sync();
  await expect(thread.getByTestId('comment-delivery')).toHaveText('Seen', { timeout: 15_000 });
  addComment(doc(), theirs.id, {
    id: `reply-${RUN}`,
    author: agent.author,
    body: 'Brandywine and Sungold: one slicer, one cherry.',
    at: Date.now(),
  });
  setThreadDelivery(doc(), theirs.id, { ...theirs.delivery!, state: 'replied', at: Date.now() });
  await agent.engine.sync();
  await expect(thread.getByTestId('comment-delivery')).toHaveText('Replied', { timeout: 15_000 });
  await expect(thread.getByTestId('comment-author').nth(1)).toHaveText('✦ Claude Code');
  await expect(thread.getByTestId('comment-body').nth(1)).toHaveText(
    'Brandywine and Sungold: one slicer, one cherry.',
  );
  await shoot(page, thread, 'replied-thread', dir);

  // Ryan answers in the thread: it waits again, for that comment, and goes at once.
  // It is the thread picked in the list (the one just written), so its reply field is there.
  await thread.getByTestId('comment-reply').fill('Thanks, both then.');
  await thread.getByTestId('comment-reply-send').click();
  await expect(
    panel(page).getByTestId('comment-thread').getByTestId('comment-delivery'),
  ).toHaveText(`Waiting for ${label}`);
  await expect
    .poll(
      async () => {
        const now = await agent.thread(id);
        const last = now?.comments.at(-1);
        // Waiting for the comment Ryan just wrote, not for his first.
        return now?.delivery?.state === 'waiting' && now.delivery.commentId === last?.id
          ? last.body
          : null;
      },
      { timeout: 9_000, intervals: [500] },
    )
    .toBe('Thanks, both then.');
  expect(errors).toEqual([]);
  agent.close();
});

test('a thread waiting for a session gone a week fails when shown, and Send to again (A1062)', async ({
  page,
  host,
  notebook,
}) => {
  test.setTimeout(120_000);
  const errors = collectErrors(page);
  const { remote } = seeded(notebook);
  const agent = await agentClone(host, remote, 'Claude Code');
  const now = Date.now();
  const running = await sessionKey(agent.writer, 'mac:/src/penmoss');
  const away = await sessionKey(agent.writer, 'mac:/old');
  recordAgentSession(agent.ops.workspace, {
    key: running,
    writer: agent.writer,
    label: 'Claude Code · penmoss',
    name: 'mac:/src/penmoss',
    host: 'mac',
    lastSeen: now,
  });
  recordAgentSession(agent.ops.workspace, {
    key: away,
    writer: agent.writer,
    label: 'Claude Code · old',
    name: 'mac:/old',
    host: 'mac',
    lastSeen: now - 8 * DAY,
  });
  // A note with a thread another device sent to the old session, still waiting.
  const id = agent.ops.createNote({ title: `Gone ${RUN}`, markdown: 'Some text.' });
  const note = agent.ops.note(id)!;
  createNoteThread(note, {
    id: `thread-${RUN}`,
    author: { id: 'device:pixel', kind: 'device', label: 'Pixel' },
    at: now - 8 * DAY,
    comment: { id: `c-${RUN}`, body: 'Still there?' },
    target: { writer: agent.writer, session: away, label: 'Claude Code · old' },
  });
  setThreadDelivery(note, `thread-${RUN}`, {
    state: 'waiting',
    commentId: `c-${RUN}`,
    session: away,
    at: now - 8 * DAY,
  });
  await agent.engine.sync();

  await page.goto(`/notes/${id}`);
  await expect(page.getByTestId('note-view')).toHaveAttribute('data-ready', 'true', {
    timeout: 30_000,
  });
  if (!(await panel(page).isVisible())) await page.getByTestId('note-tab-comments').click();
  const thread = panel(page).getByTestId('comment-thread');
  await expect(thread.getByTestId('comment-delivery')).toContainText(
    'Not sent: the session is gone',
  );
  await thread.getByTestId('comment-send-again').click();
  const picker = thread.getByTestId('comment-send-to');
  await expect(picker).toBeFocused();
  await expect(picker.locator('optgroup[label="Running"] option')).toHaveText([
    'Claude Code · penmoss',
  ]);
  await picker.selectOption(running);
  await expect(thread.getByTestId('comment-delivery')).toHaveText(
    'Waiting for Claude Code · penmoss',
  );
  await expect
    .poll(async () => (await agent.thread(id, `thread-${RUN}`))?.target?.session ?? null, {
      timeout: 9_000,
      intervals: [500],
    })
    .toBe(running);
  expect((await agent.thread(id, `thread-${RUN}`))?.delivery?.state).toBe('waiting');
  expect(errors).toEqual([]);
  agent.close();
});
