/**
 * The images attached to an issue, for agents that have no tracker credentials (and must never
 * get them). Linear serves an issue's images from `uploads.linear.app`, which needs the app's
 * token: PEN-64's and PEN-66's planning sessions couldn't open the screenshot the issue was
 * about. So the host downloads each one, with the tracker's own client, into a folder the agent
 * can read, and the issue's text points at the local file instead. A download that fails, or an
 * image past the limits, never stops the run: the text says why it is missing.
 */
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { Issue } from './issue.ts';
import type { Downloaded } from './tracker/linear-client.ts';

export type Download = (url: string, maxBytes: number) => Promise<Downloaded>;

export interface AttachmentLimits {
  /** The most images taken from one issue; the rest are noted, not downloaded. */
  readonly maxFiles: number;
  /** The largest image taken, in bytes. */
  readonly maxBytes: number;
}

export const ATTACHMENT_LIMITS: AttachmentLimits = { maxFiles: 10, maxBytes: 10 * 1_048_576 };

/** The folder the images go in: in a run's folder on the host, and in its worktree's `.factory`. */
export const ATTACHMENTS = 'attachments';

/** The image types an agent's Read tool shows, with the extension each file gets. */
const IMAGE_TYPES: Readonly<Record<string, string>> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};

/**
 * A Linear upload in Markdown, `![alt](url)`, or bare (without the sentence's punctuation after
 * it): the Markdown around it is kept, to annotate after it.
 */
