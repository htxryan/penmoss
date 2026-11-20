// @ts-check
/**
 * ESLint rule `penmoss/tracked-control` (PEN-137, PEN-175): every control a person can use in the
 * page is counted by name, by its own id. A control either runs a command
 * (`data-command="<command id>"`, counted once by its run) or carries a tracked id
 * (`data-event="<area>.<thing>"`, recorded by the one listener, `apps/web/src/analytics/track.ts`:
 * a click, or a select's or a slider's change). The catalogue test
 * (`apps/web/test/unit/analytics-catalogue.test.ts`) then checks each id is in the catalogue and
 * not one of the retired generic ids. The runtime audit (`apps/web/test/e2e/tracked-controls.spec.ts`)
 * checks the same things in the running page, for what JSX can't show (the editor's widgets).
 *
 * Reported, on an element written in JSX (a component's own `<button>` too):
 * - a `<button>`, a `<summary>`, a `<select>`, every `<a>` (a plain link too), and an
 *   `<input type="checkbox|radio|range">` (its `<label>` may carry the id instead);
 * - any element with an interactive role (`button`, `link`, `menuitem`, `menuitemcheckbox`,
 *   `menuitemradio`, `tab`, `switch`, `checkbox`, `radio`, `option`, `treeitem`, `slider`)
 * that has none of `data-command`, `data-event` or `data-untracked`.
 *
 * Also reported: each call of one of the app's wrappers (the rule's `wrappers` option, set in
 * eslint.config.js: `Menu`, `MenuItem`, `Switch`, …) without one of its id props, since its own
 * element passes the id on and no longer has a generic one to fall back to. A wrapper with
 * `items` (the first run's `Options`) needs the id on each item written in its array.
 *
 * Also reported: a literal `data-event` id that isn't `^[a-z][a-z0-9-]*(\.[a-z0-9-]+){1,4}$`,
 * and an id built in a template literal (an id is never built from data). An id may be an
 * expression that picks a literal (`data-event={on ? 'x.on' : 'x.off'}`) or a component's prop
 * passed on (`data-event={event}`) whose callers write literals.
 *
 * Something that is not a control a person uses (a drag handle with no click, an inert preview)
 * says why, in at least three words written out: `data-untracked="a drag handle, no click"`.
 * A shorter reason, or one that isn't written out, is reported. The rule is never turned off
 * with an eslint-disable comment: the catalogue test fails on one.
 */

const ID_PATTERN = /^[a-z][a-z0-9-]*(\.[a-z0-9-]+){1,4}$/;
const ROLES = new Set([
  'button',
  'link',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'tab',
  'switch',
  'checkbox',
  'radio',
  'option',
  'treeitem',
  'slider',
]);
const INPUTS = new Set(['checkbox', 'radio', 'range']);
/** A reason not to track: at least three words. */
const REASON_WORDS = 3;

/**
 * @param {any} node a JSXOpeningElement
 * @param {string} name
 */
function attribute(node, name) {
  return node.attributes.find(
    (/** @type {any} */ each) =>
      each.type === 'JSXAttribute' && each.name.type === 'JSXIdentifier' && each.name.name === name,
  );
}

/**
 * An expression's string when it is one written out, else undefined.
 * @param {any} expression
 */
function stringOf(expression) {
  if (expression?.type === 'Literal' && typeof expression.value === 'string') {
    return expression.value;
  }
  if (expression?.type === 'TemplateLiteral' && expression.expressions.length === 0) {
    return expression.quasis[0]?.value.cooked ?? undefined;
  }
  return undefined;
}

/**
 * An attribute's value when it is a string written out, else undefined.
 * @param {any} attr
 */
function literal(attr) {
  const value = attr?.value;
  if (!value) return undefined;
  if (value.type === 'Literal' && typeof value.value === 'string') return value.value;
  if (value.type === 'JSXExpressionContainer') return stringOf(value.expression);
  return undefined;
}

/**
 * The strings an attribute may be: one written out, or each branch of `a ? 'x' : 'y'`.
 * @param {any} attr
 * @returns {string[]}
 */
function literals(attr) {
  const value = attr?.value;
  if (!value) return [];
  if (value.type === 'Literal' && typeof value.value === 'string') return [value.value];
  if (value.type !== 'JSXExpressionContainer') return [];
  /** @type {string[]} */
  const found = [];
  /** @param {any} expression */
  const walk = (expression) => {
    if (expression?.type === 'ConditionalExpression') {
      walk(expression.consequent);
      walk(expression.alternate);
      return;
    }
    if (expression?.type === 'LogicalExpression') {
      walk(expression.right);
      return;
    }
    const text = stringOf(expression);
    if (text !== undefined) found.push(text);
  };
  walk(value.expression);
  return found;
}

/** @param {any} node a JSXOpeningElement */
function tagOf(node) {
  return node.name.type === 'JSXIdentifier' ? node.name.name : undefined;
}

/**
 * The marks that say what a control is: a command, an id, or a reason it isn't one.
 * @param {any} node a JSXOpeningElement
 */
function marked(node) {
  return (
    attribute(node, 'data-command') !== undefined ||
    attribute(node, 'data-event') !== undefined ||
    attribute(node, 'data-untracked') !== undefined
  );
}

/**
 * A native input's `<label>` around it, when that label carries the mark instead.
 * @param {any} node a JSXOpeningElement
 */
