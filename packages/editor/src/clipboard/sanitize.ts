/**
 * Pasted HTML, rewritten into the editor's own small dialect (T15).
 *
 * The input is parsed into an inert document (no scripts run, no images
 * load) and walked once; the output is built from scratch with an allow-list
 * of elements and attributes, so nothing the source wrote survives unless a
 * rule below copies it: no `style`, no event handlers, no scripts, frames or
 * forms, and only checked link and image addresses. Presentation becomes
 * structure on the way: Google Docs' and Word's bold, italic, strikethrough
 * and monospace spans become marks, Word's paragraph lists become lists,
 * checkbox lists become task lists, and the first row of a table becomes its
 * header (GFM). ProseMirror's parse rules then read the result.
 */
import { resolveLanguage } from '../extensions/highlight';

export interface SanitizeOptions {
  /**
   * What to do with `data:` and `blob:` pictures: `drop` them (keeping their
   * alt text), or `keep` them so the caller can store them (T10) and replace
   * their sources before inserting. Defaults to `drop`.
   */
  readonly localImages?: 'keep' | 'drop';
  /**
   * This install's clipboard token (token.ts). HTML is Penmoss's own only when
   * its marker carries this value; without it nothing is.
   */
  readonly trustedMarker?: string | undefined;
}

export interface SanitizedHTML {
  readonly html: string;
  /** The `data:` and `blob:` sources kept in `html` (with `localImages: 'keep'`), once each. */
  readonly localImages: readonly string[];
  /**
   * Whether the HTML carries this install's clipboard marker (copied from a
   * note). It only keeps a copy between notes exact (a code block's language as
   * written, empty paragraphs, header cells): no rule that keeps out scripts,
   * styles, unsafe addresses or remote pictures depends on it.
   */
  readonly fromPenmoss: boolean;
}

/** The attribute Penmoss adds next to ProseMirror's `data-pm-slice` when it copies (its value: token.ts). */
export const PENMOSS_MARKER = 'data-penmoss';

/** At most this many `<style>` rules are read (each is checked against every element). */
const MAX_STYLE_RULES = 500;

const DROP = new Set([
  'script',
  'style',
  'noscript',
  'template',
  'iframe',
  'frame',
  'frameset',
  'object',
  'embed',
  'applet',
  'canvas',
  'svg',
  'video',
  'audio',
  'source',
  'track',
  'map',
  'area',
  'button',
  'select',
  'option',
  'optgroup',
  'textarea',
  'input',
  'meta',
  'link',
  'title',
  'head',
  'base',
  'colgroup',
  'col',
  'dialog',
  'datalist',
  'progress',
  'meter',
  'output',
  'portal',
  'slot',
]);

/** Elements that only group blocks: kept as a plain `div` so their contents stay separate blocks. */
const CONTAINERS = new Set([
  'div',
  'section',
  'article',
  'main',
  'header',
  'footer',
  'nav',
  'aside',
  'figure',
  'figcaption',
  'address',
  'center',
  'details',
  'summary',
  'dl',
  'dt',
  'dd',
  'fieldset',
  'legend',
  'hgroup',
  'search',
  'form',
  'caption',
]);

const HEADINGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
/** Block elements the output keeps by name. */
const BLOCKS = new Set([...HEADINGS, 'p', 'blockquote', 'ul', 'ol', 'li', 'hr', 'table', 'pre']);
/** Every element the output treats as a block (for stray `<br>` and emptiness checks). */
const BLOCKISH = new Set([...BLOCKS, ...CONTAINERS, 'div', 'tr', 'td', 'th', 'tbody', 'thead']);

const MONOSPACE =
  /monospace|courier|consolas|menlo|monaco|source code|fira code|fira mono|jetbrains mono|sf ?mono|roboto mono|ubuntu mono|lucida console|andale mono|dejavu sans mono|cascadia|ibm plex mono|inconsolata/i;
