/**
 * The page's Content Security Policy (T59, A1038), for `vite preview` of a production build:
 * the e2e suite runs the build under it. The Mac app serves the same files with its own policy
 * (apps/desktop/src/csp.ts). There is no API host any more (D49): git runs in the Mac app's main
 * process and the page reaches it over IPC, so `connect-src` is this origin and the page's own
 * blob: pictures only.
 *
 * Lazily loaded editor chunks (highlight.js grammars, KaTeX, Mermaid) and KaTeX's fonts are
 * files on this origin ('self'). KaTeX and Mermaid style their output with style attributes and
 * <style> elements, which `style-src 'unsafe-inline'` allows; neither needs `unsafe-eval` (T12,
 * checked by test/e2e/blocks.spec.ts).
 *
 * `frame-src` adds `blob:` to 'self' for one use: previewing an attached PDF (T13, A64) in the
 * browser's viewer, from an object URL the app made itself. A blob URL can only be minted by
 * script already running here, so this lets no new origin or content in.
 */
export function contentSecurityPolicy(): string {
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    // A note's pictures: its own (blob:, data:) and those it links on the web.
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    // blob: lets a paste read this origin's blob: pictures as they are (T15, A52).
    "connect-src 'self' blob:",
    "worker-src 'self'",
    // Attached PDFs preview in an iframe of an object URL the app made (T13; see above).
    "frame-src 'self' blob:",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'",
  ].join('; ');
}
