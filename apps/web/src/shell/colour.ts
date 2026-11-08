/**
 * Colour maths for the colour picker (T51 item 10, A939): hex text to and from red, green,
 * blue and alpha, and those to and from hue, saturation and value, the colour wheel's terms.
 * Pure, so the picker's behaviour is tested without a page.
 */

/** Red, green and blue 0–255, alpha 0–1. */
export interface Rgba {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly a: number;
}

/** Hue 0–360 (degrees, red at 0), saturation and value 0–1, alpha 0–1. */
export interface Hsva {
  readonly h: number;
  readonly s: number;
  readonly v: number;
  readonly a: number;
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const byte = (value: number) => clamp(Math.round(value), 0, 255);
const hex2 = (value: number) => byte(value).toString(16).padStart(2, '0');

const HEX_TEXT = /^#?([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/**
 * A colour typed as hex: `#rgb`, `#rgba`, `#rrggbb` or `#rrggbbaa`, any case, the `#` and
 * surrounding spaces optional. Null when it is not one.
 */
export function parseHex(text: string): Rgba | null {
  const match = HEX_TEXT.exec(text.trim());
  if (!match) return null;
  let digits = match[1]!.toLowerCase();
  if (digits.length <= 4) digits = [...digits].map((digit) => digit + digit).join('');
  const at = (index: number) => Number.parseInt(digits.slice(index, index + 2), 16);
  return {
    r: at(0),
    g: at(2),
    b: at(4),
    a: digits.length === 8 ? at(6) / 255 : 1,
  };
}

/** A colour as stored (A939): `#rrggbb` when opaque, else `#rrggbbaa`, lower case. */
export function formatHex({ r, g, b, a }: Rgba): string {
  const alpha = byte(clamp(a, 0, 1) * 255);
  return `#${hex2(r)}${hex2(g)}${hex2(b)}${alpha === 255 ? '' : hex2(alpha)}`;
}

/** Hex text in its stored form, or null when it is not a colour. */
export function normaliseHex(text: string): string | null {
  const colour = parseHex(text);
  return colour ? formatHex(colour) : null;
}

export function rgbToHsv({ r, g, b, a }: Rgba): Hsva {
  const [red, green, blue] = [r / 255, g / 255, b / 255];
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const delta = max - min;
  let h = 0;
  if (delta > 0) {
    if (max === red) h = ((green - blue) / delta) % 6;
    else if (max === green) h = (blue - red) / delta + 2;
    else h = (red - green) / delta + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s: max === 0 ? 0 : delta / max, v: max, a };
}

export function hsvToRgb({ h, s, v, a }: Hsva): Rgba {
  const hue = (((h % 360) + 360) % 360) / 60;
  const sat = clamp(s, 0, 1);
  const val = clamp(v, 0, 1);
  const chroma = val * sat;
  const x = chroma * (1 - Math.abs((hue % 2) - 1));
  const m = val - chroma;
  const [r, g, b] =
    hue < 1
      ? [chroma, x, 0]
      : hue < 2
        ? [x, chroma, 0]
        : hue < 3
          ? [0, chroma, x]
          : hue < 4
            ? [0, x, chroma]
            : hue < 5
              ? [x, 0, chroma]
              : [chroma, 0, x];
  return { r: byte((r + m) * 255), g: byte((g + m) * 255), b: byte((b + m) * 255), a };
}

/** Hex text as hue, saturation, value and alpha; null when it is not a colour. */
export function hexToHsv(text: string): Hsva | null {
  const colour = parseHex(text);
  return colour ? rgbToHsv(colour) : null;
}

export const hsvToHex = (colour: Hsva): string => formatHex(hsvToRgb(colour));

/**
 * A point on the colour wheel as hue and saturation: `x` and `y` from its centre (y down),
 * `radius` its edge. Hue runs clockwise from red at the top, as the wheel's conic gradient
 * draws it; saturation is the distance out, 1 at the edge and beyond.
 */
export function wheelPoint(x: number, y: number, radius: number): { h: number; s: number } {
  const distance = Math.hypot(x, y);
  if (distance === 0 || radius <= 0) return { h: 0, s: 0 };
  let h = (Math.atan2(x, -y) * 180) / Math.PI;
  if (h < 0) h += 360;
  return { h, s: Math.min(1, distance / radius) };
}

/** Where a hue and saturation sit on the wheel, from its centre (the inverse of `wheelPoint`). */
export function wheelPosition(h: number, s: number, radius: number): { x: number; y: number } {
  const angle = (h * Math.PI) / 180;
  return { x: Math.sin(angle) * s * radius, y: -Math.cos(angle) * s * radius };
}
