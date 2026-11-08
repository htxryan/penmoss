import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ModelManifest } from '../src/manifest';

/** The tiny model: a 16-word tokenizer and a 4-dimension mean of an embedding table. */
export const TINY_DIR = fileURLToPath(new URL('./fixtures/tiny/', import.meta.url));

const PATHS = [
  'onnx/model.onnx',
  'onnx/model.onnx_data',
  'tokenizer.json',
  'tokenizer_config.json',
];

export const TINY: ModelManifest = {
  name: 'tiny',
  repo: 'penmoss/tiny',
  revision: '0123456789abcdef0123456789abcdef01234567',
  files: PATHS.map((path) => {
    const bytes = readFileSync(join(TINY_DIR, path));
    return {
      path,
      bytes: statSync(join(TINY_DIR, path)).size,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
  }),
  graph: 'onnx/model.onnx',
  externalData: ['onnx/model.onnx_data'],
  tokenizer: 'tokenizer.json',
  tokenizerConfig: 'tokenizer_config.json',
  output: 'sentence_embedding',
  dimensions: 4,
  floor: 0.5,
  prompts: { version: 'p1', query: 'task search result query ', document: 'title none text ' },
  maxTokens: 6,
  license: { name: 'none', url: 'https://example.invalid' },
};

export interface FixtureServer {
  readonly url: string;
  /** Requests served, by path in the repository, with their Range header. */
  readonly requests: Array<{ path: string; range: string | undefined }>;
  /** Cut the next response for `path` after this many bytes (a dropped connection). */
  cutNext(path: string, bytes: number): void;
  /** Serve these bytes for `path` instead of the fixture's (a tampered mirror). */
  replace(path: string, bytes: Buffer): void;
  /** Ignore Range headers (a server that always sends the whole file). */
  ignoreRanges(): void;
  close(): Promise<void>;
}

/** Hugging Face's `/<repo>/resolve/<revision>/<path>`, with a redirect first as the real one does. */
export async function fixtureServer(
  manifest: ModelManifest = TINY,
  root: string = TINY_DIR,
): Promise<FixtureServer> {
  const requests: FixtureServer['requests'] = [];
  const cuts = new Map<string, number>();
  const replaced = new Map<string, Buffer>();
  let ranges = true;
  const prefix = `/${manifest.repo}/resolve/${manifest.revision}/`;
  const server: Server = createServer((req, res) => {
    const url = req.url ?? '';
    if (url.startsWith(prefix)) {
      res.writeHead(302, { Location: `/cdn/${url.slice(prefix.length)}` });
      res.end();
      return;
    }
    if (!url.startsWith('/cdn/')) {
      res.writeHead(404).end();
      return;
    }
    const path = url.slice('/cdn/'.length);
    const range = req.headers.range;
    requests.push({ path, range });
    let body: Buffer;
    try {
      body = replaced.get(path) ?? readFileSync(join(root, path));
    } catch {
      res.writeHead(404).end();
      return;
    }
    let start = 0;
    const match = ranges && range ? /^bytes=(\d+)-$/.exec(range) : null;
    if (match) start = Number(match[1]);
    const slice = body.subarray(start);
    res.writeHead(match ? 206 : 200, { 'Content-Length': slice.length });
    const cut = cuts.get(path);
    if (cut !== undefined) {
      cuts.delete(path);
      // Let the bytes reach the client before the connection drops.
      res.write(slice.subarray(0, cut), () => setTimeout(() => res.destroy(), 50));
      return;
    }
    res.end(slice);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    cutNext: (path, bytes) => cuts.set(path, bytes),
    replace: (path, bytes) => replaced.set(path, bytes),
    ignoreRanges: () => (ranges = false),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
