import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { localizeImages, stageAttachments, uploadUrls, type Download } from '../src/attachments.ts';
import type { Issue } from '../src/issue.ts';
import { issueForAgent, runImages } from '../src/start.ts';
import { createLinearClient, type Fetcher } from '../src/tracker/linear-client.ts';
import type { Tracker } from '../src/tracker/port.ts';
import { linearConfig, RYAN_LINEAR } from './helpers.ts';

const SHOT = 'https://uploads.linear.app/org/aaa/shot-1';
const SECOND = 'https://uploads.linear.app/org/bbb/shot-2';
const THEIRS = 'https://uploads.linear.app/org/ccc/theirs';
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);

function issue(overrides: Partial<Issue> = {}): Issue {
  return {
    number: 66,
    key: 'PEN-66',
    title: 'The toolbar wraps',
    body: `It wraps like this:\n\n![screenshot](${SHOT})`,
    author: RYAN_LINEAR,
    authorName: 'Ryan',
    url: 'https://linear.app/penmoss/issue/PEN-66',
    labels: [],
    comments: [
      {
        author: RYAN_LINEAR,
        authorName: 'Ryan',
        body: `And on a phone: ${SECOND}`,
        createdAt: '2026-11-09T10:00:00Z',
      },
      {
        author: 'someone-else',
        authorName: 'Sam',
        body: `Mine: ![x](${THEIRS})`,
        createdAt: '2026-11-09T11:00:00Z',
      },
    ],
    ...overrides,
  };
}

/** A fake download: each URL's answer, and every URL asked for. */
function fakeDownload(
  answers: Record<string, () => Promise<{ type: string; bytes?: Uint8Array }>>,
) {
  const asked: string[] = [];
  const download: Download = async (url) => {
    asked.push(url);
    const answer = answers[url];
    if (!answer) throw new Error(`unexpected ${url}`);
    const got = await answer();
    return { contentType: got.type, bytes: got.bytes ?? PNG };
  };
  return { download, asked };
}

const png = () => Promise.resolve({ type: 'image/png' });

