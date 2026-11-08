/**
 * The JSON Schema subset the MCP tools declare (T25), and a checker for it.
 * Tool arguments are checked against the very schema `tools/list` sends, by
 * a few dozen lines rather than a schema library: a call costs microseconds
 * of the Worker's 10 ms of CPU (D20), and the deeper checks (sizes, ids,
 * tags) are the REST API's own (agents/commands.ts).
 */
export type Schema =
  | {
      readonly type: 'string';
      readonly description?: string;
      readonly enum?: readonly string[];
      readonly maxLength?: number;
    }
  | {
      readonly type: 'integer';
      readonly description?: string;
      readonly minimum?: number;
      readonly maximum?: number;
    }
  | { readonly type: 'boolean'; readonly description?: string }
  | {
      readonly type: 'array';
      readonly description?: string;
      readonly items: Schema;
      readonly maxItems?: number;
    }
  /** A string or null (`folderId: null` is the top level). */
  | { readonly type: readonly ['string', 'null']; readonly description?: string }
  /** Any JSON object, whose keys and values the REST checks decide (`set_settings`, T42). */
  | { readonly type: 'object'; readonly description?: string };

export interface ObjectSchema {
  readonly type: 'object';
  readonly properties: Readonly<Record<string, Schema>>;
  readonly required?: readonly string[];
  readonly additionalProperties: false;
}

/**
 * `args` checked against `schema`: the arguments to run with, or the first
 * problem as a sentence an agent can act on. A null for an optional argument
 * reads as left out (agents often send one), unless the schema allows null.
 */
export function checkArguments(
  schema: ObjectSchema,
  args: unknown,
): { readonly args: Record<string, unknown> } | { readonly problem: string } {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    return { problem: 'arguments must be an object' };
  }
  // Own keys only, and no prototype to write through: a `__proto__` or
  // `constructor` argument is unknown, never Object.prototype or Object (A154).
  const checked: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const [key, value] of Object.entries(args as Record<string, unknown>)) {
    const property = Object.hasOwn(schema.properties, key) ? schema.properties[key] : undefined;
    if (!property) {
      const known = Object.keys(schema.properties).join(', ');
      return { problem: `unknown argument ${key} (expected ${known || 'none'})` };
    }
    if (value === undefined || (value === null && !Array.isArray(property.type))) continue;
    const problem = checkValue(property, value, key);
    if (problem) return { problem };
    checked[key] = value;
  }
  for (const key of schema.required ?? []) {
    if (!Object.hasOwn(checked, key)) return { problem: `${key} is required` };
  }
  return { args: checked };
}

function checkValue(schema: Schema, value: unknown, name: string): string | null {
  if (Array.isArray(schema.type)) {
    return value === null || typeof value === 'string' ? null : `${name} must be a string or null`;
  }
  switch (schema.type) {
    case 'string': {
      if (typeof value !== 'string') return `${name} must be a string`;
      if (schema.enum && !schema.enum.includes(value)) {
        return `${name} must be one of ${schema.enum.join(', ')}`;
      }
      if (schema.maxLength !== undefined && value.length > schema.maxLength) {
        return `${name} must be at most ${schema.maxLength} characters`;
      }
      return null;
    }
    case 'integer': {
      if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
        return `${name} must be a whole number`;
      }
      if (schema.minimum !== undefined && value < schema.minimum) {
        return `${name} must be at least ${schema.minimum}`;
      }
      if (schema.maximum !== undefined && value > schema.maximum) {
        return `${name} must be at most ${schema.maximum}`;
      }
      return null;
    }
    case 'boolean':
      return typeof value === 'boolean' ? null : `${name} must be true or false`;
    case 'array': {
      if (!Array.isArray(value)) return `${name} must be a list`;
      if (schema.maxItems !== undefined && value.length > schema.maxItems) {
        return `${name} must have at most ${schema.maxItems} items`;
      }
      for (const item of value) {
        const problem = checkValue(schema.items, item, `each item of ${name}`);
        if (problem) return problem;
      }
      return null;
    }
    case 'object':
      return typeof value === 'object' && value !== null && !Array.isArray(value)
        ? null
        : `${name} must be an object`;
    default:
      return null;
  }
}
