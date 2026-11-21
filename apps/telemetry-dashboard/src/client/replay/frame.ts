/**
 * The replay's frame page (PEN-178), player.html in an iframe on a session's page: it draws each
 * Frame the page posts, and nothing else. A message counts only from the page's own origin and
 * from the window that holds the frame; the frame fetches nothing. FRAME_DATA (the app's icons
 * and the note rail's tabs) is made at build time by frame-data.ts.
 */
import type { FrameData } from './frame-data';
import { drawFrame, type FrameMessage } from './frame-draw';

declare const FRAME_DATA: FrameData;

window.addEventListener('message', (event: MessageEvent<FrameMessage>) => {
  if (event.origin !== location.origin || event.source !== window.parent) return;
  if (event.data?.type !== 'frame') return;
  drawFrame(document, event.data, FRAME_DATA);
});

// Loaded: the page sends the first frame only after this.
window.parent.postMessage({ type: 'ready' }, location.origin);
