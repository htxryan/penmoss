/** The replay frame's dialogs (PEN-178): the pickers, Search, a confirmation and the rest. */
import { displayName } from '../../names';
import { loremOf } from '../lorem';
import type { FrameDialog } from '../state';
import { PICKERS, type Attr, h, text, loremName, type Draw, icon, iconButton } from './markup';

// ---------------------------------------------------------------------------------------------
// Dialogs.

const field = (seed: string, chars: number | null, attrs: Readonly<Record<string, Attr>>) =>
  h(
    'span',
    { class: 'pf-field' },
    h('input', {
      type: 'text',
      value: chars ? loremOf(seed, chars) : '',
      tabindex: -1,
      readonly: true,
      ...attrs,
    }),
  );

const foot = (verb: string) =>
  h(
    'div',
    { class: 'dlg-foot', 'aria-hidden': 'true' },
    h('span', { class: 'keys' }, h('kbd', {}, '↑'), h('kbd', {}, '↓')),
    'Navigate',
    h('span', { class: 'keys' }, h('kbd', {}, '↵')),
    verb,
    h('span', { class: 'grow' }),
    h('span', { class: 'keys' }, h('kbd', {}, 'Esc')),
    'Close',
  );

/** A row of the picker's list. */
const option = (draw: Draw, seed: string, length: number, note: boolean, active: boolean) =>
  h(
    'div',
    {
      class: 'opt',
      role: 'option',
      'aria-selected': String(active),
      'data-kind': note ? 'note' : 'command',
    },
    h('span', { class: 'oic', 'aria-hidden': 'true' }, icon(draw, note ? 'file' : 'command', 14)),
    h('span', { class: 'ot' }, h('span', {}, text(loremName(seed, length)))),
    h('span', { class: 'os' }, note ? 'Note' : ''),
  );

function picker(draw: Draw, dialog: FrameDialog, depth: number): string {
  const label = displayName('dialog', dialog.name);
  const typed = (dialog.chars ?? 0) > 0;
  const rows = Array.from({ length: typed ? 4 : 7 }, (_, i) =>
    option(
      draw,
      `${dialog.name}:${depth}:${i}`,
      10 + ((i * 7) % 13),
      dialog.name !== 'palette' || i > 3,
      i === 0,
    ),
  );
  return h(
    'div',
    { class: 'overlay' },
    h(
      'div',
      { class: 'dialog palette', role: 'dialog', 'aria-label': label },
      h(
        'div',
        { class: 'dlg-search' },
        field(`input:${dialog.name}`, dialog.chars, { 'aria-label': label }),
        iconButton(draw, 'close', 'Close', { class: 'dlg-close' }),
      ),
      h(
        'div',
        { class: 'dlg-list', role: 'listbox' },
        ...(dialog.name === 'palette' && !typed
          ? [h('div', { class: 'grp-h', role: 'presentation' }, 'Commands')]
          : []),
        ...rows,
      ),
      foot(dialog.name === 'palette' ? 'Run' : 'Open'),
    ),
  );
}