const RASTER_DATA_URL = /^data:image\/(png|jpe?g|gif|webp|avif);base64,[a-z0-9+/=\s]+$/i;
const ATTACHMENT_PATH = /^(?:\.\.\/)*attachments\/[0-9a-f]{64}\.[a-z0-9]{1,8}$/i;
const LANGUAGE_NAME = /^[\w+#.-]{1,32}$/;
const CALLOUT_TYPE = /^[\w-]{1,32}$/;

type Marks = { bold: boolean; italic: boolean; strike: boolean; code: boolean };
type Style = Map<string, string>;

interface Context {
  readonly out: Document;
  readonly options: { readonly localImages: 'keep' | 'drop' };
  readonly fromPenmoss: boolean;
  /** The marker value to carry through, when trusted (so a second pass trusts it too). */
  readonly marker: string | null;
  readonly rules: readonly StyleRule[];
  readonly localImages: string[];
}

interface Scope {
  readonly marks: Marks;
  readonly inLink: boolean;
}

const NO_MARKS: Marks = { bold: false, italic: false, strike: false, code: false };

/** Rewrites pasted HTML into clean blocks (see the module comment). */
export function sanitizeClipboardHTML(
  html: string,
  parser: DOMParser,
  options: SanitizeOptions = {},
): SanitizedHTML {
  const source = parser.parseFromString(html, 'text/html');
  const out = parser.parseFromString('<!doctype html><body></body>', 'text/html');
  const trusted = options.trustedMarker ?? '';
  const fromPenmoss =
    trusted.length >= 16 &&
    [...source.querySelectorAll(`[data-pm-slice][${PENMOSS_MARKER}]`)].some(
      (element) => element.getAttribute(PENMOSS_MARKER) === trusted,
    );
  const ctx: Context = {
    out,
    options: { localImages: options.localImages ?? 'drop' },
    fromPenmoss,
    marker: fromPenmoss ? trusted : null,
    rules: styleRules(source),
    localImages: [],
  };
  const body = out.body;
  cleanChildren(source.body, body, ctx, { marks: NO_MARKS, inLink: false });
  tidyBlocks(body, ctx);
  return { html: body.innerHTML, localImages: ctx.localImages, fromPenmoss };
}

// ---------------------------------------------------------------------------
// Styles: inline `style` plus simple `tag.class` rules from <style> elements
// (Apple's Cocoa HTML writer and Word put formatting in class rules).

interface StyleRule {
  readonly tag: string | null;
  readonly className: string | null;
  readonly style: Style;
}

function parseDeclarations(text: string): Style {
  const style: Style = new Map();
  for (const part of text.split(';')) {
    const colon = part.indexOf(':');
    if (colon < 0) continue;
    const name = part.slice(0, colon).trim().toLowerCase();
    const value = part
      .slice(colon + 1)
      .trim()
      .toLowerCase();
    if (name && value) style.set(name, value.replace(/\s*!important$/, ''));
  }
  return style;
}

/** CSS without its comments (and the `<!--` `-->` Word wraps it in), in one pass. */
function withoutComments(css: string): string {
  let out = '';
  let at = 0;
  while (at < css.length) {
    const open = css.indexOf('/*', at);
    if (open < 0) {
      out += css.slice(at);
      break;
    }
    out += css.slice(at, open);
    const close = css.indexOf('*/', open + 2);
    if (close < 0) break; // An unclosed comment runs to the end.
    at = close + 2;
  }
  return out.replaceAll('<!--', '').replaceAll('-->', '');
}

/**
 * Simple `tag`, `.class` and `tag.class` rules, read in one pass over the
 * text (a rule nested in `@media` counts; the at-rule itself does not).
 */
function styleRules(source: Document): StyleRule[] {
  const rules: StyleRule[] = [];
  for (const element of source.querySelectorAll('style')) {
    const css = withoutComments(element.textContent ?? '');
    let start = 0;
    let selector: string | null = null;
    for (let at = 0; at < css.length && rules.length < MAX_STYLE_RULES; at++) {
      const char = css[at];
      if (char === '{') {
        selector = css.slice(start, at);
        start = at + 1;
      } else if (char === '}') {
        if (selector !== null) addRules(rules, selector, css.slice(start, at));
        selector = null;
        start = at + 1;
      }
    }
  }
  return rules.slice(0, MAX_STYLE_RULES);
}

function addRules(rules: StyleRule[], selectors: string, declarations: string): void {
  const style = parseDeclarations(declarations);
  if (style.size === 0) return;
  for (const selector of selectors.split(',')) {
    if (rules.length >= MAX_STYLE_RULES) return;
    const simple = /^([a-z][a-z0-9]*)?(?:\.([\w-]+))?$/i.exec(selector.trim());
    if (!simple || (!simple[1] && !simple[2])) continue;
    rules.push({ tag: simple[1]?.toLowerCase() ?? null, className: simple[2] ?? null, style });
  }
}

function styleOf(element: Element, ctx: Context): Style {
  const style: Style = new Map();
  if (ctx.rules.length > 0) {
    const tag = element.localName;
    for (const rule of ctx.rules) {
      if (rule.tag && rule.tag !== tag) continue;
      if (rule.className && !element.classList.contains(rule.className)) continue;
      for (const [name, value] of rule.style) style.set(name, value);
    }
  }
  const inline = element.getAttribute('style');
  if (inline) for (const [name, value] of parseDeclarations(inline)) style.set(name, value);
  return style;
}

function isHidden(element: Element, style: Style): boolean {
  if (element.hasAttribute('hidden') || element.getAttribute('aria-hidden') === 'true') return true;
  return style.get('display') === 'none' || style.get('visibility') === 'hidden';
}

/** Bold, italic, strike and code as the element's tag and styles set them (undefined: unchanged). */
function markChanges(element: Element, style: Style): Partial<Marks> {
  const tag = element.localName;
  const changes: Partial<Marks> = {};
  if (tag === 'b' || tag === 'strong') changes.bold = true;
  if (tag === 'i' || tag === 'em') changes.italic = true;
  if (tag === 's' || tag === 'strike' || tag === 'del') changes.strike = true;
  if (tag === 'code' || tag === 'kbd' || tag === 'samp' || tag === 'tt') changes.code = true;
  const font = style.get('font') ?? '';
  const weight = style.get('font-weight') ?? (/\bbold\b/.test(font) ? 'bold' : undefined);
  if (weight !== undefined) {
    const numeric = Number.parseInt(weight, 10);
    if (weight === 'bold' || weight === 'bolder' || numeric >= 600) changes.bold = true;
    else if (weight === 'normal' || weight === 'lighter' || numeric > 0) changes.bold = false;
  }
  const fontStyle = style.get('font-style') ?? (/\bitalic\b/.test(font) ? 'italic' : undefined);
  if (fontStyle !== undefined) changes.italic = fontStyle === 'italic' || fontStyle === 'oblique';
  const decoration = `${style.get('text-decoration') ?? ''} ${style.get('text-decoration-line') ?? ''}`;
  if (decoration.includes('line-through')) changes.strike = true;
  const family = style.get('font-family') ?? font;
  if (family && MONOSPACE.test(family)) changes.code = true;
  return changes;
}

// ---------------------------------------------------------------------------
// The walk.

function cleanChildren(from: Node, to: Element, ctx: Context, scope: Scope): void {
  let node: Node | null = from.firstChild;
  while (node) {
    // Word wraps list bullets in `<![if !supportLists]>` … `<![endif]>`, which an HTML
    // parser reads as two comments around the bullet: skip what lies between them.
    if (node.nodeType === 8 && /^\[if\b/i.test((node as Comment).data.trim())) {
      while (node && !(node.nodeType === 8 && /^\[endif\]/i.test((node as Comment).data.trim()))) {
        node = node.nextSibling;
      }
      node = node?.nextSibling ?? null;
      continue;
    }
    if (node.nodeType === 1 && wordListLevel(node as Element)) {
      node = wordList(node as Element, to, ctx, scope);
      continue;
    }
    cleanNode(node, to, ctx, scope);
    node = node.nextSibling;
  }
}

function cleanNode(node: Node, to: Element, ctx: Context, scope: Scope): void {
  if (node.nodeType === 3) {
    const text = ctx.fromPenmoss
      ? (node.nodeValue ?? '')
      : (node.nodeValue ?? '').replace(/\u00a0/g, ' ');
    if (text) to.append(ctx.out.createTextNode(text));
    return;
  }
  if (node.nodeType !== 1) return;
  const element = node as Element;
  const tag = element.localName;
  if (DROP.has(tag)) return;
  if (isMath(element)) {
    math(element, to, ctx);
    return;
  }
  const style = styleOf(element, ctx);
  if (isHidden(element, style)) return;
  if (tag === 'br') {
    to.append(ctx.out.createElement('br'));
    return;
  }
  if (tag === 'img') {
    image(element, to, ctx, scope);
    return;
  }
  if (tag === 'pre' || isPreLike(element, style)) {
    codeBlock(element, to, ctx);
    return;
  }
  if (tag === 'table') {
    table(element, to, ctx, scope);
    return;
  }
  if (tag === 'ul' || tag === 'ol') {
    list(element, to, ctx, scope);
    return;
  }
  if (tag === 'hr') {
    to.append(ctx.out.createElement('hr'));
    return;
  }
  if (element.hasAttribute('data-callout-heading')) return;
  if (isCallout(element)) {
    callout(element, to, ctx, scope);
    return;
  }
  if (tag === 'a') {
    if (element.hasAttribute('data-wikilink') && reference(element, 'a', to, ctx)) return;
    if (element.hasAttribute('data-attachment') && attachment(element, to, ctx)) return;
    link(element, to, ctx, scope);
    return;
  }
  if (tag === 'div' && element.hasAttribute('data-embed') && reference(element, 'div', to, ctx)) {
    return;
  }

  const changes = markChanges(element, style);
  let target: Element = to;
  if (BLOCKS.has(tag) || CONTAINERS.has(tag) || tag === 'li') {
    const name = BLOCKS.has(tag) ? tag : tag === 'li' ? 'li' : 'div';
    const block = ctx.out.createElement(name);
    copySlice(element, block, ctx);
    to.append(block);
    target = block;
    // A heading is bold already; its spans' weights are presentation.
    if (HEADINGS.has(tag)) delete changes.bold;
  } else if (tag === 'mark') {
    const mark = ctx.out.createElement('mark');
    to.append(mark);
    target = mark;
  }
  const wrapped = wrapMarks(target, changes, scope, ctx);
  cleanChildren(element, wrapped.target, ctx, wrapped.scope);
}

/** Wraps output in `<strong>`, `<em>`, `<s>` or `<code>` for marks the element turns on. */
function wrapMarks(
  target: Element,
  changes: Partial<Marks>,
  scope: Scope,
  ctx: Context,
): { target: Element; scope: Scope } {
  const marks = { ...scope.marks };
  let current = target;
  const add = (name: keyof Marks, tag: string) => {
    if (changes[name] === true && !marks[name]) {
      const wrapper = ctx.out.createElement(tag);
      current.append(wrapper);
      current = wrapper;
      marks[name] = true;
    }
  };
  add('bold', 'strong');
  add('italic', 'em');
  add('strike', 's');
  add('code', 'code');
  return { target: current, scope: { ...scope, marks } };
}

/**
 * Keeps ProseMirror's slice marker (and Penmoss's, when trusted) on the
 * element that carried it, if its context is valid (see `sliceContext`).
 */
function copySlice(from: Element, to: Element, ctx: Context): void {
  const slice = sliceMarker(from.getAttribute('data-pm-slice'));
  if (!slice) return;
  to.setAttribute('data-pm-slice', slice);
  if (ctx.marker && from.getAttribute(PENMOSS_MARKER) === ctx.marker) {
    to.setAttribute(PENMOSS_MARKER, ctx.marker);
  }
}

type AttrCheck = (value: unknown) => boolean;
const isBoolean: AttrCheck = (value) => typeof value === 'boolean';
const whole =
  (min: number, max: number): AttrCheck =>
  (value) =>
    typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
const CELL: Record<string, AttrCheck> = {
  colspan: whole(1, 50),
  rowspan: whole(1, 50),
  colwidth: (value) =>
    value === null || (Array.isArray(value) && value.length <= 50 && value.every(whole(0, 10_000))),
  align: (value) => value === null || value === 'left' || value === 'center' || value === 'right',
};

/**
 * The nodes ProseMirror may wrap pasted content in from a slice marker's
 * context, with the attributes each may set: containers only, never a text
 * block or a leaf (an image's address, a code block's language).
 */
const SLICE_WRAPPERS: Record<string, Record<string, AttrCheck>> = {
  blockquote: {},
  callout: {
    type: (value) => typeof value === 'string' && CALLOUT_TYPE.test(value),
    title: (value) => typeof value === 'string' && value.length <= 500,
    foldable: isBoolean,
    collapsed: isBoolean,
  },
  bulletList: { tight: isBoolean },
  orderedList: { start: whole(0, 999_999_999), tight: isBoolean },
  taskList: { tight: isBoolean },
  listItem: {},
  taskItem: { checked: isBoolean },
  table: {},
  tableRow: {},
  tableHeader: CELL,
  tableCell: CELL,
};

/**
 * A `data-pm-slice` value (`openStart openEnd [-wrappers] context`), rebuilt
 * from its parts with only allowed wrappers and attributes, or null when it
 * is malformed or names any other node. Any page can write one.
 */
function sliceMarker(raw: string | null): string | null {
  const match = /^(\d{1,2}) (\d{1,2})( -\d{1,2})? (\[.*\])$/s.exec(raw ?? '');
  if (!match) return null;
  let context: unknown;
  try {
    context = JSON.parse(match[4]!);
  } catch {
    return null;
  }
  if (!Array.isArray(context) || context.length % 2 !== 0 || context.length > 40) return null;
  const clean: unknown[] = [];
  for (let i = 0; i < context.length; i += 2) {
    const name: unknown = context[i];
    const attrs: unknown = context[i + 1];
    const allowed =
      typeof name === 'string' && Object.hasOwn(SLICE_WRAPPERS, name) ? SLICE_WRAPPERS[name] : null;
    if (!allowed) return null;
    if (attrs === null || attrs === undefined) {
      clean.push(name, null);
      continue;
    }
    if (typeof attrs !== 'object' || Array.isArray(attrs)) return null;
    const kept: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(attrs as Record<string, unknown>)) {
      if (Object.hasOwn(allowed, key) && allowed[key]!(value)) kept[key] = value;
    }
    clean.push(name, kept);
  }
  return `${match[1]} ${match[2]}${match[3] ?? ''} ${JSON.stringify(clean)}`;
}

// ---------------------------------------------------------------------------
// Links and images.

/** A link address worth keeping: web, mail, or a Penmoss attachment; anything else is dropped. */
export function safeHref(raw: string | null): string | null {
  const value = (raw ?? '').trim();
  if (!value) return null;
  if (ATTACHMENT_PATH.test(value)) return value;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null; // Relative addresses mean nothing in a note.
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:' && url.protocol !== 'mailto:') {
    return null;
  }
  // Google Docs routes every link through a redirect: keep the destination.
  if (/^(www\.)?google\.com$/.test(url.hostname) && url.pathname === '/url') {
    const target = safeHref(url.searchParams.get('q'));
    if (target) return target;
  }
  // Whitespace inside the address (the URL parser drops tabs and newlines): use the parsed form.
  return /\s/.test(value) ? url.href : value;
}