describe("the issue's images", () => {
  it('finds each Linear upload once, in Markdown or bare', () => {
    expect(
      uploadUrls(`![a](${SHOT}) and ${SECOND}, again ${SHOT} and https://example.com/x.png`),
    ).toEqual([SHOT, SECOND]);
  });

  it("downloads the description's and Ryan's images and points the text at the files", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'images-'));
    const { download, asked } = fakeDownload({ [SHOT]: png, [SECOND]: png });
    const local = await localizeImages(issue(), RYAN_LINEAR, {
      dir,
      shownAs: (f) => `/seen/${f}`,
      download,
    });
    // Others' comments are data (R14): their images aren't fetched with the app's token.
    expect(asked).toEqual([SHOT, SECOND]);
    const files = readdirSync(dir).sort();
    expect(files).toHaveLength(2);
    expect(files.every((f) => f.endsWith('.png'))).toBe(true);
    expect(readFileSync(join(dir, files[0]!))).toEqual(Buffer.from(PNG));
    const [shot, second] = local.attachments.map((a) => a.path);
    expect(local.issue.body).toBe(`It wraps like this:\n\n![screenshot](${shot})`);
    expect(local.issue.comments[0]?.body).toBe(`And on a phone: ${second}`);
    expect(local.issue.comments[1]?.body).toBe(`Mine: ![x](${THEIRS})`);
    expect(local.note).toContain("## The issue's images");
    expect(local.note).toContain(`1. \`${shot}\``);
    expect(local.note).toContain('Read tool');
    expect(local.issue.body).not.toContain('uploads.linear.app');
  });

  it('notes what it could not take, and never fails the run', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'images-'));
    const { download } = fakeDownload({
      [SHOT]: () => Promise.reject(new Error('Linear refused the download: HTTP 403')),
      [SECOND]: () => Promise.resolve({ type: 'application/pdf' }),
    });
    const local = await localizeImages(issue(), RYAN_LINEAR, {
      dir,
      shownAs: (f) => f,
      download,
    });
    expect(readdirSync(dir)).toEqual([]);
    expect(local.issue.body).toContain(
      `![screenshot](${SHOT}) (the factory couldn't download this image: Linear refused the download: HTTP 403)`,
    );
    expect(local.issue.comments[0]?.body).toContain(
      "(the factory couldn't download this image: it is application/pdf, not an image)",
    );
    expect(local.note).toContain(
      `1. Not downloaded (Linear refused the download: HTTP 403): ${SHOT}`,
    );
  });

  it('takes at most maxFiles images, each up to maxBytes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'images-'));
    const urls = Array.from({ length: 4 }, (_, i) => `https://uploads.linear.app/org/n/${i}`);
    const { download, asked } = fakeDownload(
      Object.fromEntries(
        urls.map((u, i) => [
          u,
          () => Promise.resolve({ type: 'image/jpeg', bytes: new Uint8Array(i === 1 ? 50 : 5) }),
        ]),
      ),
    );
    const local = await localizeImages(
      issue({ body: urls.map((u) => `![](${u})`).join('\n'), comments: [] }),
      RYAN_LINEAR,
      { dir, shownAs: (f) => f, download, limits: { maxFiles: 3, maxBytes: 10 } },
    );
    expect(asked).toEqual(urls.slice(0, 3));
    expect(local.attachments.map((a) => a.missing ?? 'ok')).toEqual([
      'ok',
      'it is over 10 bytes',
      'ok',
      'the factory takes at most 3 images from an issue',
    ]);
    expect(readdirSync(dir).filter((f) => f.endsWith('.jpg'))).toHaveLength(2);
  });

  it('reuses a file it already has, so each poll does not download again', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'images-'));
    const first = fakeDownload({ [SHOT]: png, [SECOND]: png });
    const one = await localizeImages(issue(), RYAN_LINEAR, {
      dir,
      shownAs: (f) => f,
      download: first.download,
    });
    const again = fakeDownload({});
    const two = await localizeImages(issue(), RYAN_LINEAR, {
      dir,
      shownAs: (f) => f,
      download: again.download,
    });
    expect(again.asked).toEqual([]);
    expect(two.issue.body).toBe(one.issue.body);
  });

  it('says so when the tracker has no download, and leaves an issue with no images alone', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'images-'));
    const local = await localizeImages(issue(), RYAN_LINEAR, { dir, shownAs: (f) => f });
    expect(local.attachments.every((a) => a.missing === "the tracker can't download files")).toBe(
      true,
    );
    const plain = issue({ body: 'No pictures', comments: [] });
    expect(await localizeImages(plain, RYAN_LINEAR, { dir, shownAs: (f) => f })).toEqual({
      issue: plain,
      note: '',
      attachments: [],
    });
  });

  it('never writes through a link at its folder', async () => {
    const root = mkdtempSync(join(tmpdir(), 'images-'));
    const elsewhere = join(root, 'elsewhere');
    mkdirSync(elsewhere);
    const dir = join(root, 'attachments');
    symlinkSync(elsewhere, dir);
    const { download, asked } = fakeDownload({ [SHOT]: png, [SECOND]: png });
    const local = await localizeImages(issue(), RYAN_LINEAR, { dir, shownAs: (f) => f, download });
    expect(asked).toEqual([]);
    expect(readdirSync(elsewhere)).toEqual([]);
    expect(local.attachments[0]?.missing).toBe("the factory's folder for it isn't a plain folder");
  });
});

describe("a run's images in its worktree", () => {
  it('copies them into .factory/attachments', () => {
    const from = mkdtempSync(join(tmpdir(), 'run-'));
    const worktree = mkdtempSync(join(tmpdir(), 'wt-'));
    writeFileSync(join(from, 'abc.png'), PNG);
    expect(stageAttachments(from, worktree)).toEqual(['abc.png']);
    expect(readFileSync(join(worktree, '.factory', 'attachments', 'abc.png'))).toEqual(
      Buffer.from(PNG),
    );
    expect(stageAttachments(join(from, 'none'), worktree)).toEqual([]);
  });

  it('never copies through a link the agent left in its worktree', () => {
    const from = mkdtempSync(join(tmpdir(), 'run-'));
    writeFileSync(join(from, 'abc.png'), PNG);
    const outside = mkdtempSync(join(tmpdir(), 'outside-'));
    // A linked .factory folder gets nothing.
    const linked = mkdtempSync(join(tmpdir(), 'wt-'));
    symlinkSync(outside, join(linked, '.factory'));
    expect(stageAttachments(from, linked)).toEqual([]);
    expect(readdirSync(outside)).toEqual([]);
    // A link at a file's name is replaced, not written through.
    const worktree = mkdtempSync(join(tmpdir(), 'wt-'));
    mkdirSync(join(worktree, '.factory', 'attachments'), { recursive: true });
    const target = join(outside, 'target');
    writeFileSync(target, 'keep');
    symlinkSync(target, join(worktree, '.factory', 'attachments', 'abc.png'));
    expect(stageAttachments(from, worktree)).toEqual(['abc.png']);
    expect(readFileSync(target, 'utf8')).toBe('keep');
    expect(readFileSync(join(worktree, '.factory', 'attachments', 'abc.png'))).toEqual(
      Buffer.from(PNG),
    );
  });
});

