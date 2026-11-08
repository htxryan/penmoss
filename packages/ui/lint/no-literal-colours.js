// @ts-check
/**
 * ESLint rule `penmoss/no-literal-colours` (T28, A244, A252): UI code takes
 * every colour from a theme token (`var(--pm-…)`), never a literal.
 * Stylesheets get the same rule from stylelint (stylelint.config.js).
 *
 * Reported:
 * - a hex colour anywhere in a string or template (`'#fff'`, `'1px solid #ccc'`,
 *   `` `.x{color:#fff}` ``), unless the string is a link, a path or an anchor;
 * - a colour function anywhere in a string: `rgb(…)`, `hsl(…)`, `oklch(…)`…;
 * - a CSS named colour (`white`, `navy`) where a colour goes: a JSX `style`,
 *   an SVG colour attribute (`fill`, `stroke`, `stop-color`, `color`,
 *   `flood-color`, `lighting-color`, literal or `{…}`), `el.style.x = …`,
 *   `style.setProperty(…)`, `cssText`, a canvas `fillStyle`/`strokeStyle`
 *   (also `ctx['fillStyle']`), `setAttribute`/d3 `.attr` of a colour attribute,
 *   d3 `.style(…)`, an object key that names a colour (`color`, `fill`,
 *   `backgroundColor`, `primaryColor`: style objects held in variables),
 *   anything under Mermaid's `themeVariables`, and CSS text (`{ color: … }`).
 *
 * Left alone: `transparent`, `currentColor`, system colours (Canvas,
 * CanvasText), `color-mix()` over tokens, other JSX attributes (`aria-label`,
 * `href='#abc'`), and colour words outside colours (`label: 'white'`).
 */