function link(element: Element, to: Element, ctx: Context, scope: Scope): void {
  const rawHref = element.getAttribute('href') ?? '';
  const href = scope.inLink ? null : safeHref(rawHref);
  if (rawHref.startsWith('#') && /^[#¶§🔗\s]*$/u.test(element.textContent ?? '')) return;
  const changes = markChanges(element, styleOf(element, ctx));
  if (!href) {
    const wrapped = wrapMarks(to, changes, scope, ctx);
    cleanChildren(element, wrapped.target, ctx, wrapped.scope);
    return;
  }
  const anchor = ctx.out.createElement('a');
  anchor.setAttribute('href', href);
  const title = element.getAttribute('title');
  if (title) anchor.setAttribute('title', title);
  to.append(anchor);
  // Links are blue and underlined everywhere; only bold, italic, strike and code carry over.
  const wrapped = wrapMarks(anchor, changes, { ...scope, inLink: true }, ctx);
  cleanChildren(element, wrapped.target, ctx, wrapped.scope);
}

// ---------------------------------------------------------------------------
// Wikilinks, embeds and attachment chips (T16, T13).
//
// Copied between notes as their own elements (see each node's `renderHTML`), so a
// paste keeps the note they point at. Any page can write these attributes, so each
// value is checked: a note id is a ULID, text is short and on one line, and a file
// is a content-addressed attachment path. They name the user's own notes and
// files; nothing here is fetched by the paste.

const NOTE_ID = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const MAX_REFERENCE_TEXT = 500;

function referenceText(raw: string | null): string | null {
  if (raw === null || raw.length === 0 || raw.length > MAX_REFERENCE_TEXT) return null;
  // eslint-disable-next-line no-control-regex
  return /[\u0000-\u001f\u007f]/.test(raw) ? null : raw;
}

/** A wikilink (`a`) or embed (`div`) with checked attributes; false when its target is unusable. */
function reference(element: Element, tag: 'a' | 'div', to: Element, ctx: Context): boolean {
  const target = referenceText(element.getAttribute('data-target'));
  if (target === null) return false;
  const out = ctx.out.createElement(tag);
  out.setAttribute(tag === 'a' ? 'data-wikilink' : 'data-embed', '');
  const noteId = element.getAttribute('data-note-id');
  if (noteId && NOTE_ID.test(noteId)) out.setAttribute('data-note-id', noteId);
  out.setAttribute('data-target', target);
  const heading = referenceText(element.getAttribute('data-heading'));
  if (heading !== null) out.setAttribute('data-heading', heading);
  const alias = tag === 'a' ? referenceText(element.getAttribute('data-alias')) : null;
  if (alias !== null) out.setAttribute('data-alias', alias);
  // The label as text, for anything that reads the HTML without these rules.
  out.textContent = (element.textContent ?? '').slice(0, MAX_REFERENCE_TEXT);
  to.append(out);
  return true;
}

/** An attachment chip whose path is a stored file; false (a plain link or text) otherwise. */
function attachment(element: Element, to: Element, ctx: Context): boolean {
  const href = element.getAttribute('data-href') ?? element.getAttribute('href') ?? '';
  if (!ATTACHMENT_PATH.test(href)) return false;
  const out = ctx.out.createElement('a');
  out.setAttribute('data-attachment', '');
  out.setAttribute('data-href', href);
  const name = referenceText(element.getAttribute('data-name'));
  if (name !== null) out.setAttribute('data-name', name);
  out.setAttribute('href', href);
  out.textContent = name ?? (element.textContent ?? '').slice(0, MAX_REFERENCE_TEXT);
  to.append(out);
  return true;
}

function dimension(element: Element, name: 'width' | 'height', style: Style): number | null {
  const raw = element.getAttribute(name) ?? style.get(name) ?? '';
  const value = Number.parseFloat(raw);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function image(element: Element, to: Element, ctx: Context, scope: Scope): void {
  // Google Docs draws its checklist boxes as pictures; the list item carries the state.
  if (element.getAttribute('aria-roledescription') === 'checkbox') return;
  const style = styleOf(element, ctx);
  const width = dimension(element, 'width', style);
  const height = dimension(element, 'height', style);
  // Tracking pixels and spacers.
  if ((width !== null && width <= 2) || (height !== null && height <= 2)) return;
  const alt = (element.getAttribute('alt') ?? '').trim();
  const altText = () => {
    if (alt) to.append(ctx.out.createTextNode(alt));
  };
  // Slack, GitHub and others draw emoji as pictures with the character as alt text.
  if (
    element.hasAttribute('data-stringify-emoji') ||
    element.getAttribute('data-stringify-type') === 'emoji' ||
    /\bemoji\b/i.test(element.getAttribute('class') ?? '')
  ) {
    altText();
    return;
  }
  const src = (element.getAttribute('src') ?? '').trim();
  const keep = (value: string) => {
    const img = ctx.out.createElement('img');
    img.setAttribute('src', value);
    if (alt) img.setAttribute('alt', alt);
    const title = element.getAttribute('title');
    if (title) img.setAttribute('title', title);
    const attrWidth = Number.parseInt(element.getAttribute('width') ?? '', 10);
    if (attrWidth > 0) img.setAttribute('width', String(attrWidth));
    const attrHeight = Number.parseInt(element.getAttribute('height') ?? '', 10);
    if (attrHeight > 0) img.setAttribute('height', String(attrHeight));
    to.append(img);
  };
  if (ATTACHMENT_PATH.test(src)) {
    keep(src);
    return;
  }
  if (RASTER_DATA_URL.test(src) || /^blob:/i.test(src)) {
    if (ctx.options.localImages === 'keep' && !scope.inLink) {
      keep(src);
      if (!ctx.localImages.includes(src)) ctx.localImages.push(src);
    } else if (scope.inLink) {
      altText();
    }
    return;
  }
  const href = /^https?:/i.test(src) ? safeHref(src) : null;
  // Pictures the browser cannot reach (Word's file: and Outlook's cid: sources) are left out.
  if (!href) return;
  if (scope.inLink) {
    altText();
    return;
  }
  // Remote pictures are not fetched into notes (they would load from a third party
  // on every open, and the app cannot read them): they become links to the picture,
  // Penmoss's own copies included (A52).
  const anchor = ctx.out.createElement('a');
  anchor.setAttribute('href', href);
  anchor.textContent = alt || 'Image';
  to.append(anchor);
}

// ---------------------------------------------------------------------------
// Code, math and callouts.

function isPreLike(element: Element, style: Style): boolean {
  if (element.localName !== 'div') return false;
  const whiteSpace = style.get('white-space') ?? '';
  const family = style.get('font-family') ?? style.get('font') ?? '';
  return whiteSpace.startsWith('pre') && MONOSPACE.test(family);
}

/** Text of a code block: `<br>` and line `<div>`s become line breaks, nothing else survives. */
function codeText(element: Element): string {
  let text = '';
  const walk = (node: Node) => {
    for (let child = node.firstChild; child; child = child.nextSibling) {
      if (child.nodeType === 3) text += child.nodeValue ?? '';
      else if (child.nodeType === 1) {
        const tag = (child as Element).localName;
        if (DROP.has(tag)) continue;
        if (tag === 'br') {
          text += '\n';
          continue;
        }
        const line = tag === 'div' || tag === 'p' || tag === 'li';
        if (line && text && !text.endsWith('\n')) text += '\n';
        walk(child);
        if (line && !text.endsWith('\n')) text += '\n';
      }
    }
  };
  walk(element);
  return text.replace(/\u00a0/g, ' ').replace(/\n$/, '');
}

/** A code block's language as the picker writes it (`ts` for `TypeScript`), or as given. */
function languageOf(element: Element, ctx: Context): string | null {
  if (ctx.fromPenmoss) {
    // As the note wrote it: a copy between notes changes nothing.
    const name = /(?:^|\s)language-(\S+)/.exec(element.querySelector('code')?.className ?? '')?.[1];
    return name && LANGUAGE_NAME.test(name) ? name : null;
  }
  const named = writtenLanguage(element);
  return named ? (resolveLanguage(named)?.fence ?? named) : null;
}

function writtenLanguage(element: Element): string | null {
  const candidates: Element[] = [element];
  const code = element.querySelector('code');
  if (code) candidates.push(code);
  for (let up = element.parentElement; up && candidates.length < 6; up = up.parentElement) {
    candidates.push(up);
  }
  for (const candidate of candidates) {
    const data = candidate.getAttribute('data-language') ?? candidate.getAttribute('data-lang');
    if (data && LANGUAGE_NAME.test(data)) return data.toLowerCase();
    for (const name of (candidate.getAttribute('class') ?? '').split(/\s+/)) {
      const match = /^(?:language|lang|highlight-source)-([\w+#.-]+)$/i.exec(name);
      if (match && LANGUAGE_NAME.test(match[1]!)) return match[1]!.toLowerCase();
    }
  }
  return null;
}

function codeBlock(element: Element, to: Element, ctx: Context): void {
  const pre = ctx.out.createElement('pre');
  copySlice(element, pre, ctx);
  const code = ctx.out.createElement('code');
  const language = languageOf(element, ctx);
  if (language) code.setAttribute('class', `language-${language}`);
  const meta = element.getAttribute('data-meta');
  if (meta && ctx.fromPenmoss) pre.setAttribute('data-meta', meta);
  code.textContent = codeText(element);
  pre.append(code);
  to.append(pre);
}

function isMath(element: Element): boolean {
  if (element.localName === 'math') return true;
  const type = element.getAttribute('data-type');
  if ((type === 'inline-math' || type === 'block-math') && element.hasAttribute('data-latex')) {
    return true;
  }
  return /\b(katex|katex-display|mwe-math-element)\b/.test(element.getAttribute('class') ?? '');
}

/** Penmoss's formulas, and KaTeX, MathJax-free MathML and Wikipedia formulas with their TeX. */
function math(element: Element, to: Element, ctx: Context): void {
  const type = element.getAttribute('data-type');
  let latex = element.getAttribute('data-latex');
  let block = type === 'block-math';
  if (latex === null || (type !== 'inline-math' && type !== 'block-math')) {
    const annotation = element.querySelector('annotation[encoding="application/x-tex"]');
    latex = annotation?.textContent?.trim().replace(/^\{\\displaystyle (.*)\}$/s, '$1') ?? null;
    const mathElement = element.localName === 'math' ? element : element.querySelector('math');
    block =
      /\bkatex-display\b/.test(element.getAttribute('class') ?? '') ||
      element.querySelector('.katex-display') !== null ||
      mathElement?.getAttribute('display') === 'block';
  }
  if (!latex) {
    const text = (element.textContent ?? '').trim();
    if (text) to.append(ctx.out.createTextNode(text));
    return;
  }
  const node = ctx.out.createElement(block ? 'div' : 'span');
  node.setAttribute('data-type', block ? 'block-math' : 'inline-math');
  node.setAttribute('data-latex', latex);
  copySlice(element, node, ctx);
  to.append(node);
}

function isCallout(element: Element): boolean {
  if (element.hasAttribute('data-callout')) return true;
  // Notion's callout block.
  return element.localName === 'figure' && element.classList.contains('callout');
}

function callout(element: Element, to: Element, ctx: Context, scope: Scope): void {
  const div = ctx.out.createElement('div');
  const type = element.getAttribute('data-callout') ?? 'note';
  div.setAttribute('data-callout', CALLOUT_TYPE.test(type) ? type : 'note');
  const title = element.getAttribute('data-callout-title');
  if (title) div.setAttribute('data-callout-title', title);
  const fold = element.getAttribute('data-callout-fold');
  if (fold === '+' || fold === '-') div.setAttribute('data-callout-fold', fold);
  copySlice(element, div, ctx);
  to.append(div);
  if (element.localName === 'figure') {
    // Notion: an icon cell, then the text.
    for (const child of element.children) {
      if (child.querySelector('.icon') || child.classList.contains('icon')) continue;
      cleanNode(child, div, ctx, { ...scope, marks: NO_MARKS });
    }
    return;
  }
  cleanChildren(element, div, ctx, { ...scope, marks: NO_MARKS });
}

// ---------------------------------------------------------------------------
// Lists.

type ItemKind = { task: false } | { task: true; checked: boolean };

/** Whether a list item is a checklist item, in any of the forms editors write. */
function itemKind(item: Element): ItemKind {
  const dataType = item.getAttribute('data-type');
  if (dataType === 'taskItem') {
    const checked = item.getAttribute('data-checked');
    return { task: true, checked: checked === '' || checked === 'true' };
  }
  // Google Docs.
  if (item.getAttribute('role') === 'checkbox' && item.hasAttribute('aria-checked')) {
    return { task: true, checked: item.getAttribute('aria-checked') === 'true' };
  }
  // GitHub and plain HTML: a checkbox at the start of the item.
  const box = firstElement(item);
  const input = box?.localName === 'input' ? box : box?.querySelector(':scope > input');
  if (input?.getAttribute('type') === 'checkbox') {
    return { task: true, checked: input.hasAttribute('checked') };
  }
  // Notion.
  if (box?.classList.contains('checkbox')) {
    return { task: true, checked: box.classList.contains('checkbox-on') };
  }
  return { task: false };
}

function firstElement(element: Element): Element | null {
  for (let child = element.firstChild; child; child = child.nextSibling) {
    if (child.nodeType === 1) return child as Element;
    if (child.nodeType === 3 && (child.nodeValue ?? '').trim()) return null;
  }
  return null;
}

function list(element: Element, to: Element, ctx: Context, scope: Scope): void {
  const ordered = element.localName === 'ol';
  const start = Number.parseInt(element.getAttribute('start') ?? '', 10);
  const loose = element.getAttribute('data-tight') === 'false';
  // Checklist and plain items cannot share a list (no mixed lists in the schema or GFM),
  // so a run of each kind becomes its own list.
  const runs: { current: { list: Element; task: boolean } | null } = { current: null };
  let lastItem: Element | null = null;
  const open = (task: boolean): { list: Element; task: boolean } => {
    const out = ctx.out.createElement(task || !ordered ? 'ul' : 'ol');
    if (task) out.setAttribute('data-type', 'taskList');
    if (!task && ordered && start > 1 && !runs.current) out.setAttribute('start', String(start));
    if (loose) out.setAttribute('data-tight', 'false');
    if (!runs.current) copySlice(element, out, ctx);
    to.append(out);
    runs.current = { list: out, task };
    return runs.current;
  };
  for (const child of [...element.childNodes]) {
    if (child.nodeType !== 1) {
      if (lastItem && child.nodeType === 3 && (child.nodeValue ?? '').trim()) {
        cleanNode(child, lastItem, ctx, scope);
      }
      continue;
    }
    const item = child as Element;
    if (item.localName === 'ul' || item.localName === 'ol') {
      // A list nested straight inside a list (Google Docs): it belongs to the item before it.
      lastItem ??= (runs.current ?? open(false)).list.appendChild(ctx.out.createElement('li'));
      list(item, lastItem, ctx, scope);
      continue;
    }
    if (item.localName !== 'li') {
      if (lastItem) cleanNode(item, lastItem, ctx, scope);
      continue;
    }
    const style = styleOf(item, ctx);
    if (isHidden(item, style)) continue;
    const kind = itemKind(item);
    const current = runs.current?.task === kind.task ? runs.current : open(kind.task);
    const li = ctx.out.createElement('li');
    copySlice(item, li, ctx);
    current.list.append(li);
    lastItem = li;
    let content: Element = li;
    if (kind.task) {
      li.setAttribute('data-type', 'taskItem');
      li.setAttribute('data-checked', String(kind.checked));
      // TipTap reads a task item's content from its first <div>.
      content = li.appendChild(ctx.out.createElement('div'));
    }
    const box = kind.task ? firstElement(item) : null;
    const changes = markChanges(item, style);
    // Google Docs strikes through done items: that is the checkbox's job here.
    if (kind.task) delete changes.strike;
    const wrapped = wrapMarks(content, changes, scope, ctx);
    for (const node of [...item.childNodes]) {
      if (node === box && box !== null && isCheckbox(box)) continue;
      cleanNode(node, wrapped.target, ctx, wrapped.scope);
    }
  }
}

/** The box at the start of a checklist item: an input, TipTap's label, or Notion's div. */
function isCheckbox(element: Element): boolean {
  return (
    element.localName === 'input' ||
    (element.localName === 'label' && element.querySelector('input') !== null) ||
    element.classList.contains('checkbox')
  );
}

/** `level1` from Word's `mso-list:l0 level1 lfo1`, for paragraphs Word writes as list items. */
function wordListLevel(element: Element): { list: string; level: number } | null {
  if (element.localName !== 'p') return null;
  const match = /mso-list:\s*(l\d+)\s+level(\d+)/i.exec(element.getAttribute('style') ?? '');
  return match ? { list: match[1]!, level: Number(match[2]) } : null;
}

/** The bullet Word wrote before the text (inside its `mso-list:Ignore` span or conditional comments). */
function wordMarker(paragraph: Element): string {
  const ignored = paragraph.querySelector('span[style*="mso-list:Ignore"]');
  if (ignored) return (ignored.textContent ?? '').replace(/\u00a0/g, ' ').trim();
  let text = '';
  let inside = false;
  for (let node = paragraph.firstChild; node; node = node.nextSibling) {
    if (node.nodeType === 8) {
      const data = (node as Comment).data.trim();
      if (/^\[if\b/i.test(data)) inside = true;
      else if (/^\[endif\]/i.test(data)) break;
    } else if (inside) text += node.textContent ?? '';
  }
  return text.replace(/\u00a0/g, ' ').trim();
}

/** Turns a run of Word list paragraphs into nested lists; returns the node after the run. */
function wordList(first: Element, to: Element, ctx: Context, scope: Scope): Node | null {
  const stack: { level: number; id: string; list: Element; item: Element | null }[] = [];
  let node: Node | null = first;
  while (node) {
    if (node.nodeType === 3 && !(node.nodeValue ?? '').trim()) {
      node = node.nextSibling;
      continue;
    }
    const info = node.nodeType === 1 ? wordListLevel(node as Element) : null;
    if (!info) break;
    const paragraph = node as Element;
    const ordered = /^(\d+|[a-z]{1,3}|[ivxlcdm]+)[.)]$/i.test(wordMarker(paragraph));
    const tag = ordered ? 'ol' : 'ul';
    while (stack.length > 0 && stack[stack.length - 1]!.level > info.level) stack.pop();
    let top = stack[stack.length - 1];
    if (top && top.level === info.level && (top.id !== info.list || top.list.localName !== tag)) {
      stack.pop();
      top = stack[stack.length - 1];
    }
    if (!top || top.level < info.level) {
      const list = ctx.out.createElement(tag);
      const parent = top ? (top.item ?? top.list.appendChild(ctx.out.createElement('li'))) : to;
      parent.append(list);
      top = { level: info.level, id: info.list, list, item: null };
      stack.push(top);
    }
    const li = ctx.out.createElement('li');
    top.list.append(li);
    top.item = li;
    // The bullet itself: the conditional comments are skipped by cleanChildren.
    const holder = paragraph.cloneNode(true) as Element;
    holder.querySelector('span[style*="mso-list:Ignore"]')?.remove();
    const wrapped = wrapMarks(li, markChanges(paragraph, styleOf(paragraph, ctx)), scope, ctx);
    cleanChildren(holder, wrapped.target, ctx, wrapped.scope);
    node = node.nextSibling;
  }
  return node;
}

// ---------------------------------------------------------------------------
// Tables: GFM cells hold one line of inline content, and the first row is the header.

function table(element: Element, to: Element, ctx: Context, scope: Scope): void {
  const rows: Element[] = [];
  const collect = (parent: Element) => {
    for (const child of parent.children) {
      if (child.localName === 'tr') rows.push(child);
      else if (['thead', 'tbody', 'tfoot'].includes(child.localName)) collect(child);
    }
  };
  collect(element);
  const fromEditor = element.hasAttribute('data-pm-slice') || ctx.fromPenmoss;
  if (rows.length === 0) return;
  const out = ctx.out.createElement('table');
  copySlice(element, out, ctx);
  const body = ctx.out.createElement('tbody');
  out.append(body);
  let width = 0;
  rows.forEach((row, rowIndex) => {
    const tr = ctx.out.createElement('tr');
    copySlice(row, tr, ctx);
    body.append(tr);
    for (const cell of row.children) {
      if (cell.localName !== 'td' && cell.localName !== 'th') continue;
      const header = fromEditor ? cell.localName === 'th' : rowIndex === 0;
      const outCell = ctx.out.createElement(header ? 'th' : 'td');
      copySlice(cell, outCell, ctx);
      const align = cellAlign(cell, ctx);
      if (align) outCell.setAttribute('align', align);
      const holder = ctx.out.createElement('div');
      cleanChildren(cell, holder, ctx, { ...scope, marks: NO_MARKS });
      inlineCell(holder, outCell, ctx);
      if (header && !fromEditor) unwrapWholeBold(outCell);
      tr.append(outCell);
      const span = Number.parseInt(cell.getAttribute('colspan') ?? '1', 10);
      for (let extra = 1; extra < Math.min(span, 50); extra++) {
        tr.append(ctx.out.createElement(header ? 'th' : 'td'));
      }
    }
    width = Math.max(width, tr.children.length);
  });
  if (!fromEditor) {
    for (const tr of body.children) {
      const header = tr === body.firstElementChild;
      while (tr.children.length < width) tr.append(ctx.out.createElement(header ? 'th' : 'td'));
    }
  }
  to.append(out);
}

/** A cell's alignment, from the cell or (Word) its paragraph. */
function cellAlign(cell: Element, ctx: Context): string | null {
  const read = (element: Element) => {
    const value = (element.getAttribute('align') ?? styleOf(element, ctx).get('text-align') ?? '')
      .trim()
      .toLowerCase();
    return value === 'left' || value === 'center' || value === 'right' ? value : null;
  };
  const first = firstElement(cell);
  return read(cell) ?? (first?.localName === 'p' ? read(first) : null);
}

/** Moves a cell's cleaned content into `cell` as inline content, blocks joined by `<br>`. */
function inlineCell(holder: Element, cell: Element, ctx: Context): void {
  let pendingBreak = false;
  const emit = (node: Node) => {
    if (pendingBreak && cell.childNodes.length > 0) cell.append(ctx.out.createElement('br'));
    pendingBreak = false;
    cell.append(node);
  };
  const lineEnd = () => {
    if (cell.childNodes.length > 0) pendingBreak = true;
  };
  const walk = (parent: Node) => {
    for (const node of [...parent.childNodes]) {
      if (node.nodeType === 3) {
        // Whitespace between blocks means nothing; inside a line it separates words.
        if ((node.nodeValue ?? '').trim() || (!pendingBreak && cell.childNodes.length > 0)) {
          emit(node);
        }
        continue;
      }
      if (node.nodeType !== 1) continue;
      const element = node as Element;
      const tag = element.localName;
      if (tag === 'pre') {
        lineEnd();
        const code = ctx.out.createElement('code');
        code.textContent = (element.textContent ?? '').replace(/\n/g, ' ');
        emit(code);
        lineEnd();
      } else if (tag === 'div' && element.getAttribute('data-type') === 'block-math') {
        const span = ctx.out.createElement('span');
        span.setAttribute('data-type', 'inline-math');
        span.setAttribute('data-latex', element.getAttribute('data-latex') ?? '');
        emit(span);
      } else if (tag === 'br' || tag === 'hr') {
        lineEnd();
      } else if (BLOCKISH.has(tag)) {
        lineEnd();
        walk(element);
        lineEnd();
      } else {
        emit(element);
      }
    }
  };
  walk(holder);
}

function unwrapWholeBold(cell: Element): void {
  const only = cell.children.length === 1 ? cell.firstElementChild : null;
  if (!only || only.localName !== 'strong') return;
  if ((cell.textContent ?? '').trim() !== (only.textContent ?? '').trim()) return;
  only.replaceWith(...only.childNodes);
}

// ---------------------------------------------------------------------------
// Tidying the output.

function isBlock(node: Node | null): boolean {
  return node?.nodeType === 1 && BLOCKISH.has((node as Element).localName);
}

function meaningful(node: Node | null): Node | null {
  let current = node;
  while (current && current.nodeType === 3 && !(current.nodeValue ?? '').trim()) {
    current = current.nextSibling;
  }
  return current;
}

function meaningfulBefore(node: Node | null): Node | null {
  let current = node;
  while (current && current.nodeType === 3 && !(current.nodeValue ?? '').trim()) {
    current = current.previousSibling;
  }
  return current;
}

const CONTENT_LEAVES = 'img, hr, [data-latex], table, pre';

/**
 * Removes blocks with nothing in them (Apple Notes' and Word's spacer lines)
 * and `<br>` between blocks (Google Docs separates blocks with them), and
 * merges lists that were written one item at a time (Notion).
 */
function tidyBlocks(root: Element, ctx: Context): void {
  // List items stay, even empty: an empty checklist item is still an item.
  const blocks = root.querySelectorAll('p, div, h1, h2, h3, h4, h5, h6, blockquote');
  for (const element of [...blocks].reverse()) {
    if (!element.isConnected) continue;
    if (element.hasAttribute('data-latex') || element.hasAttribute('data-callout')) continue;
    if (ctx.fromPenmoss && (element.localName === 'p' || HEADINGS.has(element.localName))) continue;
    const text = (element.textContent ?? '').replace(/\u00a0/g, ' ').trim();
    if (text || element.querySelector(CONTENT_LEAVES)) continue;
    if (element.hasAttribute('data-pm-slice')) continue;
    element.remove();
  }
  for (const br of [...root.querySelectorAll('br')]) {
    const parent = br.parentElement;
    if (!parent || !(parent === root || BLOCKISH.has(parent.localName))) continue;
    if (parent.localName === 'td' || parent.localName === 'th') continue;
    const before = meaningfulBefore(br.previousSibling);
    const after = meaningful(br.nextSibling);
    if ((!before || isBlock(before)) && (!after || isBlock(after) || after.nodeName === 'BR')) {
      br.remove();
    }
  }
  for (const listElement of [...root.querySelectorAll('ul, ol')]) {
    if (!listElement.isConnected) continue;
    let next = meaningful(listElement.nextSibling);
    while (
      next &&
      next.nodeType === 1 &&
      (next as Element).localName === listElement.localName &&
      (next as Element).getAttribute('data-type') === listElement.getAttribute('data-type') &&
      !(next as Element).hasAttribute('data-pm-slice') &&
      continues(listElement, next as Element)
    ) {
      const following = meaningful(next.nextSibling);
      listElement.append(...next.childNodes);
      next.parentNode?.removeChild(next);
      next = following;
    }
  }
}

/** Whether `next` continues `list` (ordered lists only when their numbers run on). */
function continues(list: Element, next: Element): boolean {
  if (list.localName !== 'ol') return true;
  const start = Number.parseInt(list.getAttribute('start') ?? '1', 10) || 1;
  const nextStart = Number.parseInt(next.getAttribute('start') ?? '', 10);
  const count = [...list.children].filter((child) => child.localName === 'li').length;
  return Number.isNaN(nextStart) || nextStart === start + count;
}
