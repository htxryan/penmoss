/**
 * A local stand-in for GitHub for Send feedback and the GitHub token check (T49, T57, A1010,
 * A1012), for the Mac app's Playwright suite: main files there with `PENMOSS_TEST_GITHUB_API`
 * (config.ts). Never used in production. Node 24 runs it as it is (playwright.config.ts):
 *
 *   node test/e2e/fake-github.ts [port] [token]
 *
 * It answers as packages/core/test/support/fake-github-feedback.ts does, and lets a test look
 * and steer:
 *
 * - `GET /__fake/issues`, `GET /__fake/uploads` (sizes and types, not the bytes), `GET /__fake/calls`;
 * - `POST /__fake/fail` `{ path, status, times }`: the next calls to that path fail;
 * - `POST /__fake/reset`.
 *
 * Every request is logged as a JSON line on stdout (method, path, status), never the token.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { FakeFeedbackGitHub } from '../../../../packages/core/test/support/fake-github-feedback.ts';

const [portArg = '8791', token = 'fake-local-token'] = process.argv.slice(2);
const port = Number(portArg);
const base = `http://127.0.0.1:${port}`;
const fake = new FakeFeedbackGitHub({ base, token });

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

function send(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(body));
}

createServer((request, response) => {
  void (async () => {
    const path = new URL(request.url ?? '/', base).pathname;
    const body = await readBody(request);
    if (path.startsWith('/__fake/')) {
      if (request.method === 'GET' && path === '/__fake/issues')
        return send(response, 200, fake.issues);
      if (request.method === 'GET' && path === '/__fake/calls')
        return send(response, 200, fake.calls);
      if (request.method === 'GET' && path === '/__fake/uploads') {
        return send(
          response,
          200,
          fake.uploads.map(({ bytes, ...rest }) => ({ ...rest, size: bytes.byteLength })),
        );
      }
      if (request.method === 'POST' && path === '/__fake/reset') {
        fake.reset();
        return send(response, 204, null);
      }
      if (request.method === 'POST' && path === '/__fake/fail') {
        const {
          path: failPath,
          status,
          times,
        } = JSON.parse(body.toString('utf8') || '{}') as {
          path: string;
          status: number;
          times?: number;
        };
        fake.fail(failPath, status, times ?? 1);
        return send(response, 204, null);
      }
      return send(response, 404, { message: 'Not Found' });
    }
    const headers = new Headers();
    for (const [name, value] of Object.entries(request.headers)) {
      if (typeof value === 'string') headers.set(name, value);
    }
    const answer = await fake.handle(
      new Request(new URL(request.url ?? '/', base), {
        method: request.method ?? 'GET',
        headers,
        ...(body.byteLength > 0 ? { body: new Uint8Array(body) } : {}),
      }),
    );
    console.log(JSON.stringify({ method: request.method, path, status: answer.status }));
    response.writeHead(answer.status, { 'Content-Type': 'application/json' });
    response.end(Buffer.from(await answer.arrayBuffer()));
  })().catch((error: unknown) => {
    console.error('[fake-github]', error);
    send(response, 500, { message: 'The fake failed' });
  });
}).listen(port, '127.0.0.1', () => {
  console.log(JSON.stringify({ listening: base }));
});