function labelMarked(node) {
  let at = node.parent?.parent;
  while (at && (at.type === 'JSXElement' || at.type === 'JSXFragment')) {
    if (at.type === 'JSXElement' && tagOf(at.openingElement) === 'label') {
      return marked(at.openingElement);
    }
    at = at.parent;
  }
  return false;
}

/** @param {any} node a JSXOpeningElement */
function isControl(node) {
  const tag = tagOf(node);
  if (!tag || !/^[a-z]/.test(tag)) return false;
  if (tag === 'button' || tag === 'summary' || tag === 'select' || tag === 'a') return true;
  if (tag === 'input') {
    return literals(attribute(node, 'type')).some((type) => INPUTS.has(type));
  }
  return literals(attribute(node, 'role')).some((role) => ROLES.has(role));
}

/**
 * @typedef {{ name: string, props: string[], items?: string }} Wrapper
 * One of the app's components that draws a control from an id it is given: `props` are the
 * props any one of which names the id; with `items`, the id is on each object of that array.
 */

/**
 * The object properties' names, or null when the object may hold any (a spread).
 * @param {any} object an ObjectExpression
 */
function keysOf(object) {
  /** @type {Set<string>} */
  const keys = new Set();
  for (const property of object.properties) {
    if (property.type !== 'Property') return null;
    const key = property.key;
    if (key.type === 'Identifier') keys.add(key.name);
    else if (key.type === 'Literal') keys.add(String(key.value));
  }
  return keys;
}

/** @type {import('eslint').Rule.RuleModule} */
export const trackedControl = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Every control has its own data-command or data-event id, or a data-untracked reason, so it is counted by name (PEN-137, PEN-175).',
    },
    messages: {
      untracked:
        '<{{ tag }}> is a control without data-command or data-event: give it its own data-event="<area>.<thing>" (and add the id to CLICK_NAMES in packages/core/src/analytics/catalogue.ts), data-command="<command id>" if it runs one, or data-untracked="<why it is not a control, in three words or more>".',
      wrapper:
        '<{{ name }}> draws a control and has no id of its own: give it {{ props }} (and add the id to CLICK_NAMES in packages/core/src/analytics/catalogue.ts).',
      item: "Each of <{{ name }}>'s {{ items }} draws a control: give it its own {{ props }} (and add the id to CLICK_NAMES).",
      reason:
        'data-untracked needs a reason written out, three words or more: why this is not a control a person uses.',
      badId:
        'data-event "{{ id }}" is not an event id (lower case, dotted: ^[a-z][a-z0-9-]*(\\.[a-z0-9-]+){1,4}$).',
      built:
        'data-event is built in a template: an id is never built from data. Pick a literal (a ? "x.on" : "x.off") or a constant.',
    },
    schema: [
      {
        type: 'object',
        properties: {
          wrappers: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                props: { type: 'array', items: { type: 'string' }, minItems: 1 },
                items: { type: 'string' },
              },
              required: ['name', 'props'],
              additionalProperties: false,
            },
          },
        },
        additionalProperties: false,
      },
    ],
  },
  create(context) {
    /** @type {Wrapper[]} */
    const wrappers = context.options[0]?.wrappers ?? [];
    const byName = new Map(wrappers.map((each) => [each.name, each]));

    /**
     * @param {any} node a JSXOpeningElement
     * @param {Wrapper} wrapper
     */
    function checkWrapper(node, wrapper) {
      const props = wrapper.props.join(' or ');
      if (wrapper.items) {
        const items = attribute(node, wrapper.items);
        const array =
          items?.value?.type === 'JSXExpressionContainer' ? items.value.expression : null;
        if (array?.type !== 'ArrayExpression') return;
        for (const element of array.elements) {
          if (element?.type !== 'ObjectExpression') continue;
          const keys = keysOf(element);
          if (keys === null) continue;
          if (!wrapper.props.some((prop) => keys.has(prop))) {
            context.report({
              node: element,
              messageId: 'item',
              data: { name: wrapper.name, items: wrapper.items, props },
            });
          }
        }
        return;
      }
      if (attribute(node, 'data-untracked')) return;
      if (wrapper.props.some((prop) => attribute(node, prop) !== undefined)) return;
      context.report({ node, messageId: 'wrapper', data: { name: wrapper.name, props } });
    }

    return {
      JSXOpeningElement(node) {
        const reason = attribute(node, 'data-untracked');
        if (reason) {
          const text = literal(reason);
          if (
            text === undefined ||
            text.trim().split(/\s+/).filter(Boolean).length < REASON_WORDS
          ) {
            context.report({ node: reason, messageId: 'reason' });
          }
        }
        const event = attribute(node, 'data-event');
        if (event) {
          const id = literal(event);
          if (id !== undefined && !ID_PATTERN.test(id)) {
            context.report({ node: event, messageId: 'badId', data: { id } });
          }
          const expression =
            event.value?.type === 'JSXExpressionContainer' ? event.value.expression : null;
          if (expression?.type === 'TemplateLiteral' && expression.expressions.length > 0) {
            context.report({ node: event, messageId: 'built' });
          }
        }
        const tag = tagOf(node);
        const wrapper = tag === undefined ? undefined : byName.get(tag);
        if (wrapper) {
          checkWrapper(node, wrapper);
          return;
        }
        if (marked(node)) return;
        if (!isControl(node)) return;
        if (tag === 'input' && labelMarked(node)) return;
        context.report({ node, messageId: 'untracked', data: { tag: tag ?? '' } });
      },
    };
  },
};
