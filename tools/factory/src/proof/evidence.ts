/**
 * What a failing proof test leaves for the agent's next round (A1342). The gate's worktree, with
 * Playwright's output (or the Android proof's logs), is gone once it closes, and the Mac proof ran
 * in a VM the sandbox can't reach. So the host keeps each failing test's last screenshot, its
 * `error-context.md`, its text attachments and its error in the run folder's `raw/`, beside the
 * proof's own files, and the next sandbox finds them in `.factory/last-proof/` (`stageLastProof`).
 * PEN-121's Mac proof failed for several rounds with none of it kept, and each round guessed.
 */
import {
  closeSync,
  copyFileSync,
  existsSync,
  openSync,
  readdirSync,
  readSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import {
  isFailed,
  lastResults,
  parseFrames,
  type PwAttachment,
  type PwReport,
} from './manifest.ts';
import { within } from './media.ts';

/** A text file is cut to this many bytes: its last ones, or an error context's first ones. */
export const EVIDENCE_TEXT_BYTES = 200 * 1024;
/** A screenshot larger than this is left out. */
export const EVIDENCE_IMAGE_BYTES = 5 * 1024 * 1024;
/** All of one platform's evidence; what doesn't fit is named in the index, not copied. */
export const EVIDENCE_TOTAL_BYTES = 4 * 1024 * 1024;
/** Failing tests kept per platform, and files per test. */
export const EVIDENCE_TESTS = 10;
export const EVIDENCE_FILES = 12;
/** A failing test's error, as the index shows it. */
const ERROR_CHARS = 8000;

export interface EvidenceFile {
  /** The attachment's name, or what the file is. */
  readonly label: string;
  readonly kind: 'screenshot' | 'error-context' | 'text' | 'image';
  /** The file on the host (a VM's path already mapped back), or its content. */
  readonly path?: string;
  readonly body?: Buffer;
  readonly contentType?: string;
}

export interface FailedTest {
  /** The test's place among the proof's tests, from 1: the `<n>` of `<platform>-<n>-…` files. */
  readonly n: number;
  readonly title: string;
  readonly error?: string;
  readonly files: readonly EvidenceFile[];
}

/** A terminal colour code (ESC, then `[…m` and the like), which a report's errors carry. */
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]`, 'g');
const TEXT_TYPE = /^(text\/|application\/(json|x-ndjson|xml)$|application\/[\w.-]+\+json$)/;
const TEXT_EXT = new Set(['.txt', '.log', '.md', '.json', '.logcat']);

/**
 * The failing tests in a Playwright JSON report, with what each left: its last screenshot (the
 * `screenshot` attachment, else the last frame the Mac proof's screencast wrote), its error
 * context, its PNGs and its text attachments. `map` turns a path the report names into the host's
 * (the Mac proof's report names the VM's paths).
 */
export function playwrightFailures(
  report: PwReport,
  map: (path: string) => string = (path) => path,
): FailedTest[] {
  const failed: FailedTest[] = [];
  lastResults(report).forEach(({ title, last }, i) => {
    if (!isFailed(last)) return;
    const attachments = last.attachments ?? [];
    const files: EvidenceFile[] = [];
    const seen = new Set<string>();
    for (const a of attachments) {
      const file = evidenceOf(a, map);
      if (!file) continue;
      const key = file.path ?? `${a.name}\u0000${a.body ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      files.push(file);
    }
    // The last screenshot first, so a cap on files never drops it.
    let shot = files.filter((f) => f.kind === 'screenshot').at(-1);
    if (!shot) {
      const frame = lastFrame(attachments, map);
      if (frame)
        shot = { label: "the window's last screencast frame", kind: 'screenshot', path: frame };
    }
    const rest = files.filter((f) => f.kind !== 'screenshot');
    const error = (last.errors ?? [])
      .map((e) => (e.message ?? '').replaceAll(ANSI, '').trimEnd())
      .filter(Boolean)
      .join('\n\n');
    failed.push({
      n: i + 1,
      title,
      ...(error ? { error } : {}),
      files: shot ? [shot, ...rest] : rest,
    });
  });
  return failed;
}

function evidenceOf(a: PwAttachment, map: (path: string) => string): EvidenceFile | undefined {
  const type = (a.contentType ?? '').toLowerCase();
  const path = a.path ? map(a.path) : undefined;
  const body = !path && a.body ? Buffer.from(a.body, 'base64') : undefined;
  if (!path && !body) return undefined;
  const source = { ...(path ? { path } : {}), ...(body ? { body } : {}), contentType: type };
  // The screencast's frames and the video are the proof's own; a trace is a zip.
  if (a.name === 'video-frames' || a.name === 'video' || a.name === 'trace') return undefined;
  if (a.name === 'screenshot' && type.startsWith('image/'))
    return type === 'image/png' ? { label: a.name, kind: 'screenshot', ...source } : undefined;
  if (a.name === 'error-context') return { label: a.name, kind: 'error-context', ...source };
  if (type === 'image/png') return { label: a.name, kind: 'image', ...source };
  if (TEXT_TYPE.test(type) || (!type && path && TEXT_EXT.has(extname(path).toLowerCase())))
    return { label: a.name, kind: 'text', ...source };
  return undefined;
}

