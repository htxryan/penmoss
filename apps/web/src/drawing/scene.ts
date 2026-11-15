/**
 * A drawing's files (PEN-28): reading a `.excalidraw` scene, and making its SVG, with the font
 * files its text uses inlined (font-faces.ts), so GitHub and any viewer show it as drawn.
 */
import { exportToSvg } from '@excalidraw/excalidraw';
import type {
  AppState,
  BinaryFiles,
  ExcalidrawInitialDataState,
} from '@excalidraw/excalidraw/types';
import { facesFor, fontFamilies } from './font-faces';

export interface DrawingResult {
  /** Excalidraw's JSON, the `.excalidraw` file. */
  readonly scene: string;
  /** The rendered picture, the `.svg` file. */
  readonly svg: string;
}

/** A `.excalidraw` file's text as Excalidraw's initial data; throws when it isn't one. */
export function parseScene(text: string): ExcalidrawInitialDataState {
  const data = JSON.parse(text) as {
    type?: unknown;
    elements?: unknown;
    appState?: unknown;
    files?: unknown;
  };
  if (data?.type !== 'excalidraw' || !Array.isArray(data.elements)) {
    throw new Error('not an Excalidraw scene');
  }
  return {
    elements: data.elements,
    appState: data.appState ?? {},
    files: (data.files ?? {}) as BinaryFiles,
    scrollToContent: true,
  };
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/** A font file as a `data:` URL. */
async function fontDataUrl(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`a font file is missing (${response.status})`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  let binary = '';
  for (let at = 0; at < bytes.length; at += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  }
  return `data:font/woff2;base64,${btoa(binary)}`;
}

/**
 * Puts the font files the SVG's text needs into it, as `@font-face` rules of `data:` URLs, so it
 * shows hand-drawn wherever it is opened (font-faces.ts).
 */
export async function inlineFonts(svg: SVGSVGElement): Promise<void> {
  const texts = [...svg.querySelectorAll('text')];
  if (texts.length === 0) return;
  const families = new Set(
    texts.flatMap((text) => fontFamilies(text.getAttribute('font-family') ?? '')),
  );
  const content = texts.map((text) => text.textContent ?? '').join('');
  const rules = await Promise.all(
    facesFor(families, content).map(
      async (face) =>
        `@font-face { font-family: ${JSON.stringify(face.family)}; src: url(${await fontDataUrl(face.url)}) format('woff2'); unicode-range: ${face.unicodeRange}; }`,
    ),
  );
  if (rules.length === 0) return;
  const doc = svg.ownerDocument;
  let defs = svg.querySelector('defs');
  if (!defs) {
    defs = doc.createElementNS(SVG_NS, 'defs');
    svg.prepend(defs);
  }
  // Excalidraw leaves its (empty) font style element when it inlines nothing: ours fills it.
  let style = defs.querySelector('style.style-fonts');
  if (!style) {
    style = doc.createElementNS(SVG_NS, 'style');
    style.setAttribute('class', 'style-fonts');
    defs.append(style);
  }
  style.textContent = rules.join('\n');
}

type SceneElements = NonNullable<ExcalidrawInitialDataState['elements']>;

/**
 * Excalidraw's `exportToSvg`, typed: its published types name a package it does not publish
 * (`@excalidraw/utils`), so they do not resolve.
 */
const exportSvg = exportToSvg as unknown as (options: {
  elements: SceneElements;
  appState: Partial<AppState>;
  files: BinaryFiles;
  exportPadding: number;
  skipInliningFonts: boolean;
}) => Promise<SVGSVGElement>;

/**
 * The drawing's picture: on a white background in light colours, so GitHub shows it readably in
 * either mode, with its fonts inlined. Excalidraw's own inlining subsets fonts with code the
 * CSP refuses, so `inlineFonts` puts in the files whole.
 */
export async function drawingSvg(
  elements: SceneElements,
  appState: Pick<AppState, 'viewBackgroundColor'>,
  files: BinaryFiles,
): Promise<string> {
  const svg = await exportSvg({
    elements,
    appState: {
      exportBackground: true,
      exportWithDarkMode: false,
      exportEmbedScene: false,
      viewBackgroundColor: appState.viewBackgroundColor,
    },
    files,
    exportPadding: 16,
    skipInliningFonts: true,
  });
  await inlineFonts(svg);
  return new XMLSerializer().serializeToString(svg);
}
