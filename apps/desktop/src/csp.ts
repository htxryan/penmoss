/**
 * The Content Security Policy of the Mac app's pages (T29, T59): only the bundle's own scripts,
 * and no connection beyond the app's own origin. Git notebooks sync through the main process
 * (A853), and Send feedback is filed from there too (A1010), so a page has no server to reach and
 * an injected script has nowhere to send a note.
 *
 * Lazily loaded editor chunks (highlight.js grammars, KaTeX, Mermaid) and KaTeX's fonts are files
 * on the app's own origin ('self'). KaTeX and Mermaid style their output with style attributes and
 * <style> elements (`style-src 'unsafe-inline'`); neither needs `unsafe-eval`. `img-src https:`
 * shows pictures a note links to on the web. `frame-src blob:` previews an attached PDF in an
 * object URL the app made (A64), and `connect-src blob:` lets a paste read this origin's blob:
 * pictures as they are (A52).
 */
export function contentSecurityPolicy(): string {
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    "connect-src 'self' blob:",
    "worker-src 'self'",
    "frame-src 'self' blob:",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'",
  ].join('; ');
}