/**
 * The newest frame the Mac proof's screencast wrote for a test (`apps/desktop/test/e2e/support.ts`):
 * from its `video-frames` attachment, or, for a test that failed before its window closed and so
 * attached none, from the `frames-*` folders in the test's output folder (where its error context
 * or trace is).
 */
function lastFrame(
  attachments: readonly PwAttachment[],
  map: (path: string) => string,
): string | undefined {
  const attached = attachments
    .filter((a) => a.name === 'video-frames')
    .map((a) => parseFrames(a.body))
    .at(-1);
  if (attached) {
    const file = attached.frames.at(-1)?.file;
    return file ? join(map(attached.dir), file) : undefined;
  }
  const marker = attachments.find(
    (a) => (a.name === 'error-context' || a.name === 'trace') && a.path,
  )?.path;
  if (!marker) return undefined;
  const out = dirname(map(marker));
  if (!existsSync(out)) return undefined;
  const dirs = readdirSync(out, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name.startsWith('frames-'))
    .map((d) => join(out, d.name))
    .sort((a, b) => statSync(a).mtimeMs - statSync(b).mtimeMs);
  for (const dir of dirs.reverse()) {
    const frame = readdirSync(dir)
      .filter((f) => /^\d+\.jpg$/.test(f))
      .sort()
      .at(-1);
    if (frame) return join(dir, frame);
  }
  return undefined;
}

/**
 * The failing tests of an Android proof (`apps/android/scripts/proof.sh`, whose report lists the
 * tests in the order it numbered their files in `out`): each one's screenshot, its
 * instrumentation output and the device's logcat.
 */
export function androidFailures(
  report: readonly {
    readonly title: string;
    readonly status: string;
    readonly screenshot?: string;
  }[],
  out: string,
): FailedTest[] {
  return report.flatMap((r, i) => {
    if (r.status === 'passed') return [];
    const n = i + 1;
    const candidates: EvidenceFile[] = [
      ...(r.screenshot
        ? [{ label: 'screenshot', kind: 'screenshot' as const, path: join(out, r.screenshot) }]
        : []),
      { label: 'instrumentation output', kind: 'text', path: join(out, `android-${n}.log`) },
      { label: 'logcat', kind: 'text', path: join(out, `android-${n}.logcat`) },
    ];
    return [{ n, title: r.title, files: candidates.filter((f) => f.path && existsSync(f.path)) }];
  });
}

function slug(label: string): string {
  return (
    label
      .toLowerCase()
      .replaceAll(/[^a-z0-9]+/g, '-')
      .replaceAll(/^-+|-+$/g, '')
      .slice(0, 40)
      .replaceAll(/-+$/g, '') || 'attachment'
  );
}

function textExtension(file: EvidenceFile): string {
  const ext = file.path ? extname(file.path).toLowerCase() : '';
  if (TEXT_EXT.has(ext)) return ext;
  const type = file.contentType ?? '';
  if (type.includes('json')) return '.json';
  if (type === 'text/markdown') return '.md';
  return '.txt';
}

/** Up to `cap` bytes of a file: its first ones, or its last. */
function readCapped(path: string, cap: number, from: 'head' | 'tail'): Buffer {
  const size = statSync(path).size;
  const length = Math.min(size, cap);
  const buffer = Buffer.alloc(length);
  const fd = openSync(path, 'r');
  try {
    readSync(fd, buffer, 0, length, from === 'tail' ? size - length : 0);
  } finally {
    closeSync(fd);
  }
  return buffer;
}

/** A text file's content, cut to `EVIDENCE_TEXT_BYTES` with a line saying so. */
function cappedText(file: EvidenceFile): { text: Buffer; cut?: string } {
  const from = file.kind === 'error-context' ? 'head' : 'tail';
  const size = file.path ? statSync(file.path).size : (file.body?.length ?? 0);
  const content = file.path
    ? readCapped(file.path, EVIDENCE_TEXT_BYTES, from)
    : from === 'head'
      ? (file.body ?? Buffer.alloc(0)).subarray(0, EVIDENCE_TEXT_BYTES)
      : (file.body ?? Buffer.alloc(0)).subarray(-EVIDENCE_TEXT_BYTES);
  if (size <= EVIDENCE_TEXT_BYTES) return { text: content };
  const kb = Math.round(size / 1024);
  const cut = from === 'head' ? `its first 200 KB of ${kb} KB` : `its last 200 KB of ${kb} KB`;
  const note = `[factory: ${cut}]\n`;
  return {
    text:
      from === 'head'
        ? Buffer.concat([content, Buffer.from(`\n${note}`)])
        : Buffer.concat([Buffer.from(note), content]),
    cut,
  };
}

