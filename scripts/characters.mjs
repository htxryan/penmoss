// The Characters a line symbol can be (A1568): the symbols below, then emoji from emojibase-data
// (MIT; its names and keywords are Unicode's CLDR annotations), each a valid glyph by core's
// rules (A743). Written to packages/core/data/characters.json, which the web's picker loads
// lazily and Android ships as an asset. Run `task characters` after changing anything here or
// updating emojibase-data; the file is committed, so neither app needs this to build.
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
// Core's own glyph rules, run by Node from the TypeScript source (type stripping).
const LINE_SYMBOLS = new URL('../packages/core/src/line-symbols.ts', import.meta.url).href;
const { SYMBOL_GLYPH_PRESETS, glyphKey, glyphProblem } =
  /** @type {typeof import('../packages/core/src/line-symbols.js')} */ (await import(LINE_SYMBOLS));
const require = createRequire(join(root, 'package.json'));

/** Emoji newer than this may not draw on every Mac and phone yet. */
const NEWEST_EMOJI = 17;

/**
 * Symbols that are not emoji, with a name and the words they are also found by. The presets
 * Settings had (SYMBOL_GLYPH_PRESETS) come first, in their order; those that are emoji take
 * their name from the emoji data when they are not here.
 */
/** @type {ReadonlyArray<readonly [glyph: string, name: string, words: string]>} */
const SYMBOLS = [
  ['★', 'star', 'important favourite filled black'],
  ['☆', 'star outline', 'important favourite white hollow'],
  ['?', 'question mark', 'question ask unsure'],
  ['!', 'exclamation mark', 'important follow-up alert bang'],
  ['‼', 'double exclamation mark', 'urgent important bang'],
  ['⁉', 'exclamation question mark', 'surprise interrobang'],
  ['→', 'right arrow', 'next then forward'],
  ['←', 'left arrow', 'back previous'],
  ['↑', 'up arrow', 'increase raise'],
  ['↓', 'down arrow', 'decrease lower'],
  ['⇒', 'double right arrow', 'implies therefore next'],
  ['✓', 'check mark', 'done tick yes complete'],
  ['✔', 'heavy check mark', 'done tick yes complete'],
  ['✗', 'ballot x', 'no cross wrong cancel'],
  ['✘', 'heavy ballot x', 'no cross wrong cancel'],
  ['●', 'circle', 'dot bullet filled black'],
  ['○', 'circle outline', 'dot bullet white hollow'],
  ['◆', 'diamond', 'filled black'],
  ['◇', 'diamond outline', 'white hollow'],
  ['■', 'square', 'filled black box'],
  ['□', 'square outline', 'white hollow box'],
  ['▲', 'triangle', 'up filled black'],
  ['△', 'triangle outline', 'up white hollow'],
  ['♥', 'heart', 'love suit'],
  ['⚑', 'flag', 'mark black'],
  ['⚠', 'warning sign', 'caution alert danger'],
  ['✎', 'pencil', 'edit write draft'],
  ['§', 'section sign', 'law paragraph'],
  ['※', 'reference mark', 'note komejirushi'],
  ['❖', 'diamond minus white x', 'ornament'],
  ['↔', 'left right arrow', 'both ways exchange'],
  ['↕', 'up down arrow', 'both ways'],
  ['↗', 'north east arrow', 'up right rising'],
  ['↘', 'south east arrow', 'down right falling'],
  ['↙', 'south west arrow', 'down left'],
  ['↖', 'north west arrow', 'up left'],
  ['↩', 'left arrow with hook', 'return reply undo'],
  ['↪', 'right arrow with hook', 'redo forward'],
  ['↻', 'clockwise arrow', 'repeat refresh redo cycle'],
  ['↺', 'anticlockwise arrow', 'undo refresh cycle'],
  ['⇐', 'double left arrow', 'implied by'],
  ['⇔', 'double left right arrow', 'if and only if equivalent'],
  ['⟶', 'long right arrow', 'next leads to'],
  ['➜', 'heavy round-tipped right arrow', 'next go'],
  ['➤', 'arrowhead', 'next pointer play'],
  ['▶', 'play', 'start triangle right'],
  ['◀', 'reverse', 'back triangle left'],
  ['▼', 'down triangle', 'filled black'],
  ['▽', 'down triangle outline', 'white hollow'],
  ['►', 'right pointer', 'triangle'],
  ['◄', 'left pointer', 'triangle'],
  ['▪', 'small square', 'bullet black'],
  ['▫', 'small square outline', 'bullet white'],
  ['◉', 'fisheye', 'target selected radio'],
  ['◎', 'bullseye', 'target'],
  ['◌', 'dotted circle', 'placeholder'],
  ['◐', 'circle left half black', 'half progress'],
  ['◑', 'circle right half black', 'half progress'],
  ['◒', 'circle lower half black', 'half'],
  ['◓', 'circle upper half black', 'half'],
  ['◔', 'circle quarter', 'progress started'],
  ['◕', 'circle three quarters', 'progress almost'],
  ['⬤', 'large circle', 'dot filled black'],
  ['⬟', 'pentagon', 'filled black'],
  ['⬢', 'hexagon', 'filled black'],
  ['⬡', 'hexagon outline', 'white hollow'],
  ['✦', 'four pointed star', 'sparkle black'],
  ['✧', 'four pointed star outline', 'sparkle white'],
  ['✩', 'stress outlined star', 'outline'],
  ['✪', 'circled star', 'badge'],
  ['✰', 'shadowed star', 'outline'],
  ['✱', 'heavy asterisk', 'note star'],
  ['✳', 'eight spoked asterisk', 'note'],
  ['✴', 'eight pointed star', 'note'],
  ['❋', 'heavy eight teardrop propeller asterisk', 'flower'],
  ['❀', 'flower', 'florette'],
  ['✿', 'black florette', 'flower'],
  ['❁', 'eight petalled flower', 'florette'],
  ['☀', 'sun', 'sunny weather day'],
  ['☁', 'cloud', 'weather'],
  ['☂', 'umbrella', 'rain weather'],
  ['☃', 'snowman', 'winter snow'],
  ['☄', 'comet', 'space'],
  ['☎', 'telephone', 'phone call'],
  ['☐', 'ballot box', 'checkbox todo empty'],
  ['☑', 'ballot box with check', 'checkbox done'],
  ['☒', 'ballot box with x', 'checkbox cancelled'],
  ['☕', 'hot beverage', 'coffee tea'],
  ['☘', 'shamrock', 'luck clover'],
  ['☛', 'pointing hand', 'look here right'],
  ['☞', 'pointing hand outline', 'look here right'],
  ['☯', 'yin yang', 'balance'],
  ['☹', 'frowning face', 'sad'],
  ['☺', 'smiling face', 'happy smile'],
  ['☻', 'smiling face filled', 'happy smile'],
  ['♠', 'spade', 'suit cards'],
  ['♣', 'club', 'suit cards'],
  ['♦', 'diamond suit', 'cards'],
  ['♡', 'heart outline', 'love suit white'],
  ['♪', 'eighth note', 'music'],
  ['♫', 'beamed notes', 'music'],
  ['♻', 'recycling', 'recycle reuse environment'],
  ['⚐', 'flag outline', 'mark white'],
  ['⚙', 'gear', 'settings cog'],
  ['⚛', 'atom', 'science physics'],
  ['⚡', 'high voltage', 'lightning fast electric'],
  ['⚪', 'white circle', 'dot'],
  ['⚫', 'black circle', 'dot'],
  ['⛔', 'no entry', 'stop forbidden blocked'],
  ['⛳', 'flag in hole', 'golf goal'],
  ['✂', 'scissors', 'cut'],
  ['✈', 'airplane', 'travel flight'],
  ['✉', 'envelope', 'mail email letter'],
  ['✍', 'writing hand', 'write sign'],
  ['✏', 'pencil', 'write edit'],
  ['✒', 'nib', 'pen write'],
  ['✚', 'heavy greek cross', 'add plus'],
  ['✜', 'heavy open centre cross', 'add'],
  ['✝', 'latin cross', 'cross'],
  ['✠', 'maltese cross', 'cross'],
  ['✕', 'multiplication x', 'close cancel cross'],
  ['✖', 'heavy multiplication x', 'close cancel cross'],
  ['❌', 'cross mark', 'no wrong cancel'],
  ['❍', 'shadowed circle', 'ring'],
  ['❏', 'shadowed square', 'box'],
  ['❑', 'shadowed square outline', 'box'],
  ['❒', 'shadowed square upper right', 'box'],
  ['❓', 'question mark ornament', 'question'],
  ['❔', 'white question mark', 'question'],
  ['❕', 'white exclamation mark', 'important'],
  ['❗', 'exclamation mark ornament', 'important'],
  ['❛', 'heavy single turned comma quotation mark', 'quote'],
  ['❝', 'heavy double turned comma quotation mark', 'quote'],
  ['❞', 'heavy double comma quotation mark', 'quote'],
  ['❤', 'heavy heart', 'love'],
  ['❥', 'rotated heart', 'love'],
  ['❦', 'floral heart', 'fleuron'],
  ['❧', 'rotated floral heart', 'fleuron hedera'],
  ['➔', 'heavy wide-headed right arrow', 'next'],
  ['➙', 'heavy right arrow', 'next'],
  ['➠', 'heavy dashed triangle-headed right arrow', 'next'],
  ['➡', 'black right arrow', 'next'],
  ['⬅', 'black left arrow', 'back'],
  ['⬆', 'black up arrow', 'up'],
  ['⬇', 'black down arrow', 'down'],
  ['∞', 'infinity', 'forever endless'],
  ['≈', 'almost equal to', 'about approximately'],
  ['≠', 'not equal to', 'different'],
  ['≤', 'less than or equal to', 'at most'],
  ['≥', 'greater than or equal to', 'at least'],
  ['±', 'plus minus', 'about tolerance'],
  ['×', 'multiplication sign', 'times'],
  ['÷', 'division sign', 'divide'],
  ['∑', 'sum', 'sigma total'],
  ['∆', 'increment', 'delta change'],
  ['∅', 'empty set', 'none nothing'],
  ['∈', 'element of', 'in member'],
  ['∴', 'therefore', 'so conclusion'],
  ['∵', 'because', 'since reason'],
  ['√', 'square root', 'check radical'],
  ['∫', 'integral', 'maths'],
  ['∂', 'partial differential', 'maths'],
  ['∇', 'nabla', 'del maths'],
  ['∀', 'for all', 'every maths'],
  ['∃', 'there exists', 'maths'],
  ['¶', 'pilcrow', 'paragraph'],
  ['†', 'dagger', 'footnote obelus'],
  ['‡', 'double dagger', 'footnote'],
  ['•', 'bullet', 'dot'],
  ['‣', 'triangular bullet', 'dot'],
  ['…', 'ellipsis', 'more dots'],
  ['‰', 'per mille', 'thousand'],
  ['°', 'degree', 'temperature angle'],
  ['©', 'copyright', 'c'],
  ['®', 'registered', 'trademark r'],
  ['™', 'trade mark', 'tm'],
  ['€', 'euro', 'money currency'],
  ['£', 'pound', 'money currency sterling'],
  ['¥', 'yen', 'money currency'],
  ['¢', 'cent', 'money currency'],
  ['₹', 'rupee', 'money currency'],
  ['₿', 'bitcoin', 'money currency'],
  ['⌘', 'command', 'place of interest mac key'],
  ['⌥', 'option', 'alt mac key'],
  ['⇧', 'shift', 'key up'],
  ['⌫', 'delete', 'erase backspace key'],
  ['⏎', 'return', 'enter key'],
  ['⌛', 'hourglass', 'time wait'],
  ['⌚', 'watch', 'time'],
  ['⏱', 'stopwatch', 'time timer'],
  ['⏲', 'timer clock', 'time'],
  ['⏸', 'pause', 'wait hold'],
  ['⏹', 'stop', 'square'],
  ['⏺', 'record', 'circle'],
  ['⏭', 'next track', 'skip'],
  ['⏮', 'previous track', 'back'],
  ['⏩', 'fast forward', 'skip'],
  ['⏪', 'rewind', 'back'],
  ['⏫', 'up fast', 'priority high'],
  ['⏬', 'down fast', 'priority low'],
  ['⌖', 'position indicator', 'target'],
  ['⌂', 'house', 'home'],
  ['⌀', 'diameter', 'circle'],
  ['⎋', 'escape', 'key'],
  ['◈', 'diamond containing small diamond', 'gem'],
  ['◊', 'lozenge', 'diamond'],
  ['♀', 'female sign', 'woman'],
  ['♂', 'male sign', 'man'],
  ['⚥', 'male and female sign', ''],
  ['☉', 'sun symbol', 'astronomy'],
  ['☾', 'last quarter moon', 'night'],
  ['☽', 'first quarter moon', 'night'],
  ['✶', 'six pointed black star', 'sparkle'],
  ['✷', 'eight pointed rectilinear black star', 'sparkle'],
  ['✸', 'heavy eight pointed rectilinear black star', 'sparkle'],
  ['✹', 'twelve pointed black star', 'sparkle'],
  ['❂', 'circled open centre eight pointed star', 'sun'],
];

