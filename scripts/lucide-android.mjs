// Lucide's icons for Android's notebook badges (A1579): every icon of the web's own lucide-static
// (its shapes and tags) and @lucide/icons' aliases, written compactly into the Android app's
// assets, which git ignores. `task android:editor` runs it after building the editor page.
//
// One icon a line: `name<TAB>tag,tag<TAB>shape<TAB>shape…`, sorted by name as the web's picker
// lists them. A shape is its element's letter, `!` when it is filled (`fill="currentColor"`), `:`
// and its attributes in a fixed order, `;` between them (a path's is its `d`):
//   p:d   c:cx;cy;r   r:x;y;width;height;rx;ry   l:x1;y1;x2;y2   e:cx;cy;rx;ry
//   y:points (polyline)   g:points (polygon)
// Then one line an alias: `=alias<TAB>name`.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = join(import.meta.dirname, '..');
/** The web app's own Lucide, so the phone draws what the Mac does. */
const require = createRequire(join(root, 'apps/web/package.json'));
const OUT = join(root, 'apps/android/app/src/main/assets/lucide/icons.txt');

/** @typedef {[string, Record<string, string>]} Shape */

/** @type {Record<string, Shape[]>} */
const nodes = JSON.parse(readFileSync(require.resolve('lucide-static/icon-nodes.json'), 'utf8'));
/** @type {Record<string, string[]>} */
const tags = JSON.parse(readFileSync(require.resolve('lucide-static/tags.json'), 'utf8'));
const dynamic =
  /** @type {{ lucideDynamicIconImports: Record<string, () => Promise<{ default: { name: string } }>> }} */ (
    await import(pathToFileURL(require.resolve('@lucide/icons/dynamic')).href)
  );

/** Each element's letter and its attributes, in the order they are written. */
/** @type {Record<string, [string, string[]]>} */
const ELEMENTS = {
  path: ['p', ['d']],
  circle: ['c', ['cx', 'cy', 'r']],
  rect: ['r', ['x', 'y', 'width', 'height', 'rx', 'ry']],
  line: ['l', ['x1', 'y1', 'x2', 'y2']],
  ellipse: ['e', ['cx', 'cy', 'rx', 'ry']],
  polyline: ['y', ['points']],
  polygon: ['g', ['points']],
};
const KNOWN = new Set(['key', 'fill', ...Object.values(ELEMENTS).flatMap(([, names]) => names)]);

/** @param {string} name @param {Shape} shape */
function shapeLine(name, [element, attributes]) {
  const known = ELEMENTS[element];
  if (!known) throw new Error(`${name}: a ${element} the phone cannot draw`);
  for (const attribute of Object.keys(attributes)) {
    if (!KNOWN.has(attribute)) throw new Error(`${name}: ${element}'s ${attribute} is not drawn`);
  }
  const fill = attributes['fill'];
  if (fill !== undefined && fill !== 'currentColor') throw new Error(`${name}: fill ${fill}`);
  const [letter, names] = known;
  const values = names.map((each) => attributes[each] ?? '');
  for (const value of values) {
    if (/[\t\n;]/.test(value)) throw new Error(`${name}: ${element} has a separator in ${value}`);
  }
  return `${letter}${fill ? '!' : ''}:${values.join(';')}`;
}

const lines = Object.keys(nodes)
  .sort()
  .map((name) => {
    const words = tags[name] ?? [];
    for (const word of words) {
      if (/[\t\n,]/.test(word)) throw new Error(`${name}: a tag with a separator, ${word}`);
    }
    return [
      name,
      words.join(','),
      ...(nodes[name] ?? []).map((shape) => shapeLine(name, shape)),
    ].join('\t');
  });

// An alias is a name @lucide/icons resolves that lucide-static does not list: it draws its icon.
const aliases = [];
for (const [alias, load] of Object.entries(dynamic.lucideDynamicIconImports).sort(([a], [b]) =>
  a < b ? -1 : a > b ? 1 : 0,
)) {
  if (Object.hasOwn(nodes, alias)) continue;
  const { name } = (await load()).default;
  if (!Object.hasOwn(nodes, name))
    throw new Error(`${alias} resolves to ${name}, which has no shapes`);
  aliases.push(`=${alias}\t${name}`);
}

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, `${[...lines, ...aliases].join('\n')}\n`);
console.log(`lucide-android: ${lines.length} icons and ${aliases.length} aliases in ${OUT}`);
