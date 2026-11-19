// @ts-check
/**
 * ESLint rule `penmoss/tracked-control` (PEN-137): every control a person can click in the page
 * is counted by name. A control either runs a command (`data-command="<command id>"`, counted
 * once by its run) or carries a tracked id (`data-event="<area>.<thing>"`, recorded by the one
 * click listener, `apps/web/src/analytics/track.ts`). The catalogue test
 * (`apps/web/test/unit/analytics-catalogue.test.ts`) then checks each id is in the catalogue.
 *
 * Reported, on an element written in JSX (a component's own `<button>` too):
 * - a `<button>`, a `<summary>`, and an `<input type="checkbox|radio">`;
 * - an `<a>` with an `onClick` (a plain link is a navigation, counted by its screen);
 * - any element with a click handler and an interactive role (`button`, `menuitem`,
 *   `menuitemcheckbox`, `menuitemradio`, `tab`, `switch`, `checkbox`, `radio`)
 * that has neither `data-command` nor `data-event`.
 *
 * Also reported: a literal `data-event` id that isn't `^[a-z][a-z0-9-]*(\.[a-z0-9-]+){1,4}$`,
 * and an id built in a template literal (an id is never built from data). An id may be an
 * expression that picks a literal (`data-event={on ? 'x.on' : 'x.off'}`) or a component's prop
 * passed on (`data-event={event}`) whose callers write literals.
 *
 * A control that is not one (a `<button>` that only hosts a drag handle, say) says why:
 * `// eslint-disable-next-line penmoss/tracked-control -- <why it is not a tracked control>`.
 */

const ID_PATTERN = /^[a-z][a-z0-9-]*(\.[a-z0-9-]+){1,4}$/;
const ROLES = new Set([
  'button',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'tab',
  'switch',
  'checkbox',
  'radio',
]);
const CLICKS = new Set(['onClick', 'onMouseDown', 'onPointerDown', 'onMouseUp', 'onPointerUp']);

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
 * An attribute's value when it is a string written out, else undefined.
 * @param {any} attr
 */
function literal(attr) {
  const value = attr?.value;
  if (!value) return undefined;
  if (value.type === 'Literal' && typeof value.value === 'string') return value.value;
  if (value.type === 'JSXExpressionContainer') {
    const expression = value.expression;
    if (expression.type === 'Literal' && typeof expression.value === 'string') {
      return expression.value;
    }
    if (expression.type === 'TemplateLiteral' && expression.expressions.length === 0) {
      return expression.quasis[0]?.value.cooked ?? undefined;
    }
  }
  return undefined;
}

/** @param {any} node a JSXOpeningElement */
function isControl(node) {
  if (node.name.type !== 'JSXIdentifier') return false;
  const tag = node.name.name;
  if (!/^[a-z]/.test(tag)) return false;
  if (tag === 'button' || tag === 'summary') return true;
  const clickable = node.attributes.some(
    (/** @type {any} */ each) =>
      each.type === 'JSXAttribute' &&
      each.name.type === 'JSXIdentifier' &&
      CLICKS.has(each.name.name),
  );
  if (tag === 'a') return clickable;
  if (tag === 'input') {
    const type = literal(attribute(node, 'type'));
    return type === 'checkbox' || type === 'radio';
  }
  const role = literal(attribute(node, 'role'));
  return clickable && role !== undefined && ROLES.has(role);
}

/** @type {import('eslint').Rule.RuleModule} */
export const trackedControl = {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Every clickable control has a data-command or a data-event id, so it is counted by name (PEN-137).',
    },
    messages: {
      untracked:
        '<{{ tag }}> is a control without data-command or data-event: give it data-event="<area>.<thing>" (and add the id to CLICK_NAMES in packages/core/src/analytics/catalogue.ts), or data-command="<command id>" if it runs one.',
      badId:
        'data-event "{{ id }}" is not an event id (lower case, dotted: ^[a-z][a-z0-9-]*(\\.[a-z0-9-]+){1,4}$).',
      built:
        'data-event is built in a template: an id is never built from data. Pick a literal (a ? "x.on" : "x.off") or a constant.',
    },
    schema: [],
  },
  create(context) {
    return {
      JSXOpeningElement(node) {
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
          return;
        }
        if (attribute(node, 'data-command')) return;
        if (!isControl(node)) return;
        const name = /** @type {any} */ (node).name;
        context.report({ node, messageId: 'untracked', data: { tag: name.name } });
      },
    };
  },
};
