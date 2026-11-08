/**
 * Proof media (F5): every video becomes an H.264 MP4 GitHub plays inline (yuv420p, +faststart,
 * at most 1280 px wide, 25 MB or less), and screenshots must be PNGs under 10 MB.
 */
import { readFileSync, statSync } from 'node:fs';
import type { Exec } from '../exec.ts';

export const MAX_VIDEO_BYTES = 25 * 1024 * 1024;
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** ffmpeg arguments for one conversion; a higher `crf` makes a smaller file. */
export function mp4Args(input: string, output: string, crf = 28): string[] {
  return [
    '-y',
    '-loglevel',
    'error',
    '-i',
    input,
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    String(crf),
    '-pix_fmt',
    'yuv420p',
    '-movflags',
    '+faststart',
    // Never wider than 1280, and an even height, as H.264 needs.
    '-vf',
    "scale='min(1280,iw)':-2",
    '-an',
    output,
  ];
}

/** Converts a recording to MP4, re-encoding smaller until it fits. */
export async function toMp4(exec: Exec, input: string, output: string): Promise<void> {
  for (const crf of [28, 34, 40]) {
    const r = await exec('ffmpeg', mp4Args(input, output, crf));
    if (r.code !== 0)
      throw new Error(
        `ffmpeg couldn't convert ${input}: ${r.stderr.trim().split('\n').slice(-1)[0] ?? ''}`,
      );
    if (statSync(output).size <= MAX_VIDEO_BYTES) return;
  }
  throw new Error(`${output} is still over 25 MB at the lowest quality`);
}

export type MediaProblem = { readonly path: string; readonly problem: string };

/** Which files break the rules (empty when all is well). */
export function checkMedia(
  paths: readonly string[],
  size = (p: string) => statSync(p).size,
  head = pngHead,
): MediaProblem[] {
  const problems: MediaProblem[] = [];
  for (const path of paths) {
    const bytes = size(path);
    if (path.endsWith('.mp4')) {
      if (bytes > MAX_VIDEO_BYTES)
        problems.push({ path, problem: `video is ${mb(bytes)}, over 25 MB` });
    } else if (path.endsWith('.png')) {
      if (bytes >= MAX_IMAGE_BYTES)
        problems.push({ path, problem: `image is ${mb(bytes)}, 10 MB or over` });
      if (!head(path).equals(PNG_SIGNATURE)) problems.push({ path, problem: 'not a PNG file' });
    } else {
      problems.push({ path, problem: 'only .mp4 videos and .png images are attached' });
    }
  }
  return problems;
}

function pngHead(path: string): Buffer {
  return readFileSync(path).subarray(0, 8);
}

const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
