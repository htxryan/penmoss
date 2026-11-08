// The Moss Pen mark (A402, docs/brand.md): one geometry and one palette, written out as
// every logo file the apps ship. Run `task brand` after changing anything here; it runs
// this script, then renders the Mac icon's PNG (apps/desktop/scripts/render-icon.mjs).
//
// The geometry is option 05 of the logo canvas, unchanged: on a 1024 x 1024 tile with
// corner radius 228, a fence (a rounded-square outline, its gate open at the top) and a
// moss mound inside it, both placed by the canvas's fit transform.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const root = join(import.meta.dirname, '..');

/** The fence: a 64-unit round-capped stroke, open between x 436 and 588 at the top. */
const FENCE =
  'M436 250H340A90 90 0 0 0 250 340V684A90 90 0 0 0 340 774H684A90 90 0 0 0 774 684V340A90 90 0 0 0 684 250H588';
/** The moss: five arcs over a flat base at y 712. */
const MOSS =
  'M336 712A90.4 90.4 0 0 1 369.6 565.1A75.9 75.9 0 0 1 457.6 474.2A65.3 65.3 0 0 1 566.4 474.2A75.9 75.9 0 0 1 654.4 565.1A90.4 90.4 0 0 1 688 712Z';
const STROKE = 64;
/** The canvas's fit: scale 0.882 about the origin, then move 61.2 right and down. */
const FIT = { scale: 0.882, offset: 61.2 };
/**
 * The small cut, for 32 px and below (the favicon, the in-app mark): the same shapes, scaled
 * so the fence spans 13 of 16 px. At 16 px the fence is then 1.4 px and the open gate 2 px;
 * the canvas fit gives 0.9 and 1.2, and the gate closes up.
 */
const SMALL_FIT = { scale: 1.415, offset: -212.5 };
const TILE = 1024;
const TILE_RADIUS = 228;
/** The fence's outer edge in the raw geometry (stroke included): x and y 218 to 806. */
const EXTENT = { min: 218, max: 806 };

const PALETTE = {
  light: { tile: '#F3EEDF', fence: '#2E5A3A', moss: '#86AE5E' },
  dark: { tile: '#14201A', fence: '#9CC870', moss: '#4E7F45' },
  mono: { tile: '#FFFFFF', fence: '#1E2228', moss: '#1E2228' },
};

const matrix = ({ scale, offset }) => `matrix(${scale} 0 0 ${scale} ${offset} ${offset})`;

/** The fence and the moss, placed on the tile; colours as attributes or as classes. */
function mark(colours, { classes = false, fit = FIT } = {}) {
  const fence = classes ? 'class="f"' : `stroke="${colours.fence}"`;
  const moss = classes ? 'class="m"' : `fill="${colours.moss}"`;
  return (
    `<g transform="${matrix(fit)}">` +
    `<path ${fence} d="${FENCE}" fill="none" stroke-width="${STROKE}" stroke-linecap="round"/>` +
    `<path ${moss} d="${MOSS}"/>` +
    `</g>`
  );
}

function tile(colours, fit = FIT) {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${TILE} ${TILE}">` +
    `<rect width="${TILE}" height="${TILE}" rx="${TILE_RADIUS}" fill="${colours.tile}"/>` +
    `${mark(colours, { fit })}</svg>\n`
  );
}

/** The favicon (small cut): the light tile, and the dark one when the browser is dark. */
function favicon() {
  const { light, dark } = PALETTE;
  const style =
    `.t{fill:${light.tile}}.f{stroke:${light.fence}}.m{fill:${light.moss}}` +
    `@media (prefers-color-scheme:dark){.t{fill:${dark.tile}}.f{stroke:${dark.fence}}.m{fill:${dark.moss}}}`;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${TILE} ${TILE}">` +
    `<style>${style}</style>` +
    `<rect class="t" width="${TILE}" height="${TILE}" rx="${TILE_RADIUS}"/>` +
    `${mark(null, { classes: true, fit: SMALL_FIT })}</svg>\n`
  );
}

/**
 * A continuous-corner rounded square (the macOS icon shape): Figma's corner smoothing,
 * after figma-squircle (MIT), with Apple's grid values (radius 185.4 on 824, smoothing 0.6).
 */
