/**
 * Node types the editor does not know (A158). The Yjs binding throws on a
 * node type missing from the editor's schema, and would write its own
 * rendering back over anything it could not show, so a note holding one
 * (written by a later version of Penmoss) is never bound: the app shows it
 * read-only instead, and the content stays as it is for the version that
 * knows it. Core's own types always open: the editor has every one (A157).
 */
import type { Schema } from '@tiptap/pm/model';

export class UnsupportedContentError extends Error {
  /** The unknown node types, sorted. */
  readonly nodeTypes: readonly string[];

  constructor(nodeTypes: readonly string[]) {
    super(`This note holds content this version of Penmoss cannot show (${nodeTypes.join(', ')})`);
    this.name = 'UnsupportedContentError';
    this.nodeTypes = nodeTypes;
  }
}

/**
 * A deep delta as lib0 builds it (a whole body, or a change to one): a node
 * (`name`, absent for the root) and its child operations.
 */
export interface DeltaNode {
  readonly name?: unknown;
  readonly children: Iterable<DeltaOp>;
}

interface DeltaOp {
  readonly type: string;
  readonly insert?: unknown;
  readonly value?: unknown;
}

const isDeltaNode = (value: unknown): value is DeltaNode =>
  typeof value === 'object' && value !== null && 'children' in value;

/**
 * The node types a deep delta names (a whole body, or a change to one: its
 * inserts and the nodes it modifies) that `schema` lacks, sorted. Walks the
 * delta itself: a whole note's JSON copy cost more than the walk (T31).
 */
export function unknownNodeTypes(delta: DeltaNode, schema: Schema): string[] {
  const found = new Set<string>();
  const walk = (node: DeltaNode) => {
    if (typeof node.name === 'string' && !Object.hasOwn(schema.nodes, node.name)) {
      found.add(node.name);
    }
    for (const op of node.children) {
      if (op.type === 'insert' && Array.isArray(op.insert)) {
        for (const child of op.insert as unknown[]) {
          if (isDeltaNode(child)) walk(child);
        }
      } else if (op.type === 'modify' && isDeltaNode(op.value)) {
        walk(op.value);
      }
    }
  };
  walk(delta);
  return [...found].sort();
}