const UPLOAD =
  /(!?\[[^\]\n]*\]\()?(https:\/\/uploads\.linear\.app\/[^\s()<>"'\]]*[^\s()<>"'\].,;:!?])(\))?/g;

export interface Attachment {
  readonly url: string;
  /** The file as the agent reads it, when it was downloaded. */
  readonly path?: string;
  /** Why it wasn't, when it wasn't. */
  readonly missing?: string;
}

export interface LocalImages {
  /** The issue with each image pointing at its local file, or saying why it has none. */
  readonly issue: Issue;
  /** A section for the prompt that lists the images, or '' when the issue has none. */
  readonly note: string;
  readonly attachments: readonly Attachment[];
}

export interface LocalImageOptions {
  /** Where the host writes the files. */
  readonly dir: string;
  /** The path the agent reads a file in `dir` at (its sandbox may see it somewhere else). */
  readonly shownAs: (file: string) => string;
  /** The tracker's download (`Tracker.download`); without one, nothing is downloaded. */
  readonly download?: Download | undefined;
  readonly limits?: AttachmentLimits;
  /** What `shownAs` paths are relative to, for the note, when they aren't absolute. */
  readonly relativeTo?: string;
}

/** The Linear uploads in a text, each once, in order. */
export function uploadUrls(text: string): string[] {
  return [...new Set([...text.matchAll(UPLOAD)].map((m) => m[2] ?? ''))].filter(Boolean);
}

/** The file name an upload gets: its address hashed, so a later poll finds it already there. */
const stem = (url: string) => createHash('sha256').update(url).digest('hex').slice(0, 16);

const sizeText = (bytes: number) =>
  bytes >= 1_048_576 ? `${Math.round(bytes / 1_048_576)} MB` : `${bytes} bytes`;

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Downloads the images in the issue's description and in its owner's comments (others' comments
 * stay as they are: data, R14), and rewrites those texts to point at the files.
 */
export async function localizeImages(
  issue: Issue,
  owner: string,
  options: LocalImageOptions,
): Promise<LocalImages> {
  const limits = options.limits ?? ATTACHMENT_LIMITS;
  const ours = (c: Issue['comments'][number]) => c.author === owner;
  const urls = uploadUrls(
    [issue.body, ...issue.comments.filter(ours).map((c) => c.body)].join('\n'),
  );
  if (urls.length === 0) return { issue, note: '', attachments: [] };

  const attachments: Attachment[] = [];
  if (!plainDir(options.dir)) {
    for (const url of urls)
      attachments.push({ url, missing: "the factory's folder for it isn't a plain folder" });
  } else {
    const kept = readdirSync(options.dir);
    for (const [i, url] of urls.entries())
      attachments.push(await take(url, i, kept, options, limits));
  }
  const byUrl = new Map(attachments.map((a) => [a.url, a]));
  const rewrite = (text: string) =>
    text.replaceAll(UPLOAD, (whole, open: string | undefined, url: string, close?: string) => {
      const a = byUrl.get(url);
      if (!a) return whole;
      if (a.path) return `${open ?? ''}${a.path}${close ?? ''}`;
      return `${whole} (the factory couldn't download this image: ${a.missing})`;
    });
  return {
    issue: {
      ...issue,
      body: rewrite(issue.body),
      comments: issue.comments.map((c) => (ours(c) ? { ...c, body: rewrite(c.body) } : c)),
    },
    note: imagesNote(attachments, options.relativeTo),
    attachments,
  };
}

async function take(
  url: string,
  index: number,
  kept: readonly string[],
  options: LocalImageOptions,
  limits: AttachmentLimits,
): Promise<Attachment> {
  if (index >= limits.maxFiles)
    return { url, missing: `the factory takes at most ${limits.maxFiles} images from an issue` };
  const name = stem(url);
  const already = kept.find((f) => f.startsWith(`${name}.`));
  if (already) return { url, path: options.shownAs(already) };
  if (!options.download) return { url, missing: "the tracker can't download files" };
  try {
    const got = await options.download(url, limits.maxBytes);
    const type = got.contentType.split(';')[0]?.trim().toLowerCase() ?? '';
    const ext = IMAGE_TYPES[type];
    if (!ext) return { url, missing: `it is ${type || 'of no stated type'}, not an image` };
    if (got.bytes.byteLength > limits.maxBytes)
      return { url, missing: `it is over ${sizeText(limits.maxBytes)}` };
    const file = `${name}.${ext}`;
    // `wx`: never through a link someone else left at that name.
    writeFileSync(join(options.dir, file), got.bytes, { flag: 'wx' });
    return { url, path: options.shownAs(file) };
  } catch (error) {
    return { url, missing: message(error) };
  }
}

/** The prompt's list of the issue's images: where each one is, or why it isn't. */
export function imagesNote(attachments: readonly Attachment[], relativeTo?: string): string {
  if (attachments.length === 0) return '';
  return [
    "## The issue's images",
    '',
    `The factory downloaded the images in the issue from Linear, where they need a login you do not have, and the issue above points at these files instead${relativeTo ? ` (relative to ${relativeTo})` : ''}. Open each with your Read tool:`,
    '',
    ...attachments.map((a, i) =>
      a.path ? `${i + 1}. \`${a.path}\`` : `${i + 1}. Not downloaded (${a.missing}): ${a.url}`,
    ),
  ].join('\n');
}

/** Makes `dir` if it is missing; false when something other than a real folder is there. */
function plainDir(dir: string): boolean {
  if (!existsSync(dir) && !isLink(dir)) mkdirSync(dir, { recursive: true });
  return lstatSync(dir).isDirectory();
}

function isLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Copies the run's downloaded images into a sandbox's worktree, at `.factory/attachments/`, which
 * git ignores. The agent may have written that worktree in an earlier round, so the copy never
 * goes through a link: a `.factory` or `attachments` that isn't a real folder gets nothing, and a
 * file already at a name is removed first. Returns the names copied.
 */
export function stageAttachments(from: string, worktree: string): string[] {
  if (!existsSync(from) || !lstatSync(from).isDirectory()) return [];
  const names = readdirSync(from).filter((n) => lstatSync(join(from, n)).isFile());
  if (names.length === 0) return [];
  if (!plainDir(join(worktree, '.factory'))) return [];
  const to = join(worktree, '.factory', ATTACHMENTS);
  if (!plainDir(to)) return [];
  for (const n of names) {
    rmSync(join(to, n), { force: true, recursive: true });
    copyFileSync(join(from, n), join(to, n), constants.COPYFILE_EXCL);
  }
  return names;
}