describe('the issue an agent gets', () => {
  const tracker = (download?: Download): Tracker =>
    ({
      name: 'linear',
      owner: RYAN_LINEAR,
      ...(download ? { download } : {}),
    }) as unknown as Tracker;

  it("has a run's images at .factory/attachments, relative to its worktree", async () => {
    const config = { ...linearConfig(), stateDir: mkdtempSync(join(tmpdir(), 'state-')) };
    const { download } = fakeDownload({ [SHOT]: png, [SECOND]: png });
    const { text } = await issueForAgent(tracker(download), issue(), runImages(config, '66-r1'));
    expect(readdirSync(join(config.stateDir, 'runs', '66-r1', 'attachments'))).toHaveLength(2);
    expect(text).toMatch(/!\[screenshot\]\(\.factory\/attachments\/[0-9a-f]{16}\.png\)/);
    expect(text).toContain('relative to the repository root');
    expect(text).toContain('<untrusted author="Sam">');
    expect(text).not.toContain(SHOT);
  });

  it('gets the issue as it is when the images cannot be handled at all', async () => {
    const root = mkdtempSync(join(tmpdir(), 'state-'));
    // A file where the folder should be: making the folder throws.
    writeFileSync(join(root, 'blocker'), '');
    const { download } = fakeDownload({ [SHOT]: png, [SECOND]: png });
    const { text, issue: got } = await issueForAgent(tracker(download), issue(), {
      dir: join(root, 'blocker', 'attachments'),
      shownAs: (f) => f,
    });
    expect(got.body).toContain(SHOT);
    expect(text).toContain("The factory couldn't download the issue's images");
    expect(existsSync(join(root, 'blocker', 'attachments'))).toBe(false);
  });
});

describe("Linear's download (the app's token stays on the host)", () => {
  const ok = (body: Uint8Array, headers: Record<string, string> = {}) =>
    new Response(body, { status: 200, headers: { 'content-type': 'image/png', ...headers } });

  it("sends the app's token to Linear's uploads, and nowhere a redirect goes", async () => {
    const seen: { url: string; auth: string | null; redirect: string | undefined }[] = [];
    const fetcher: Fetcher = (url, init) => {
      seen.push({
        url,
        auth: new Headers(init.headers).get('authorization'),
        redirect: init.redirect,
      });
      return Promise.resolve(
        url === SHOT
          ? new Response(null, {
              status: 302,
              headers: { location: 'https://storage.example.com/signed?x=1' },
            })
          : ok(PNG),
      );
    };
    const client = createLinearClient({ token: () => Promise.resolve('app-tok'), fetcher });
    const got = await client.download!(SHOT, 1000);
    expect(got.contentType).toBe('image/png');
    expect(got.bytes).toEqual(PNG);
    expect(seen).toEqual([
      { url: SHOT, auth: 'Bearer app-tok', redirect: 'manual' },
      { url: 'https://storage.example.com/signed?x=1', auth: null, redirect: 'manual' },
    ]);
  });

  it('refuses any address but an upload, without asking', async () => {
    const fetcher: Fetcher = () => Promise.reject(new Error('should not fetch'));
    const client = createLinearClient({ token: () => Promise.resolve('app-tok'), fetcher });
    await expect(client.download!('https://example.com/x.png', 1000)).rejects.toThrow(
      'not a Linear upload: example.com',
    );
    await expect(client.download!('http://uploads.linear.app/x', 1000)).rejects.toThrow(
      'not a Linear upload',
    );
  });

  it('stops at the size cap, declared or streamed, and names errors without the token', async () => {
    const big = new Uint8Array(2000);
    const declared: Fetcher = () =>
      Promise.resolve(new Response(big, { headers: { 'content-length': '2000' } }));
    const streamed: Fetcher = () =>
      Promise.resolve(
        new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(big.slice(0, 800));
              c.enqueue(big.slice(800));
              c.close();
            },
          }),
        ),
      );
    const refused: Fetcher = () => Promise.resolve(new Response('no', { status: 403 }));
    for (const fetcher of [declared, streamed]) {
      const client = createLinearClient({ token: () => Promise.resolve('secret-tok'), fetcher });
      await expect(client.download!(SHOT, 1000)).rejects.toThrow('the file is over 1000 bytes');
    }
    const client = createLinearClient({
      token: () => Promise.resolve('secret-tok'),
      fetcher: refused,
    });
    const error = await client.download!(SHOT, 1000).then(
      () => new Error('it downloaded'),
      (e: unknown) => e as Error,
    );
    expect(error.message).toBe('Linear refused the download: HTTP 403');
    expect(error.message).not.toContain('secret-tok');
  });
});