function squircle(x, y, size, radius, smoothing) {
  const rad = (degrees) => (degrees * Math.PI) / 180;
  const p = (1 + smoothing) * radius;
  const arcMeasure = 90 * (1 - smoothing);
  const arc = Math.sin(rad(arcMeasure / 2)) * radius * Math.SQRT2;
  const alpha = (90 - arcMeasure) / 2;
  const p3p4 = radius * Math.tan(rad(alpha / 2));
  const beta = 45 * smoothing;
  const c = p3p4 * Math.cos(rad(beta));
  const d = c * Math.tan(rad(beta));
  const b = (p - arc - c - d) / 3;
  const a = 2 * b;
  const n = (value) => Number(value.toFixed(2));
  const [A, AB, ABC, BC, C, D, R, S] = [a, a + b, a + b + c, b + c, c, d, radius, arc].map(n);
  return [
    `M${n(x + size - p)} ${y}`,
    `c${A} 0 ${AB} 0 ${ABC} ${D}a${R} ${R} 0 0 1 ${S} ${S}c${D} ${C} ${D} ${BC} ${D} ${ABC}`,
    `L${x + size} ${n(y + size - p)}`,
    `c0 ${A} 0 ${AB} ${-D} ${ABC}a${R} ${R} 0 0 1 ${-S} ${S}c${-C} ${D} ${-BC} ${D} ${-ABC} ${D}`,
    `L${n(x + p)} ${y + size}`,
    `c${-A} 0 ${-AB} 0 ${-ABC} ${-D}a${R} ${R} 0 0 1 ${-S} ${-S}c${-D} ${-C} ${-D} ${-BC} ${-D} ${-ABC}`,
    `L${x} ${n(y + p)}`,
    `c0 ${-A} 0 ${-AB} ${D} ${-ABC}a${R} ${R} 0 0 1 ${S} ${-S}c${C} ${-D} ${BC} ${-D} ${ABC} ${-D}`,
    'Z',
  ].join('');
}

/** The Mac icon: Apple's 1024 grid, an 824 squircle 100 in from each edge, with its shadow. */
function macIcon() {
  const { light } = PALETTE;
  const inset = 100;
  const size = 824;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${TILE} ${TILE}">` +
    `<defs><filter id="s" x="-10%" y="-10%" width="120%" height="125%">` +
    `<feDropShadow dx="0" dy="10" stdDeviation="10" flood-color="#000000" flood-opacity="0.3"/>` +
    `</filter></defs>` +
    `<path d="${squircle(inset, inset, size, 185.4, 0.6)}" fill="${light.tile}" filter="url(#s)"/>` +
    `<g transform="translate(${inset} ${inset}) scale(${size / TILE})">${mark(light)}</g>` +
    `</svg>\n`
  );
}

/**
 * The Mac's menu bar icon (T51 item 17, A945): the fence and the moss in black on nothing, a
 * template image macOS tints for a light or dark menu bar. The mark spans 16 of the icon's 18
 * points (`TRAY_SIZE`); apps/desktop/scripts/render-icon.mjs renders it at 1x and 2x.
 */
const TRAY_SIZE = 18;
function trayGlyph() {
  const span = EXTENT.max - EXTENT.min;
  const size = (span * TRAY_SIZE) / 16;
  const origin = (EXTENT.min + EXTENT.max - size) / 2;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${origin} ${origin} ${size} ${size}">` +
    `<path stroke="#000000" d="${FENCE}" fill="none" stroke-width="${STROKE}" stroke-linecap="round"/>` +
    `<path fill="#000000" d="${MOSS}"/></svg>\n`
  );
}

const XML = '<?xml version="1.0" encoding="utf-8"?>\n';
const ANDROID = 'xmlns:android="http://schemas.android.com/apk/res/android"';
const GENERATED =
  '<!-- Generated by scripts/brand-assets.mjs (docs/brand.md); edit that, not this. -->\n';

function vectorPaths(fence, moss, indent) {
  return (
    `${indent}<path\n${indent}    android:pathData="${FENCE}"\n${indent}    android:strokeColor="${fence}"\n` +
    `${indent}    android:strokeWidth="${STROKE}"\n${indent}    android:strokeLineCap="round" />\n` +
    `${indent}<path\n${indent}    android:pathData="${MOSS}"\n${indent}    android:fillColor="${moss}" />\n`
  );
}

/**
 * An adaptive icon layer (108 dp). The canvas's 1024 tile maps onto the 72 dp a launcher
 * shows, so the mark keeps the canvas's proportions: viewport 1536 = 108 dp, the tile at 256.
 * The mark reaches 22.6 dp from the centre, inside the 33 dp safe zone.
 */
