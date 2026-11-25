// @ts-check
/**
 * `penmoss/type-tokens` (A1561): a stylesheet's text sizes, weights and line heights come from
 * the type roles and scale in apps/web/src/shell/type.css, never written out. A value passes
 * when, once its `var(…)`s are taken out, nothing is left but `calc()`'s arithmetic or one of
 * the keywords below; a number, a length or a size keyword (`small`, `bold`) fails. The `font`
 * shorthand may only be `inherit`: write the longhands, each with its token. type.css itself is
 * where the values are written, so stylelint.config.js turns the rule off there.
 */
import stylelint from 'stylelint';

const {
  createPlugin,
  utils: { report, ruleMessages, validateOptions },
} = stylelint;

export const ruleName = 'penmoss/type-tokens';

const messages = ruleMessages(ruleName, {
  raw: (/** @type {string} */ property, /** @type {string} */ value) =>
    `"${property}: ${value}" writes a value out: use a type role or step from apps/web/src/shell/type.css, such as var(--pm-text-help) (A1561)`,
  shorthand: (/** @type {string} */ value) =>
    `"font: ${value}" sets a size, weight or line height: write font-family and the longhands, each with a token from apps/web/src/shell/type.css (A1561)`,
});

/** What each property may say besides tokens. */
const KEYWORDS = /** @type {const} */ ({
  'font-size': ['inherit'],
  'font-weight': ['inherit'],
  // 0 drops an inline box's line (an image's frame), which is layout, not type.
  'line-height': ['inherit', 'normal', '0'],
  font: ['inherit'],
});

/** The value without its `var(…)`s, fallbacks and all. */
function withoutVars(/** @type {string} */ value) {
  let out = '';
  let index = 0;
  while (index < value.length) {
    if (value.startsWith('var(', index)) {
      let depth = 0;
      for (; index < value.length; index += 1) {
        if (value[index] === '(') depth += 1;
        else if (value[index] === ')' && (depth -= 1) === 0) break;
      }
      index += 1;
      continue;
    }
    out += value[index];
    index += 1;
  }
  return out;
}

/** Whether `value` names only tokens (and `calc()` over them) or an allowed keyword. */
export function isTokenValue(
  /** @type {keyof typeof KEYWORDS} */ property,
  /** @type {string} */ value,
) {
  const trimmed = value.trim().toLowerCase();
  if (/** @type {readonly string[]} */ (KEYWORDS[property]).includes(trimmed)) return true;
  if (!trimmed.includes('var(')) return false;
  const rest = withoutVars(trimmed)
    .replace(/calc\(/g, '')
    .replace(/[()*/+\s-]/g, '');
  return rest === '';
}

/** @type {import('stylelint').Rule} */
const rule = (primary) => (root, result) => {
  if (!validateOptions(result, ruleName, { actual: primary, possible: [true] })) return;
  root.walkDecls(/^(font-size|font-weight|line-height|font)$/i, (decl) => {
    const property = /** @type {keyof typeof KEYWORDS} */ (decl.prop.toLowerCase());
    if (isTokenValue(property, decl.value)) return;
    report({
      ruleName,
      result,
      node: decl,
      message:
        property === 'font' ? messages.shorthand(decl.value) : messages.raw(property, decl.value),
      word: decl.value,
    });
  });
};
rule.ruleName = ruleName;
rule.messages = messages;

export const typeTokens = createPlugin(ruleName, rule);
