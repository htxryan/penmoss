import { describe, expect, it } from 'vitest';
import {
  formatHex,
  hexToHsv,
  hsvToHex,
  hsvToRgb,
  normaliseHex,
  parseHex,
  rgbToHsv,
  wheelPoint,
  wheelPosition,
} from '../../src/shell/colour';

// T51 item 10 (A939): the colour picker's maths.

describe('hex colours', () => {
  it('reads #RGB, #RGBA, #RRGGBB and #RRGGBBAA, in any case, with or without #', () => {
    expect(parseHex('#F80')).toEqual({ r: 255, g: 136, b: 0, a: 1 });
    expect(parseHex('f808')).toEqual({ r: 255, g: 136, b: 0, a: 136 / 255 });
    expect(parseHex(' #3366CC ')).toEqual({ r: 51, g: 102, b: 204, a: 1 });
    expect(parseHex('#3366cc80')).toEqual({ r: 51, g: 102, b: 204, a: 128 / 255 });
  });

  it('refuses what is not a colour', () => {
    for (const text of [
      '',
      '#',
      '#12',
      '#12345',
      '#1234567',
      '#ggg',
      'red',
      '#3366cc8',
      'rgb(0,0,0)',
    ])
      expect(parseHex(text), text).toBeNull();
  });

  it('writes #rrggbb when opaque and #rrggbbaa otherwise, lower case', () => {
    expect(formatHex({ r: 51, g: 102, b: 204, a: 1 })).toBe('#3366cc');
    expect(formatHex({ r: 51, g: 102, b: 204, a: 0.5 })).toBe('#3366cc80');
    expect(formatHex({ r: 0, g: 0, b: 0, a: 0 })).toBe('#00000000');
    // Out of range is clamped, not wrapped.
    expect(formatHex({ r: 300, g: -4, b: 12.6, a: 2 })).toBe('#ff000d');
  });

  it('normalises typed text to the stored form, alpha ff dropped', () => {
    expect(normaliseHex('#ABC')).toBe('#aabbcc');
    expect(normaliseHex('#AABBCCFF')).toBe('#aabbcc');
    expect(normaliseHex('aabbcc7f')).toBe('#aabbcc7f');
    expect(normaliseHex('nope')).toBeNull();
  });
});

describe('hue, saturation and value', () => {
  it('converts the primaries, white, black and grey', () => {
    expect(rgbToHsv({ r: 255, g: 0, b: 0, a: 1 })).toEqual({ h: 0, s: 1, v: 1, a: 1 });
    expect(rgbToHsv({ r: 0, g: 255, b: 0, a: 1 })).toEqual({ h: 120, s: 1, v: 1, a: 1 });
    expect(rgbToHsv({ r: 0, g: 0, b: 255, a: 1 })).toEqual({ h: 240, s: 1, v: 1, a: 1 });
    expect(rgbToHsv({ r: 255, g: 255, b: 255, a: 1 })).toEqual({ h: 0, s: 0, v: 1, a: 1 });
    expect(rgbToHsv({ r: 0, g: 0, b: 0, a: 0.5 })).toEqual({ h: 0, s: 0, v: 0, a: 0.5 });
    expect(hsvToRgb({ h: 300, s: 1, v: 1, a: 1 })).toEqual({ r: 255, g: 0, b: 255, a: 1 });
    expect(hsvToRgb({ h: 0, s: 0, v: 0.5, a: 1 })).toEqual({ r: 128, g: 128, b: 128, a: 1 });
    // A hue past a turn is the same hue.
    expect(hsvToRgb({ h: 480, s: 1, v: 1, a: 1 })).toEqual(hsvToRgb({ h: 120, s: 1, v: 1, a: 1 }));
  });

  it('round-trips every hex colour on a coarse grid, alpha included', () => {
    for (let r = 0; r <= 255; r += 51)
      for (let g = 0; g <= 255; g += 51)
        for (let b = 0; b <= 255; b += 51) {
          const hex = formatHex({ r, g, b, a: 0.4 });
          expect(hsvToHex(hexToHsv(hex)!), hex).toBe(hex);
        }
    expect(hexToHsv('nope')).toBeNull();
  });
});

describe('the colour wheel', () => {
  it('puts red at the top and runs clockwise, saturation out to the edge', () => {
    expect(wheelPoint(0, -50, 50)).toEqual({ h: 0, s: 1 });
    expect(wheelPoint(25, 0, 50)).toEqual({ h: 90, s: 0.5 });
    expect(wheelPoint(0, 50, 50).h).toBeCloseTo(180);
    expect(wheelPoint(-10, 0, 50)).toEqual({ h: 270, s: 0.2 });
    // Outside the wheel: its edge.
    expect(wheelPoint(0, -80, 50).s).toBe(1);
    expect(wheelPoint(0, 0, 50)).toEqual({ h: 0, s: 0 });
  });

  it('places a hue and saturation where a click there would read them back', () => {
    for (const [h, s] of [
      [0, 1],
      [45, 0.3],
      [200, 0.75],
      [359, 0.5],
    ] as const) {
      const { x, y } = wheelPosition(h, s, 60);
      const back = wheelPoint(x, y, 60);
      expect(back.h).toBeCloseTo(h);
      expect(back.s).toBeCloseTo(s);
    }
  });
});
