/**
 * The plan contract (F16, #267): what the plan page must be before the factory builds from it.
 * It must be self-contained (no external requests), have a nav, at least one rendered diagram,
 * and testable acceptance criteria in EARS form. Checked on the saved copy at agreement; any
 * miss goes back to the planning session, not to Ryan.
 */

/** URLs the page would fetch: scripts, styles, images, frames, fonts, imports. */
const EXTERNAL = [
  /<script\b[^>]*\bsrc\s*=\s*["']?(?:https?:)?\/\//i,
  /<link\b[^>]*\bhref\s*=\s*["']?(?:https?:)?\/\//i,
  /<(?:img|iframe|video|audio|source|embed|object)\b[^>]*\b(?:src|data|srcset)\s*=\s*["']?(?:https?:)?\/\//i,
  /@import\s+(?:url\()?\s*["']?(?:https?:)?\/\//i,
  /url\(\s*["']?(?:https?:)?\/\//i,
  /\bfetch\s*\(|XMLHttpRequest|new\s+WebSocket|EventSource\s*\(/,
];

/** An EARS requirement: "The <system> shall", or When/While/If/Where … shall. */
const EARS = /\b(?:the|when|while|if|where)\b[^.<]{0,300}?\bshall\b/i;

export function checkPlanContract(html: string): string[] {
  const problems: string[] = [];
  if (EXTERNAL.some((r) => r.test(html)))
    problems.push(
      'it loads something from the network: inline every script, style, font and image',
    );
  if (!/<nav\b/i.test(html)) problems.push('it has no <nav>');
  // Rendered: an inline <svg> (or an image already in the page), not Mermaid source left to render.
  if (
    !/<svg\b[\s\S]*?<\/svg>/i.test(html) &&
    !/<img\b[^>]*\bsrc\s*=\s*["']?data:image\//i.test(html)
  )
    problems.push('it has no rendered diagram (an inline <svg>)');
  const criteria =
    /<h[1-6]\b[^>]*>[^<]*acceptance criteria[^<]*<\/h[1-6]>([\s\S]*?)(?=<h[1-6]\b[^>]*>|$)/i.exec(
      html,
    );
  if (!criteria) problems.push('it has no "Acceptance criteria" section');
  else if (!EARS.test(criteria[1]!.replaceAll(/<[^>]+>/g, ' ')))
    problems.push(
      'its acceptance criteria are not testable EARS statements ("When …, the … shall …")',
    );
  return problems;
}