/** Search, as SearchOverlay draws it: its filters, its status line and lorem hits. */
function searchDialog(draw: Draw, dialog: FrameDialog): string {
  const typed = (dialog.chars ?? 0) > 0;
  const hits = Array.from({ length: typed ? 4 : 5 }, (_, i) =>
    h(
      'div',
      { class: 'opt search-hit', role: 'option', 'aria-selected': String(i === 0) },
      h(
        'span',
        { class: 'search-hit-title' },
        text(loremName(`search:hit:${i}`, 12 + ((i * 5) % 11))),
      ),
      h(
        'span',
        { class: 'search-hit-meta' },
        h('span', { class: 'search-notebook' }, text(loremName('notebook', 8))),
      ),
      typed ? h('span', { class: 'search-snippet' }, text(loremOf(`search:snippet:${i}`, 70))) : '',
    ),
  );
  const select = (label: string) =>
    h(
      'div',
      { class: 'search-filter' },
      h(
        'select',
        { class: 'pm-select pm-select-sm', 'aria-label': label, tabindex: -1 },
        h('option', {}, text(label)),
      ),
    );
  return h(
    'div',
    { class: 'overlay' },
    h(
      'div',
      { class: 'dialog palette search', role: 'dialog', 'aria-label': 'Search' },
      h(
        'div',
        { class: 'dlg-search' },
        h('span', { class: 'search-icon', 'aria-hidden': 'true' }, icon(draw, 'search')),
        field('input:search', dialog.chars, { 'aria-label': 'Search notes' }),
        iconButton(draw, 'close', 'Close Search', { class: 'dlg-close' }),
      ),
      h(
        'div',
        { class: 'search-controls' },
        select('All Folders'),
        select('Any Tag'),
        select('Any Time'),
      ),
      h(
        'div',
        { class: 'search-status', role: 'status' },
        h('span', {}, typed ? 'Notes' : 'Recent Notes'),
      ),
      h(
        'div',
        { class: 'dlg-list search-results', role: 'listbox' },
        ...(typed ? [h('div', { class: 'grp-h', role: 'presentation' }, 'Notes')] : []),
        ...hits,
      ),
      foot('Open'),
    ),
  );
}

/** Confirmation: placeholder bars for its words, since they weren't recorded (dialog.confirm). */
function confirmDialog(dialog: FrameDialog): string {
  return (
    h('div', { class: 'pf-scrim', 'aria-hidden': 'true' }) +
    h(
      'dialog',
      { class: 'confirm pf-dialog', open: true },
      h(
        'form',
        { method: 'dialog' },
        h('h2', {}, h('span', { class: 'pf-bar pf-bar-title' })),
        h('p', {}, h('span', { class: 'pf-bar' }), h('span', { class: 'pf-bar pf-bar-short' })),
        dialog.chars !== null
          ? h('p', {}, field('input:confirm', dialog.chars, { class: 'input' }))
          : '',
        h(
          'div',
          { class: 'confirm-actions' },
          h(
            'button',
            { type: 'button', class: 'btn', tabindex: -1 },
            h('span', { class: 'pf-bar pf-bar-button' }),
          ),
          h(
            'button',
            { type: 'button', class: 'btn primary', tabindex: -1 },
            h('span', { class: 'pf-bar pf-bar-button' }),
          ),
        ),
      ),
    )
  );
}

/** Any other dialog: titled with its name, the shared ×, over lorem rows. */
function titledDialog(draw: Draw, dialog: FrameDialog, depth: number): string {
  const label = displayName('dialog', dialog.name);
  return h(
    'div',
    { class: 'overlay' },
    h(
      'div',
      { class: 'dialog', role: 'dialog', 'aria-label': label },
      h(
        'div',
        { class: 'dlg-title' },
        h('h2', {}, text(label)),
        iconButton(draw, 'close', 'Close', { class: 'dlg-close' }),
      ),
      dialog.chars !== null
        ? h(
            'div',
            { class: 'dlg-search' },
            field(`input:${dialog.name}`, dialog.chars, { 'aria-label': label }),
          )
        : '',
      h(
        'div',
        { class: 'dlg-list' },
        ...Array.from({ length: 5 }, (_, i) =>
          h(
            'div',
            { class: 'opt' },
            h(
              'span',
              { class: 'ot' },
              h(
                'span',
                {},
                text(loremName(`${dialog.name}:${depth}:row:${i}`, 14 + ((i * 9) % 17))),
              ),
            ),
          ),
        ),
      ),
    ),
  );
}

export function dialogMarkup(draw: Draw, dialog: FrameDialog, depth: number): string {
  if (dialog.name === 'search') return searchDialog(draw, dialog);
  if (PICKERS.has(dialog.name)) return picker(draw, dialog, depth);
  if (dialog.name === 'confirm') return confirmDialog(dialog);
  return titledDialog(draw, dialog, depth);
}