/** @typedef {{ glyph: string, name: string, keywords: string[], group: string }} Character */
/** @typedef {{ emoji: string, label: string, tags?: string[], group?: number, order?: number, version: number }} Emoji */

/** @param {readonly string[]} words */
const trimWords = (words) => [
  ...new Set(words.flatMap((word) => word.toLowerCase().split(/\s+/)).filter(Boolean)),
];

/** @type {Emoji[]} */
const data = JSON.parse(readFileSync(require.resolve('emojibase-data/en/data.json'), 'utf8'));
/** @type {{ groups: Record<string, string> }} */
const groups = JSON.parse(readFileSync(require.resolve('emojibase-data/meta/groups.json'), 'utf8'));
/** @type {Record<string, string>} */
const GROUP_NAMES = {
  'smileys-emotion': 'Smileys and Emotion',
  'people-body': 'People',
  'animals-nature': 'Animals and Nature',
  'food-drink': 'Food and Drink',
  'travel-places': 'Travel and Places',
  activities: 'Activities',
  objects: 'Objects',
  symbols: 'Symbols',
  flags: 'Flags',
};
/** @param {number | undefined} group */
const groupName = (group) =>
  group === undefined ? undefined : GROUP_NAMES[groups.groups[String(group)] ?? ''];

/** The emoji, by their glyph without variation selectors, in emojibase's order. */
/** @type {Map<string, Character>} */
const emoji = new Map();
for (const each of data.sort((a, b) => (a.order ?? 1e9) - (b.order ?? 1e9))) {
  const group = groupName(each.group);
  if (!group || each.version > NEWEST_EMOJI) continue;
  emoji.set(glyphKey(each.emoji), {
    glyph: each.emoji,
    name: each.label.toLowerCase(),
    keywords: trimWords(each.tags ?? []),
    group,
  });
}