/** The index of a platform's failing tests in `raw/`, which the prompt names. */
export function failuresIndex(platform: string): string {
  return `${platform}-failures.md`;
}

/**
 * Copies each failing test's evidence into `raw` as `<platform>-<n>-<what>`, and writes
 * `<platform>-failures.md`: each failing test's title, error and files. Only files inside `root`
 * (the gate's worktree) are copied, text is cut to `EVIDENCE_TEXT_BYTES`, and other binaries than
 * PNGs (and the Mac proof's last JPEG frame) are left out. Returns the names written.
 */
export function keepFailures(
  failed: readonly FailedTest[],
  platform: string,
  raw: string,
  root: string,
): string[] {
  if (failed.length === 0) return [];
  const written: string[] = [];
  let budget = EVIDENCE_TOTAL_BYTES;
  const sections: string[] = [];
  for (const test of failed.slice(0, EVIDENCE_TESTS)) {
    const lines: string[] = [`## ${test.n}. ${test.title}`, ''];
    if (test.error) {
      const error =
        test.error.length > ERROR_CHARS ? `${test.error.slice(0, ERROR_CHARS)}\n…` : test.error;
      lines.push('```text', error, '```', '');
    }
    const used = new Set<string>();
    const name = (stem: string, ext: string) => {
      let candidate = `${platform}-${test.n}-${stem}${ext}`;
      for (let k = 2; used.has(candidate) || existsSync(join(raw, candidate)); k++)
        candidate = `${platform}-${test.n}-${stem}-${k}${ext}`;
      used.add(candidate);
      return candidate;
    };
    const left: string[] = [];
    for (const file of test.files.slice(0, EVIDENCE_FILES)) {
      if (file.path && !within(file.path, root)) continue;
      if (file.kind === 'screenshot' || file.kind === 'image') {
        const ext = file.path ? extname(file.path).toLowerCase() : '.png';
        if (ext !== '.png' && !(file.kind === 'screenshot' && ext === '.jpg')) continue;
        const size = file.path ? statSync(file.path).size : (file.body?.length ?? 0);
        if (size > EVIDENCE_IMAGE_BYTES || size > budget) {
          left.push(`${file.label} (${Math.round(size / 1024)} KB)`);
          continue;
        }
        // The proof's own copy of its screenshot is already there (host.ts).
        const own = `${platform}-${test.n}-screenshot${ext}`;
        if (file.kind === 'screenshot' && existsSync(join(raw, own))) {
          lines.push(`- \`${own}\`: its last screenshot`);
          continue;
        }
        const to = file.kind === 'screenshot' ? own : name(slug(file.label), '.png');
        used.add(to);
        if (file.path) copyFileSync(file.path, join(raw, to));
        else writeFileSync(join(raw, to), file.body ?? Buffer.alloc(0));
        budget -= size;
        written.push(to);
        lines.push(
          `- \`${to}\`: ${file.kind === 'screenshot' ? (file.label === 'screenshot' ? 'its last screenshot' : file.label) : `the attachment "${file.label}"`}`,
        );
        continue;
      }
      const { text, cut } = cappedText(file);
      if (text.length > budget) {
        left.push(`${file.label} (${Math.round(text.length / 1024)} KB)`);
        continue;
      }
      const to =
        file.kind === 'error-context'
          ? name('error-context', '.md')
          : name(slug(file.label), textExtension(file));
      writeFileSync(join(raw, to), text);
      budget -= text.length;
      written.push(to);
      const what =
        file.kind === 'error-context'
          ? "Playwright's error context"
          : `the attachment "${file.label}"${file.path ? ` (${basename(file.path)})` : ''}`;
      lines.push(`- \`${to}\`: ${what}${cut ? `, cut to ${cut}` : ''}`);
    }
    if (test.files.length > EVIDENCE_FILES)
      left.push(`${test.files.length - EVIDENCE_FILES} more attachments`);
    if (left.length > 0) lines.push(`- Left out, for size: ${left.join('; ')}`);
    sections.push(lines.join('\n'));
  }
  if (failed.length > EVIDENCE_TESTS)
    sections.push(
      `${failed.length - EVIDENCE_TESTS} more tests failed; only the first ${EVIDENCE_TESTS} are here.`,
    );
  const index = failuresIndex(platform);
  writeFileSync(
    join(raw, index),
    `# The ${platform} proof's failing tests\n\nEach test's files are beside this one, in \`.factory/last-proof/\`.\n\n${sections.join('\n\n')}\n`,
  );
  written.push(index);
  return written;
}
