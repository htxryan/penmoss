/**
 * Colour maths for themes (T28): sRGB hex parsing, WCAG 2 contrast, and the
 * two ways the stylesheet derives colours from theme tokens, so tests and the
 * theme editor can check the colours a browser will actually paint:
 * `color-mix(in oklab, a, b p%)` between opaque colours, and a colour mixed
 * with `transparent` (premultiplied, so the colour at that alpha) laid over a
 * surface.
 */

export type Rgb = readonly [number, number, number];

const HEX = /^#[0-9a-f]{6}$/i;

/** A theme colour: `#rrggbb` (what `<input type="color">` reads and writes). */
export function isHexColour(value: unknown): value is string {
  return typeof value === 'string' && HEX.test(value);
}

export function parseHex(hex: string): Rgb {
  if (!isHexColour(hex)) throw new Error(`Not a #rrggbb colour: ${String(hex)}`);
  return [
    Number.parseInt(hex.slice(1, 3), 16),
    Number.parseInt(hex.slice(3, 5), 16),
    Number.parseInt(hex.slice(5, 7), 16),
  ];
}

const clampByte = (value: number) => Math.min(255, Math.max(0, Math.round(value)));

export function toHex([r, g, b]: Rgb): string {
  return `#${[r, g, b].map((channel) => clampByte(channel).toString(16).padStart(2, '0')).join('')}`;
}

const toLinear = (channel: number) => {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};

const fromLinear = (c: number) =>
  255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * Math.max(0, c) ** (1 / 2.4) - 0.055);

/** WCAG 2 relative luminance (0 black … 1 white). */
export function luminance(colour: string | Rgb): number {
  const [r, g, b] = (typeof colour === 'string' ? parseHex(colour) : colour).map(toLinear) as [
    number,
    number,
    number,
  ];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2 contrast ratio, 1 … 21. */
export function contrast(a: string | Rgb, b: string | Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

export type Oklab = readonly [number, number, number];

export function toOklab(colour: string | Rgb): Oklab {
  const [r, g, b] = (typeof colour === 'string' ? parseHex(colour) : colour).map(toLinear) as [
    number,
    number,
    number,
  ];
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

export function fromOklab([L, a, b]: Oklab): Rgb {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    clampByte(fromLinear(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s)),
    clampByte(fromLinear(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s)),
    clampByte(fromLinear(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s)),
  ];
}

/** `color-mix(in oklab, a, b <weightB>)` for opaque colours, `weightB` from 0 to 1. */
export function mix(a: string, b: string, weightB: number): string {
  const [l1, a1, b1] = toOklab(a);
  const [l2, a2, b2] = toOklab(b);
  const at = (p: number, q: number) => p * (1 - weightB) + q * weightB;
  return toHex(fromOklab([at(l1, l2), at(a1, a2), at(b1, b2)]));
}

/**
 * `color-mix(in oklab, colour <alpha>, transparent)` painted over `surface`:
 * mixing with transparent keeps the colour and scales its alpha, and the
 * browser composites in sRGB.
 */
export function over(colour: string, alpha: number, surface: string): string {
  const [r1, g1, b1] = parseHex(colour);
  const [r2, g2, b2] = parseHex(surface);
  const at = (p: number, q: number) => p * alpha + q * (1 - alpha);
  return toHex([at(r1, r2), at(g1, g2), at(b1, b2)]);
}