/** @type {Character[]} */
const characters = [];
const seen = new Set();
/** @type {string[]} */
const refused = [];
/** @param {Character} entry */
const add = (entry) => {
  const key = glyphKey(entry.glyph);
  if (seen.has(key)) return;
  if (glyphProblem(entry.glyph)) {
    refused.push(entry.glyph);
    return;
  }
  seen.add(key);
  // Words in the name are found already; keep the others.
  const nameWords = new Set(entry.name.split(/\s+/));
  characters.push({
    glyph: entry.glyph,
    name: entry.name,
    // Eight words at most: enough to find it by, and the file stays small.
    keywords: entry.keywords.filter((word) => !nameWords.has(word)).slice(0, 8),
    group: entry.group,
  });
};
/** @type {Map<string, readonly [string, string, string]>} */
const named = new Map(SYMBOLS.map((symbol) => [glyphKey(symbol[0]), symbol]));
for (const preset of SYMBOL_GLYPH_PRESETS) {
  const own = named.get(glyphKey(preset));
  const fromEmoji = emoji.get(glyphKey(preset));
  if (own) add({ glyph: preset, name: own[1], keywords: trimWords([own[2]]), group: 'Symbols' });
  else if (fromEmoji) add({ ...fromEmoji, glyph: preset, group: 'Symbols' });
  else throw new Error(`No name for the preset ${preset}`);
}
for (const [glyph, name, words] of SYMBOLS) {
  add({ glyph, name, keywords: trimWords([words]), group: 'Symbols' });
}
for (const entry of emoji.values()) add(entry);

const out = join(root, 'packages/core/data/characters.json');
// One character a line: small diffs when the data changes.
writeFileSync(out, `[\n${characters.map((each) => JSON.stringify(each)).join(',\n')}\n]\n`);
console.log(`${characters.length} characters written to ${out}`);
console.log(`${refused.length} refused by the glyph rules: ${refused.join(' ')}`);
