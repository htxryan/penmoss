import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, test, type Page } from '@playwright/test';
import {
  body,
  gitNotebook,
  go,
  holdForProof,
  launch,
  mainBounds,
  removeDataDirs,
  repositoryFile,
  repositoryFiles,
  ULID,
  type Launched,
} from './support';

// AI Descriptions' Anthropic (API Key) path in the Mac app (PEN-161, A1656), against a stand-in
// for Anthropic's API on loopback, which main calls in place of api.anthropic.com
// (PENMOSS_TEST_ANTHROPIC_API, config.ts; unpackaged builds only). Settings checks a key with
// the stand-in and keeps only the one it accepts; Describe Now sends the note from main with that
// key, and the stand-in's reply becomes the note's description: in the Metadata tab, and in the
// file pushed to the notebook.

const mac = process.platform === 'darwin';
const NEW_NOTE = mac ? 'Meta+Alt+KeyN' : 'Alt+KeyN';
const RUN = `a${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
/** The key the stand-in accepts (made up: no real key is ever used here). */
const KEY = `sk-ant-stand-in-${RUN}`;
/** What the stand-in answers every message with. */
const REPLY = `A shopping list for the weekend, from the stand-in ${RUN}.`;

/** A request the stand-in got: never its key, only whether it was the accepted one. */
interface Call {
  readonly method: string;
  readonly path: string;
  readonly accepted: boolean;
  readonly version: string | null;
  readonly body: {
    model?: string;
    max_tokens?: number;
    messages?: { role: string; content: string }[];
  } | null;
}

interface StandIn {
  /** The origin to hand the app as `PENMOSS_TEST_ANTHROPIC_API`. */
  readonly url: string;
  readonly calls: Call[];
  close(): Promise<void>;
}

async function readBody(request: IncomingMessage): Promise<string> {
  let text = '';
  for await (const chunk of request) text += String(chunk);
  return text;
}

/**
 * The stand-in: `GET /v1/models` says whether the key is accepted (401 otherwise, as Anthropic
 * does), and `POST /v1/messages` answers with REPLY as one text block, in the Messages API's
 * shape.
 */
async function standIn(): Promise<StandIn> {
  const calls: Call[] = [];
  const server: Server = createServer((request, response) => {
    void (async () => {
      const text = await readBody(request);
      const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
      const accepted = request.headers['x-api-key'] === KEY;
      const version = request.headers['anthropic-version'];
      calls.push({
        method: request.method ?? '',
        path,
        accepted,
        version: typeof version === 'string' ? version : null,
        body: text ? (JSON.parse(text) as Call['body']) : null,
      });
      const send = (status: number, payload: unknown) => {
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end(JSON.stringify(payload));
      };
      if (!accepted) {
        return send(401, {
          type: 'error',
          error: { type: 'authentication_error', message: 'invalid x-api-key' },
        });
      }
      if (request.method === 'GET' && path === '/v1/models') {
        return send(200, { data: [], has_more: false, first_id: null, last_id: null });
      }
      if (request.method === 'POST' && path === '/v1/messages') {
        const model = (JSON.parse(text) as { model?: string }).model ?? '';
        return send(200, {
          id: 'msg_stand_in',
          type: 'message',
          role: 'assistant',
          model,
          content: [{ type: 'text', text: REPLY }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        });
      }
      send(404, { type: 'error', error: { type: 'not_found_error', message: path } });
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

const opened: Launched[] = [];
const servers: StandIn[] = [];

test.afterEach(async () => {
  for (const { app } of opened.splice(0)) await app.close().catch(() => undefined);
  for (const server of servers.splice(0)) await server.close();
});
test.afterAll(() => removeDataDirs());

async function newNote(page: Page, title: string, text: string): Promise<void> {
  await expect(page.locator('button[data-command="note.new"]')).toBeVisible();
  await page.keyboard.press(NEW_NOTE);
  await expect(page).toHaveURL(ULID);
  await expect(page.getByTestId('note-title')).toBeFocused();
  await page.keyboard.type(title);
  await page.keyboard.press('Enter');
  await page.keyboard.type(text);
  await expect(body(page)).toContainText(text);
}

/** The note's markdown on the remote's branch, or '' before it is there. */
function pushed(remote: string, title: string): string {
  const file = repositoryFiles(remote).find((path) => path.endsWith(`${title}.md`));
  return file ? repositoryFile(remote, file) : '';
}

test('Anthropic (API Key): the key is checked, and Describe Now writes the reply as the description', async () => {
  test.setTimeout(180_000);
  const anthropic = await standIn();
  servers.push(anthropic);
  const launched = await launch({ env: { PENMOSS_TEST_ANTHROPIC_API: anthropic.url } });
  opened.push(launched);
  const { app, page } = launched;
  await mainBounds(app, { x: 0, y: 0, width: 1440, height: 900 });
  const { remote } = await gitNotebook(launched);

  // Settings → AI Descriptions: Anthropic, and a key the stand-in refuses, which is not kept.
  await go(page, '/settings/ai-descriptions');
  const settings = page.getByTestId('ai-descriptions-settings');
  await expect(settings).toBeVisible();
  await settings.getByTestId('ai-provider').selectOption('anthropic');
  const keyRow = settings.getByTestId('ai-key-setting');
  await keyRow.getByTestId('ai-key').fill('sk-ant-not-this-one');
  await keyRow.getByTestId('ai-save-key').click();
  await expect(keyRow.getByTestId('ai-test-result')).toHaveText(
    'Anthropic refused the API key. Check it in Settings → AI Descriptions.',
  );
  await expect(keyRow.getByTestId('ai-key')).toBeVisible();
  // The key it accepts: checked with GET /v1/models, then kept (the form gives way to Test Key).
  await keyRow.getByTestId('ai-key').fill(KEY);
  await keyRow.getByTestId('ai-save-key').click();
  await expect(keyRow.getByTestId('ai-test-result')).toHaveText(
    'Saved. Anthropic accepted the key.',
  );
  await expect(keyRow.getByTestId('ai-test')).toHaveText('Test Key');
  expect(anthropic.calls.map(({ method, path, accepted }) => [method, path, accepted])).toEqual([
    ['GET', '/v1/models', false],
    ['GET', '/v1/models', true],
  ]);
  await settings.getByTestId('ai-global').getByText('On', { exact: true }).click();

  // A note, and Describe Now in its Metadata tab.
  await go(page, '/');
  const title = `Groceries ${RUN}`;
  await newNote(page, title, `Milk, eggs and bread ${RUN}.`);
  const panel = page.getByRole('complementary', { name: 'Metadata' });
  if (!(await panel.isVisible())) await page.getByTestId('note-tab-info').click();
  await expect(panel).toBeVisible();
  await expect(panel.getByTestId('ai-effective')).toContainText('On');
  await panel.getByTestId('ai-describe-now').click();
  await expect(panel.getByTestId('ai-description')).toHaveValue(REPLY, { timeout: 30_000 });
  await expect(panel.getByTestId('ai-description-by')).toHaveText('Written by AI Descriptions');
  await holdForProof(page);

  // What main sent: the Messages API, the kept key, a short answer asked of a Claude model, and
  // the note's text in the prompt.
  const sent = anthropic.calls.filter((call) => call.path === '/v1/messages');
  expect(sent.length).toBeGreaterThanOrEqual(1);
  const [first] = sent;
  expect(first).toMatchObject({ method: 'POST', accepted: true, version: '2023-06-01' });
  expect(first!.body?.model).toMatch(/^claude-/);
  expect(first!.body?.max_tokens).toBe(300);
  expect(first!.body?.messages?.[0]?.role).toBe('user');
  expect(first!.body?.messages?.[0]?.content).toContain(`Milk, eggs and bread ${RUN}.`);

  // The description is the note's own: in its frontmatter, pushed to the notebook.
  await expect
    .poll(() => pushed(remote, title), { timeout: 30_000 })
    .toMatch(new RegExp(`^description: ['"]?${REPLY.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'm'));
});
