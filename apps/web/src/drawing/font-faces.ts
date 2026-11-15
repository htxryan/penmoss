/**
 * Excalidraw's fonts, kept to the app's own files (PEN-28).
 *
 * Excalidraw makes a `FontFace` for each of its font files with two sources: the file under
 * `EXCALIDRAW_ASSET_PATH` (the app's bundle) and, always, the same file on a CDN (esm.sh). The app's
 * CSP refuses the CDN, but Chrome still tries it and reports a violation for every face. So before
 * Excalidraw loads, `keepFontFacesLocal` makes each new `FontFace` keep only the sources the page
 * may load (its own origin, `data:`), and records each face's file and Unicode range.
 *
 * A drawing's SVG carries the fonts its text uses (so GitHub and any viewer show it hand-drawn),
 * but not as Excalidraw inlines them: it subsets fonts with WebAssembly and code that needs `eval`,
 * which the CSP refuses. `facesFor` picks, from the recorded faces, the files a text needs (its
 * families, the ranges its characters fall in), which the drawing editor inlines whole.
 */

export interface RecordedFace {
  readonly family: string;
  /** The font file, on this origin. */
  readonly url: string;
  /** The CSS `unicode-range` it covers, as Excalidraw declared it. */
  readonly unicodeRange: string;
}

const recorded = new Map<string, RecordedFace>();

/** `url(…) format(…)` entries of a `FontFace` source string, with the URL unquoted. */
const SOURCE = /url\(\s*(["']?)([^"')]+)\1\s*\)(?:\s*format\([^)]*\))?/g;

/** The `src` entries of `source` the page may load: its own origin's and `data:`; others go. */
export function localSources(source: string, origin: string): { kept: string; urls: string[] } {
  const kept: string[] = [];
  const urls: string[] = [];
  for (const match of source.matchAll(SOURCE)) {
    const raw = match[2]!.trim();
    let url: URL;
    try {
      url = new URL(raw, `${origin}/`);
    } catch {
      continue;
    }
    if (url.protocol === 'data:' || url.origin === origin) {
      kept.push(match[0]);
      if (url.protocol !== 'data:') urls.push(url.href);
    }
  }
  return { kept: kept.join(', '), urls };
}

/**
 * Makes `FontFace` keep only local sources from now on (see above), recording each local face.
 * Once per window; faces given buffers, or no remote source, are made as they were.
 */
export function keepFontFacesLocal(win: Window & typeof globalThis = window): void {
  const Native = win.FontFace;
  if (!Native || local.has(Native)) return;
  const origin = win.location.origin;
  class LocalFontFace extends Native {
    constructor(family: string, source: string | BufferSource, descriptors?: FontFaceDescriptors) {
      if (typeof source !== 'string') {
        super(family, source, descriptors);
        return;
      }
      const { kept, urls } = localSources(source, origin);
      super(family, kept || source, descriptors);
      const url = urls[0];
      if (kept && url) {
        recorded.set(`${family}\n${url}`, {
          family,
          url,
          unicodeRange: descriptors?.unicodeRange ?? 'U+0-10FFFF',
        });
      }
    }
  }
  local.add(LocalFontFace);
  win.FontFace = LocalFontFace;
}

/** The `FontFace` classes `keepFontFacesLocal` made. */
const local = new WeakSet<object>();

/** The ranges a CSS `unicode-range` covers: `U+0-FF, U+131, U+4??` as [first, last] pairs. */
export function unicodeRanges(range: string): Array<readonly [number, number]> {
  const out: Array<readonly [number, number]> = [];
  for (const part of range.split(',')) {
    const text = part.trim().replace(/^u\+/i, '');
    if (!text) continue;
    if (text.includes('?')) {
      out.push([parseInt(text.replace(/\?/g, '0'), 16), parseInt(text.replace(/\?/g, 'F'), 16)]);
      continue;
    }
    const [first, last = first] = text.split('-');
    const from = parseInt(first!, 16);
    const to = parseInt(last!, 16);
    if (Number.isFinite(from) && Number.isFinite(to)) out.push([from, to]);
  }
  return out;
}

/** Family names in a CSS `font-family` list, unquoted: `Excalifont, "Segoe UI Emoji"`. */
export function fontFamilies(list: string): string[] {
  return list
    .split(',')
    .map((name) => name.trim().replace(/^(["'])(.*)\1$/, '$2'))
    .filter(Boolean);
}

/**
 * The recorded faces a text needs: of `families`, those whose range holds one of its characters,
 * in the order they were recorded.
 */
export function facesFor(
  families: ReadonlySet<string>,
  text: string,
  faces: Iterable<RecordedFace> = recorded.values(),
): RecordedFace[] {
  const points = new Set<number>();
  for (const char of text) points.add(char.codePointAt(0)!);
  return [...faces].filter(
    (face) =>
      families.has(face.family) &&
      unicodeRanges(face.unicodeRange).some(([from, to]) =>
        [...points].some((point) => point >= from && point <= to),
      ),
  );
}