function launcherLayer(comment, fence, moss) {
  const viewport = (TILE * 108) / 72;
  const offset = (viewport - TILE) / 2 + FIT.offset;
  return (
    XML +
    GENERATED +
    `<!-- ${comment} -->\n` +
    `<vector ${ANDROID}\n    android:width="108dp"\n    android:height="108dp"\n` +
    `    android:viewportWidth="${viewport}"\n    android:viewportHeight="${viewport}">\n` +
    `    <group\n        android:scaleX="${FIT.scale}"\n        android:scaleY="${FIT.scale}"\n` +
    `        android:translateX="${offset}"\n        android:translateY="${offset}">\n` +
    vectorPaths(fence, moss, '        ') +
    `    </group>\n</vector>\n`
  );
}

function adaptiveIcon() {
  return (
    XML +
    GENERATED +
    `<adaptive-icon ${ANDROID}>\n` +
    `    <background android:drawable="@color/ic_launcher_background" />\n` +
    `    <foreground android:drawable="@drawable/ic_launcher_foreground" />\n` +
    `    <monochrome android:drawable="@drawable/ic_launcher_monochrome" />\n` +
    `</adaptive-icon>\n`
  );
}

/** The capture tile's and widget's glyph (24 dp): the mark alone, 2 dp clear on each side. */
function captureGlyph() {
  const span = EXTENT.max - EXTENT.min;
  const viewport = Number(((span * 24) / 20).toFixed(1));
  const offset = Number(((viewport - span) / 2 - EXTENT.min).toFixed(1));
  return (
    XML +
    GENERATED +
    `<!-- Capture (T34): the Moss Pen mark for the Quick Settings tile (drawn as a silhouette)\n` +
    `     and the widget (in the brand's colours, light or dark). -->\n` +
    `<vector ${ANDROID}\n    android:width="24dp"\n    android:height="24dp"\n` +
    `    android:viewportWidth="${viewport}"\n    android:viewportHeight="${viewport}">\n` +
    `    <group\n        android:translateX="${offset}"\n        android:translateY="${offset}">\n` +
    vectorPaths('@color/brand_fence', '@color/brand_moss', '        ') +
    `    </group>\n</vector>\n`
  );
}

function colours(entries) {
  const lines = entries.map(([name, value]) => `    <color name="${name}">${value}</color>\n`);
  return `${XML}${GENERATED}<resources>\n${lines.join('')}</resources>\n`;
}

const res = 'apps/android/app/src/main/res';
const files = {
  'apps/web/public/favicon.svg': favicon(),
  'packages/ui/src/icons/brand-mark-light.svg': tile(PALETTE.light, SMALL_FIT),
  'packages/ui/src/icons/brand-mark-dark.svg': tile(PALETTE.dark, SMALL_FIT),
  'apps/desktop/build/icon.svg': macIcon(),
  'apps/desktop/resources/tray/trayTemplate.svg': trayGlyph(),
  'docs/brand/moss-pen-light.svg': tile(PALETTE.light),
  'docs/brand/moss-pen-dark.svg': tile(PALETTE.dark),
  'docs/brand/moss-pen-mono.svg': tile(PALETTE.mono),
  'docs/brand/moss-pen-small-light.svg': tile(PALETTE.light, SMALL_FIT),
  [`${res}/drawable/ic_launcher_foreground.xml`]: launcherLayer(
    'The launcher icon: the mark on the brand paper (the background colour).',
    PALETTE.light.fence,
    PALETTE.light.moss,
  ),
  [`${res}/drawable/ic_launcher_monochrome.xml`]: launcherLayer(
    'Themed icons (Android 13+): the launcher tints this silhouette.',
    '#FFFFFF',
    '#FFFFFF',
  ),
  [`${res}/mipmap-anydpi/ic_launcher.xml`]: adaptiveIcon(),
  [`${res}/mipmap-anydpi/ic_launcher_round.xml`]: adaptiveIcon(),
  [`${res}/drawable/ic_capture.xml`]: captureGlyph(),
  [`${res}/values/brand_colors.xml`]: colours([
    ['ic_launcher_background', PALETTE.light.tile],
    ['brand_fence', PALETTE.light.fence],
    ['brand_moss', PALETTE.light.moss],
  ]),
  [`${res}/values-night/brand_colors.xml`]: colours([
    ['brand_fence', PALETTE.dark.fence],
    ['brand_moss', PALETTE.dark.moss],
  ]),
};

for (const [path, content] of Object.entries(files)) {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
  console.log(`wrote ${path}`);
}
