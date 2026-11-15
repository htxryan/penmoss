/**
 * The icon picker (A1568) from its own chunk: what opens it (a badge's Choose Icon…, a symbol's
 * glyph) keeps the page's first load as it was, and the picker comes in as it opens.
 */
import { lazy, Suspense, type ComponentProps } from 'react';
import type { IconPicker } from './IconPicker';

const Picker = lazy(() =>
  import('./IconPicker').then((module) => ({ default: module.IconPicker })),
);

export function IconPickerDialog(props: ComponentProps<typeof IconPicker>) {
  return (
    <Suspense fallback={null}>
      <Picker {...props} />
    </Suspense>
  );
}
