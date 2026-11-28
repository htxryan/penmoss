/**
 * The relay's icon, the Penmoss logo: its favicon and its pages' icon, and `serverInfo.icons`,
 * which claude.ai shows beside the connector. Without them claude.ai draws a letter (PEN-195's
 * trial). The images are in `icon.gen.ts` (scripts/icon.mjs).
 */
import { ICON_PNG_BASE64, ICON_PNG_SIZE, ICON_SVG } from './icon.gen';

const png = () => Uint8Array.from(atob(ICON_PNG_BASE64), (char) => char.charCodeAt(0));

/** The icons `initialize` names, as data URIs: they need no address of the relay's. */
export const SERVER_ICONS = [
  {
    src: `data:image/svg+xml;base64,${btoa(ICON_SVG)}`,
    mimeType: 'image/svg+xml',
    sizes: ['any'],
  },
  {
    src: `data:image/png;base64,${ICON_PNG_BASE64}`,
    mimeType: 'image/png',
    sizes: [`${ICON_PNG_SIZE}x${ICON_PNG_SIZE}`],
  },
] as const;

/** Every page's `<head>` names the icon. */
export const ICON_LINKS =
  '<link rel="icon" href="/favicon.svg" type="image/svg+xml">' +
  '<link rel="icon" href="/favicon.png" type="image/png">' +
  '<link rel="apple-touch-icon" href="/apple-touch-icon.png">';

/** The icon's addresses: the SVG, and the PNG where a browser or a crawler looks by name. */
export function iconResponse(pathname: string): Response | null {
  const headers = { 'cache-control': 'public, max-age=86400' };
  if (pathname === '/favicon.svg') {
    return new Response(ICON_SVG, { headers: { ...headers, 'content-type': 'image/svg+xml' } });
  }
  if (['/favicon.ico', '/favicon.png', '/apple-touch-icon.png', '/icon.png'].includes(pathname)) {
    return new Response(png(), { headers: { ...headers, 'content-type': 'image/png' } });
  }
  return null;
}
