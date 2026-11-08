import { getSchema } from '@tiptap/core';
import type { Schema } from '@tiptap/pm/model';
import { noteExtensions } from './extensions';

let built: Schema | null = null;

/** The note editor's ProseMirror schema, as the app builds it (T6, A9). */
export function editorSchema(): Schema {
  built ??= getSchema(noteExtensions());
  return built;
}
