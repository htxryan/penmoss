/**
 * The relay's own pages (PEN-193, R12): Setup, Sign In and Notebooks, in the app's look. Its
 * stylesheets are the app's (`app-css.gen.ts`), its colours the Penmoss theme's, light or dark as
 * the browser asks, and its words follow the app's conventions (Title Case for titles, buttons and
 * row labels). Every page forbids scripts, frames and forms posting anywhere unnamed.
 */
import { PENMOSS } from '@penmoss/ui/theme/builtins';
import { themeVariables } from '@penmoss/ui/theme/css';
import { APP_CSS } from './app-css.gen';
import { relayVersion, UPDATE_DOCS } from './version';

export const escape = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );

/** The Penmoss theme's variables, as the app sets them on `<html>`. */
const vars = (variant: 'light' | 'dark') =>
  Object.entries(themeVariables(PENMOSS, variant))
    .map(([name, value]) => `${name}:${value}`)
    .join(';');

/** The theme's colours, and the few rules a page of its own needs, from the app's tokens. */
const PAGE_CSS = `:root{${vars('light')};color-scheme:light}
@media (prefers-color-scheme: dark){:root{${vars('dark')};color-scheme:dark}}
.relay{box-sizing:border-box;max-width:44rem;margin:0 auto;padding:2.5rem 16px 4rem;display:grid;gap:1rem}
.relay-head{display:flex;flex-wrap:wrap;align-items:baseline;justify-content:space-between;gap:.5rem 1rem}
.relay-head h1{margin:0}
.relay p{margin:0}
.relay form{margin:0}
.relay .lf-group{display:block}
.relay-steps{counter-reset:step}
.relay-steps>li{counter-increment:step}
.relay-steps .lf-row-label{display:block}
.relay-steps .lf-row-label::before{content:counter(step) ". ";color:var(--pm-muted)}
.relay-done{color:var(--pm-success);font-size:var(--pm-text-help);font-weight:var(--pm-weight-semibold)}
.relay-who{color:var(--pm-muted);font-size:var(--pm-text-help)}
.relay-who form{display:inline}
.relay-link{border:0;padding:0;background:none;color:var(--pm-link);font:inherit;cursor:pointer;text-decoration:underline}
.relay code{font-family:var(--pm-mono);font-size:var(--pm-text-code);background:var(--pm-code-bg);padding:0 .25em;overflow-wrap:anywhere}
.relay-state{display:flex;align-items:flex-start;gap:.35rem;color:var(--pm-muted);font-size:var(--pm-text-help);line-height:var(--pm-leading-help)}
.relay-state::before{content:"";flex:none;width:7px;height:7px;margin-top:.45em;background:var(--pm-success)}
.relay-state.bad{color:var(--pm-danger)}
.relay-state.bad::before{background:var(--pm-danger)}
.relay-form{display:grid;gap:1rem}
.relay-form .lf-row-control{flex:1 1 16rem}
.relay-actions{display:flex;flex-wrap:wrap;gap:.5rem}
.relay-choices{display:flex;flex-wrap:wrap;gap:.75rem;font-size:var(--pm-text-row-label)}
.relay-choice{display:inline-flex;align-items:center;gap:.35rem;cursor:pointer}
.relay-foot{color:var(--pm-muted);font-size:var(--pm-text-help);padding-top:1rem}
.relay-problem{border:1px solid var(--pm-border);border-left:3px solid var(--pm-danger);background:var(--pm-raised);padding:.75rem 1rem;display:grid;gap:.35rem}`;

export interface PageOptions {
  /** Origins a form on the page may post to, besides the relay itself. */
  readonly formAction?: readonly string[];
  readonly headers?: Record<string, string>;
  /** Beside the title: who is signed in, or whose relay this is. */
  readonly aside?: string;
  /** The hash of the page's one inline script, which its policy allows. */
  readonly scriptHash?: string;
}

/** Every page's last line: which relay this is, and how to bring it up to date. */
const FOOT = `<p class="relay-foot">Penmoss Relay ${escape(relayVersion)} · <a href="${UPDATE_DOCS}">How to Update</a></p>`;

/** A page: `body` is HTML whose text the caller has escaped. */
export function page(status: number, title: string, body: string, options: PageOptions = {}) {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="referrer" content="no-referrer"><title>${escape(title)}</title>
<style>${APP_CSS}
${PAGE_CSS}</style>
</head><body><main class="relay"><div class="relay-head"><h1 class="t-page-title">${escape(title)}</h1>${options.aside ? `<span class="relay-who">${options.aside}</span>` : ''}</div>${body}${FOOT}</main></body></html>`;
  const formAction = ["'self'", ...(options.formAction ?? [])].join(' ');
  return new Response(html, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy': `default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:;${options.scriptHash ? ` script-src ${options.scriptHash};` : ''} form-action ${formAction}; frame-ancestors 'none'; base-uri 'none'`,
      'x-frame-options': 'DENY',
      'cache-control': 'no-store',
      ...options.headers,
    },
  });
}

/** A paragraph of running text. */
export const para = (html: string) => `<p class="t-body">${html}</p>`;

/** A Settings Group row: its label, its help, and its control. */
export function row(label: string, help: string, control = '', tag = 'div', extra = '') {
  return `<${tag} class="lf-row"><div class="lf-row-text"><span class="lf-row-label">${escape(label)}</span>${help ? `<span class="lf-row-help">${help}</span>` : ''}${extra}</div>${control ? `<div class="lf-row-control">${control}</div>` : ''}</${tag}>`;
}

/** A Settings Group: rows in a bordered list, numbered when they are steps. */
export const group = (rows: readonly string[], steps = false) =>
  steps
    ? `<ol class="lf-group relay-steps">${rows.join('')}</ol>`
    : `<div class="lf-group">${rows.join('')}</div>`;

/** A link drawn as a button. */
export const linkButton = (href: string, label: string, primary = false) =>
  `<a class="btn${primary ? ' primary' : ''}" href="${escape(href)}">${escape(label)}</a>`;

/** A form that is one button (POST), with the page's form token when it has one. */
export function buttonForm(
  action: string,
  label: string,
  fields: Record<string, string>,
  options: { readonly primary?: boolean; readonly className?: string } = {},
) {
  const inputs = Object.entries(fields)
    .map(([name, value]) => `<input type="hidden" name="${escape(name)}" value="${escape(value)}">`)
    .join('');
  const style = options.className ?? `btn${options.primary ? ' primary' : ''}`;
  return `<form method="post" action="${escape(action)}">${inputs}<button type="submit" class="${style}">${escape(label)}</button></form>`;
}

/** A problem the page explains in a sentence or two. */
export const problem = (title: string, html: string) =>
  `<div class="relay-problem" role="alert"><b>${escape(title)}</b><p class="t-body">${html}</p></div>`;