const HEX_WHOLE = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const HEX_ANY = /(?:^|[\s,(:])#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})(?![0-9a-z_-])/i;
const COLOUR_FUNCTION = /(?:^|[^\w-])(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|device-cmyk)\(/i;

/** The CSS named colours (CSS Color 4), without transparent and currentColor. */
const NAMED = new Set(
  (
    'aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue ' +
    'blueviolet brown burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk ' +
    'crimson cyan darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki ' +
    'darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen ' +
    'darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue ' +
    'dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite ' +
    'gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki ' +
    'lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan ' +
    'lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen ' +
    'lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen ' +
    'magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen ' +
    'mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream ' +
    'mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid ' +
    'palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum ' +
    'powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown ' +
    'seagreen seashell sienna silver skyblue slateblue slategray slategrey snow springgreen ' +
    'steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen'
  ).split(' '),
);

/** @param {string} text */
function hasNamedColour(text) {
  // Words outside var(--…) names: `1px solid navy`, but not `--pm-red-ish` or `white-space`.
  for (const match of text.matchAll(/(?<![\w-])[a-z]+(?![\w-])/gi)) {
    if (NAMED.has(match[0].toLowerCase())) return true;
  }
  return false;
}

/** A link, a path or a query: `#abc` in it is an anchor, not a colour. */
const URL_LIKE = /^(?:[a-z][a-z0-9+.-]*:\/\/|mailto:|\/|\.\.?\/|\?)/i;
/** CSS text: a declaration after `{` or `;`. */
const CSS_TEXT = /[{;]\s*-?[a-z][a-z-]*\s*:/i;

/**
 * @param {string} text
 * @param {'style' | 'url' | 'plain'} where
 */
function isLiteralColour(text, where) {
  if (where === 'url') return false;
  const trimmed = text.trim();
  if (URL_LIKE.test(trimmed)) return false;
  if (HEX_WHOLE.test(trimmed) || COLOUR_FUNCTION.test(trimmed) || HEX_ANY.test(trimmed)) {
    return true;
  }
  return (where === 'style' || CSS_TEXT.test(trimmed)) && hasNamedColour(trimmed);
}

const STYLE_PROPERTIES = new Set(['fillStyle', 'strokeStyle', 'shadowColor', 'cssText']);
/** SVG and HTML attributes that take a colour. */
const COLOUR_ATTRIBUTES = new Set([
  'fill',
  'stroke',
  'color',
  'stop-color',
  'stopColor',
  'flood-color',
  'floodColor',
  'lighting-color',
  'lightingColor',
  'bgcolor',
]);
/** Names whose value is a link or an anchor. */
const URL_NAMES = new Set([
  'href',
  'src',
  'to',
  'hash',
  'url',
  'action',
  'xlinkHref',
  'xlink:href',
]);
/** Object keys that name a colour: `color`, `fill`, `backgroundColor`, `primaryColor`, `mainBkg`. */
const COLOUR_KEY =
  /^(?:colou?r|fill|stroke|background|bg|stop-?color|flood-?color)$|(?:Colou?r|Bkg|Fill|Stroke)$/;

/**
 * A property's or member's name, when it is written out.
 * @param {any} key
 * @param {boolean} computed
 */
function nameOf(key, computed) {
  if (!key) return '';
  if (key.type === 'Identifier' && !computed) return key.name;
  if (key.type === 'Literal' && typeof key.value === 'string') return key.value;
  if (key.type === 'JSXIdentifier') return key.name;
  if (key.type === 'JSXNamespacedName') return `${key.namespace.name}:${key.name.name}`;
  return '';
}

/**
 * Where a string goes: into a colour (`style`), a link (`url`), a JSX attribute
 * that is not a colour (`skip`), or anywhere else (`plain`).
 * @param {any} node
 * @returns {'style' | 'url' | 'skip' | 'plain'}
 */
function placeOf(node) {
  /** @type {any} */
  let child = node;
  let parent = node.parent;
  // A template literal's parts, `a ? 'x' : 'y'`, `a || 'x'` and `{…}` carry the context up.
  while (
    parent &&
    (parent.type === 'TemplateLiteral' ||
      parent.type === 'ConditionalExpression' ||
      parent.type === 'LogicalExpression' ||
      parent.type === 'TSAsExpression' ||
      parent.type === 'JSXExpressionContainer')
  ) {
    child = parent;
    parent = parent.parent;
  }
  if (!parent) return 'plain';
  // <path fill="#3f7d4e" />, <div style="color: red" />; other attributes are not colours.
  if (parent.type === 'JSXAttribute') {
    const name = nameOf(parent.name, false);
    return name === 'style' || COLOUR_ATTRIBUTES.has(name) ? 'style' : 'skip';
  }
  // el.style.color = '…', ctx.fillStyle = '…', ctx['fillStyle'] = '…', a.href = '#…'
  if (parent.type === 'AssignmentExpression' && parent.right === child) {
    const target = parent.left;
    if (target.type !== 'MemberExpression') return 'plain';
    const owner = target.object;
    const name = nameOf(target.property, target.computed);
    if (owner.type === 'MemberExpression' && nameOf(owner.property, owner.computed) === 'style') {
      return 'style';
    }
    if (STYLE_PROPERTIES.has(name)) return 'style';
    return URL_NAMES.has(name) ? 'url' : 'plain';
  }
  // style.setProperty('--x', '…'), el.setAttribute('fill', '…'), d3 .attr(…) and .style(…)
  if (parent.type === 'CallExpression' && parent.arguments.includes(child)) {
    const callee = parent.callee;
    const method =
      callee.type === 'MemberExpression' ? nameOf(callee.property, callee.computed) : '';
    const second = parent.arguments[1] === child;
    if (method === 'setProperty') return 'style';
    if (method === 'style' && second) return 'style';
    if ((method === 'setAttribute' || method === 'attr') && second) {
      const attribute = nameOf(parent.arguments[0], false);
      if (attribute === 'style' || COLOUR_ATTRIBUTES.has(attribute)) return 'style';
      if (URL_NAMES.has(attribute) || attribute === 'id') return 'url';
    }
    return 'plain';
  }
  // { color: '…' } in a JSX style, a style object, a colour key, Mermaid's themeVariables
  if (parent.type === 'Property' && parent.value === child) {
    const key = nameOf(parent.key, parent.computed);
    const object = parent.parent;
    const container = object?.parent;
    if (container?.type === 'JSXExpressionContainer') {
      const attribute = container.parent;
      if (attribute?.type === 'JSXAttribute' && nameOf(attribute.name, false) === 'style') {
        return 'style';
      }
    }
    if (
      container?.type === 'Property' &&
      nameOf(container.key, container.computed) === 'themeVariables'
    ) {
      return 'style';
    }
    if (COLOUR_KEY.test(key)) return 'style';
    return URL_NAMES.has(key) ? 'url' : 'plain';
  }
  return 'plain';
}

/** @type {import('eslint').Rule.RuleModule} */
export const noLiteralColours = {
  meta: {
    type: 'problem',
    docs: { description: 'Forbid literal colours in UI code; use theme tokens (T28).' },
    messages: {
      literal:
        'Literal colour “{{ text }}”: use a theme token (var(--pm-…)); colours live in packages/ui/src/theme/builtins.ts.',
    },
    schema: [],
  },
  create(context) {
    /**
     * @param {any} node
     * @param {string} text
     */
    const check = (node, text) => {
      const where = placeOf(node);
      if (where !== 'skip' && isLiteralColour(text, where)) {
        context.report({ node, messageId: 'literal', data: { text: text.slice(0, 40) } });
      }
    };
    return {
      Literal(node) {
        if (typeof node.value !== 'string') return;
        const parent = node.parent?.type;
        if (parent === 'ImportDeclaration' || parent?.startsWith('Export')) return;
        check(node, node.value);
      },
      TemplateLiteral(node) {
        check(node, node.quasis.map((quasi) => quasi.value.cooked ?? '').join(' '));
      },
    };
  },
};

export const penmossLintPlugin = { rules: { 'no-literal-colours': noLiteralColours } };
