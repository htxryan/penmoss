/**
 * The phone's formatting bar's buttons (T36), each the editor command it runs and its icon. Plain
 * data, free of React, so the usage dashboard's session player (PEN-178) draws the same bar.
 */
import type { IconName } from '@penmoss/ui/icons';

export const PHONE_FORMAT_BUTTONS: ReadonlyArray<{
  readonly command: string;
  readonly icon: IconName;
}> = [
  { command: 'editor.bold', icon: 'bold' },
  { command: 'editor.italic', icon: 'italic' },
  { command: 'editor.bulletList', icon: 'list' },
  { command: 'editor.taskList', icon: 'checklist' },
  { command: 'editor.code', icon: 'code' },
  { command: 'editor.link', icon: 'link' },
  { command: 'editor.undo', icon: 'undo' },
  { command: 'editor.redo', icon: 'redo' },
];
