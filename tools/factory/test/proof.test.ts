import { describe, expect, it } from 'vitest';
import { proofFiles, renderPrBody } from '../src/proof/body.ts';
import { fromPlaywrightReport, missingProof } from '../src/proof/manifest.ts';
import {
  checkMedia,
  framesList,
  MAX_IMAGE_BYTES,
  MAX_VIDEO_BYTES,
  mp4Args,
} from '../src/proof/media.ts';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe('media rules', () => {
  const sizes: Record<string, number> = {
    'a.mp4': MAX_VIDEO_BYTES,
    'big.mp4': MAX_VIDEO_BYTES + 1,
    'a.png': MAX_IMAGE_BYTES - 1,
    'big.png': MAX_IMAGE_BYTES,
    'fake.png': 10,
    'a.webm': 1,
  };
  const check = (paths: string[]) =>
    checkMedia(
      paths,
      (p) => sizes[p] ?? 0,
      (p) => (p === 'fake.png' ? Buffer.from('notapng!') : PNG),
    );
  it('allows MP4s of 25 MB or less and PNGs under 10 MB', () => {
    expect(check(['a.mp4', 'a.png'])).toEqual([]);
  });
  it('names each file over the limit, not a PNG, or of another type', () => {
    expect(
      check(['big.mp4', 'big.png', 'fake.png', 'a.webm']).map((p) => [p.path, p.problem]),
    ).toEqual([
      ['big.mp4', 'video is 25.0 MB, over 25 MB'],
      ['big.png', 'image is 10.0 MB, 10 MB or over'],
      ['fake.png', 'not a PNG file'],
      ['a.webm', 'only .mp4 videos and .png images are attached'],
    ]);
  });
  it('encodes H.264, yuv420p, faststart, at most 1280 wide, without sound', () => {
    const args = mp4Args('in.webm', 'out.mp4').join(' ');
    expect(args).toContain('-c:v libx264');
    expect(args).toContain('-pix_fmt yuv420p');
    expect(args).toContain('-movflags +faststart');
    expect(args).toContain("scale='min(1280,iw)':-2");
    expect(args).toContain('-an');
  });
});

describe('the manifest', () => {
  const report = {
    suites: [
      {
        title: 'comments.spec.ts',
        specs: [
          {
            title: 'a thread opens',
            tests: [
              {
                results: [
                  { status: 'failed', attachments: [] },
                  {
                    status: 'passed',
                    attachments: [
                      { name: 'video', path: '/r/video.webm', contentType: 'video/webm' },
                      {
                        name: 'screenshot',
                        path: '/r/test-finished-1.png',
                        contentType: 'image/png',
                      },
                      { name: 'trace', path: '/r/trace.zip', contentType: 'application/zip' },
                    ],
                  },
                ],
              },
            ],
          },
        ],
        suites: [
          {
            title: 'margin',
            specs: [
              {
                title: 'times out',
                tests: [{ results: [{ status: 'timedOut', attachments: [] }] }],
              },
            ],
          },
        ],
      },
    ],
  };
  const items = fromPlaywrightReport(report, 'web', 'after');
  it("takes each test's last run, its video and its final screenshot", () => {
    expect(items).toEqual([
      {
        platform: 'web',
        title: 'a thread opens',
        status: 'passed',
        phase: 'after',
        source: 'harness',
        video: '/r/video.webm',
        screenshot: '/r/test-finished-1.png',
      },
      {
        platform: 'web',
        title: 'margin › times out',
        status: 'failed',
        phase: 'after',
        source: 'harness',
      },
    ]);
  });
  it('R9: an in-scope platform needs a passing harness recording', () => {
    expect(missingProof(items, ['web'])).toEqual([]);
    expect(missingProof(items, ['web', 'android'])).toEqual(['android']);
    expect(missingProof([{ ...items[0]!, source: 'agent' }], ['web'])).toEqual(['web']);
  });
});

describe("the Mac app's screencast frames (F7)", () => {
  const body = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64');
  const report = (attachments: unknown[]) => ({
    suites: [
      {
        title: 'app.spec.ts',
        specs: [{ title: 'opens', tests: [{ results: [{ status: 'passed', attachments }] }] }],
      },
    ],
  });

  it('reads the frames a test attached as a body', () => {
    const frames = {
      dir: '/vm/apps/desktop/test-results/proof/t/frames-1',
      frames: [{ file: '00000.jpg', at: 10 }],
    };
    const [item] = fromPlaywrightReport(
      report([
        { name: 'video-frames', contentType: 'application/json', body: body(frames) },
      ]) as never,
      'mac',
      'after',
    );
    expect(item?.frames).toEqual([frames]);
  });

  it('ignores frames with names that are not its own JPEGs', () => {
    const frames = {
      dir: '/d',
      frames: [
        { file: '../../x.jpg', at: 1 },
        { file: "0'1.jpg", at: 2 },
      ],
    };
    const [item] = fromPlaywrightReport(
      report([{ name: 'video-frames', body: body(frames) }]) as never,
      'mac',
      'after',
    );
    expect(item?.frames).toBeUndefined();
  });

  it('plays every window in turn, each frame until the next, at most two seconds', () => {
    const list = framesList(
      [
        {
          dir: '/vm/a',
          frames: [
            { file: '00000.jpg', at: 10 },
            { file: '00001.jpg', at: 12.5 },
          ],
        },
        { dir: '/vm/b', frames: [{ file: '00000.jpg', at: 13 }] },
      ],
      ['/out/a', '/out/b'],
    );
    expect(list).toBe(
      [
        'ffconcat version 1.0',
        "file '/out/a/00000.jpg'",
        'duration 2.000',
        "file '/out/a/00001.jpg'",
        'duration 0.500',
        "file '/out/b/00000.jpg'",
        'duration 1.000',
        "file '/out/b/00000.jpg'",
        '',
      ].join('\n'),
    );
  });
});

describe('the PR body', () => {
  const body = renderPrBody({
    issue: 12,
    summary: 'Threads open from the margin',
    scope: { kind: 'product', platforms: ['web', 'mac', 'android'] },
    gate: 'task check',
    proof: [
      {
        label: 'web: a [thread] opens',
        phase: 'before',
        source: 'harness',
        image: 'web-before-1.png',
      },
      {
        label: 'web: a thread opens',
        phase: 'after',
        source: 'harness',
        image: 'web-1.png',
        video: 'web-1.mp4',
      },
      { label: 'by hand', phase: 'after', source: 'agent', image: 'extra-1.png' },
    ],
    decisions: ['A-NEW-1: sheets on phones'],
    risks: [],
    marker: '<!-- penmoss-factory run=r -->',
  });
  it('says Part of, never Closes (R20)', () => {
    expect(body.startsWith('Part of #12.')).toBe(true);
    expect(body).not.toMatch(/\b(Closes|Fixes|Resolves) #/);
  });
  it('references images inline and links each video (A1223)', () => {
    expect(body).toContain('![web: a  thread  opens](./web-before-1.png)');
    expect(body).toContain('\n\n[▶ Watch the recording (MP4)](./web-1.mp4)');
    expect(body).toContain('### Before (the new test on the base commit)');
    expect(body).toContain('### After');
  });
  it("labels the agent's own stills and keeps them out of the proof", () => {
    expect(body).toContain('![agent-captured: by hand](./extra-1.png)');
  });
  it('lists every referenced file for the upload', () => {
    expect(
      proofFiles([
        { label: 'x', phase: 'after', source: 'harness', image: 'web-1.png', video: 'web-1.mp4' },
      ]),
    ).toEqual(['web-1.png', 'web-1.mp4']);
  });
});
