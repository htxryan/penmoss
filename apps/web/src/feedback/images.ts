/**
 * Send feedback's screenshots on the web and in the Mac app (T49): up to 6 PNG, JPEG, WebP or
 * GIF images, 10 MB each as chosen, scaled down to 2560 px on the long side and encoded again
 * before upload (PNG stays PNG, the rest become JPEG at 0.85).
 */
import { FEEDBACK_IMAGE_TYPES, FEEDBACK_LIMITS } from '@penmoss/core/feedback';

export interface Screenshot {
  /** Stable within the form (keys, reordering). */
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly blob: Blob;
  /** Ticked: it is sent. A capture of the window is offered unticked. */
  readonly included: boolean;
  /** Taken by the app: the Mac's capture of the window behind the form, or the web's of the tab. */
  readonly source?: 'window' | 'tab';
}

export class ScreenshotRefused extends Error {}

/** Whether a picked, pasted or dropped file may be a screenshot, and why not. */
export function checkImage(file: { readonly type: string; readonly size: number }): string | null {
  if (!FEEDBACK_IMAGE_TYPES[file.type]) return 'Screenshots must be PNG, JPEG, WebP or GIF images.';
  if (file.size > FEEDBACK_LIMITS.screenshotBytes) return 'Each screenshot must be 10 MB or less.';
  if (file.size === 0) return 'That image is empty.';
  return null;
}

/** The size an image is drawn at: at most `max` pixels on its long side, never larger. */
export function fitWithin(
  width: number,
  height: number,
  max: number = FEEDBACK_LIMITS.longSide,
): { width: number; height: number } {
  const long = Math.max(width, height);
  if (long <= max) return { width, height };
  const scale = max / long;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/** What an image is encoded as before upload: PNG stays PNG, anything else becomes JPEG. */
export function outputType(type: string): 'image/png' | 'image/jpeg' {
  return type === 'image/png' ? 'image/png' : 'image/jpeg';
}

/** `screenshot.png` for a type. */
export function nameFor(type: string, index: number): string {
  return `screenshot-${index + 1}.${FEEDBACK_IMAGE_TYPES[type] ?? 'png'}`;
}

/** Lays every see-through pixel on white, in place (what a white canvas under it would give). */
export function flattenOnWhite(data: Uint8ClampedArray): void {
  for (let i = 0; i < data.length; i += 4) {
    const alpha = data[i + 3]! / 255;
    if (alpha === 1) continue;
    for (let c = 0; c < 3; c++) data[i + c] = data[i + c]! * alpha + 255 * (1 - alpha);
    data[i + 3] = 255;
  }
}

function onWhite(context: CanvasRenderingContext2D, width: number, height: number): void {
  const image = context.getImageData(0, 0, width, height);
  flattenOnWhite(image.data);
  context.putImageData(image, 0, 0);
}

/**
 * The image scaled down and encoded again, ready to send. Without a canvas (tests, an old
 * browser) the image goes as it was chosen.
 */
export async function prepareImage(blob: Blob): Promise<Blob> {
  const type = outputType(blob.type);
  if (typeof createImageBitmap !== 'function' || typeof document === 'undefined') return blob;
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(blob);
  } catch {
    throw new ScreenshotRefused('That image could not be read.');
  }
  try {
    const size = fitWithin(bitmap.width, bitmap.height);
    const canvas = document.createElement('canvas');
    canvas.width = size.width;
    canvas.height = size.height;
    const context = canvas.getContext('2d');
    if (!context) return blob;
    context.drawImage(bitmap, 0, 0, size.width, size.height);
    // JPEG has no transparency: a see-through pixel of a WebP or GIF is laid on white, not black.
    if (type === 'image/jpeg' && blob.type !== 'image/jpeg')
      onWhite(context, size.width, size.height);
    const encoded = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, type, type === 'image/jpeg' ? FEEDBACK_LIMITS.jpegQuality : undefined),
    );
    return encoded ?? blob;
  } finally {
    bitmap.close();
  }
}

/**
 * One frame of this tab, for Capture this window on the web: the browser asks first
 * (`getDisplayMedia` with `preferCurrentTab`), and the stream stops after the frame.
 * `hide` runs while the frame is taken, so the form is not in it.
 */
export async function captureThisTab(hide: (hidden: boolean) => void): Promise<Blob | null> {
  const media = navigator.mediaDevices as MediaDevices | undefined;
  if (!media?.getDisplayMedia) return null;
  const stream = await media.getDisplayMedia({
    video: true,
    audio: false,
    preferCurrentTab: true,
    selfBrowserSurface: 'include',
  } as DisplayMediaStreamOptions);
  try {
    const video = document.createElement('video');
    video.muted = true;
    video.srcObject = stream;
    await video.play();
    hide(true);
    // Two frames for the page to paint without the form.
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    await new Promise((resolve) => setTimeout(resolve, 150));
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d')?.drawImage(video, 0, 0);
    return await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  } finally {
    hide(false);
    for (const track of stream.getTracks()) track.stop();
  }
}
