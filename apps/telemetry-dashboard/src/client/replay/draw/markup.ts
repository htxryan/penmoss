/**
 * The replay frame's markup (PEN-178): writing the app's elements as text, the drawing's state,
 * and the pieces every surface uses (icons, buttons, the brand, the open note's title).
 */
import { BUILT_IN_THEMES, PENMOSS } from '@penmoss/ui/theme';
import type { FrameData } from '../frame-data';
import { loremOf } from '../lorem';
import type { Frame, FrameNote } from '../state';

/** The phone's Settings group in place of This Mac, as Android names it. */
export const ANDROID_DEVICE_GROUP = 'This Phone';

/** The dialogs drawn as the app's picker (.dialog.palette). */
export const PICKERS = new Set(['palette', 'quickOpen', 'newTab', 'recent']);

// ---------------------------------------------------------------------------------------------
// Markup.

export type Attr = string | number | boolean | null | undefined;

const escape = (text: string) =>
  text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

const VOID = new Set(['input', 'img', 'hr', 'br']);

/** An element as markup: `false`, null and undefined attributes are left out, `true` is bare. */
export function h(
  tag: string,
  attrs: Readonly<Record<string, Attr>>,
  ...children: string[]
): string {
  let open = `<${tag}`;
  for (const [name, value] of Object.entries(attrs)) {
    if (value === false || value === null || value === undefined) continue;
    open += value === true ? ` ${name}` : ` ${name}="${escape(String(value))}"`;
  }
  return VOID.has(tag) ? `${open}>` : `${open}>${children.join('')}</${tag}>`;
}

export const text = (value: string) => escape(value);

/** Custom properties for an element, set through style.setProperty once it is in the page. */
export const vars = (entries: Readonly<Record<string, string>>) =>
  Object.entries(entries)
    .map(([name, value]) => `${name}:${value}`)
    .join(';');

/** A name made of lorem: lower case on purpose, since it stands for what a person wrote. */
export const loremName = (seed: string, length: number) => {
  const words = loremOf(seed, length + 12)
    .replace(/[.,]/g, '')
    .split(' ');
  let name = words[0] ?? 'lorem';
  for (const word of words.slice(1)) {
    if (name.length + 1 + word.length > length) break;
    name += ` ${word}`;
  }
  return name;
};

// ---------------------------------------------------------------------------------------------
// The drawing.

export interface Draw {
  readonly frame: Frame;
  readonly data: FrameData;
  /** At or under NARROW_PX: the app's phone layout. */
  readonly phone: boolean;
  readonly mac: boolean;
}

export function icon(draw: Draw, name: string, size = 16, className?: string): string {
  const svg = draw.data.icons[name] ?? '';
  return svg
    .replace(/ width="16" height="16"/, ` width="${size}" height="${size}"`)
    .replace('class="i"', className ? `class="i ${className}"` : 'class="i"');
}

export function iconButton(
  draw: Draw,
  name: string,
  label: string,
  extra: Readonly<Record<string, Attr>> = {},
  size = 16,
): string {
  const { class: className, ...rest } = extra;
  return h(
    'button',
    {
      type: 'button',
      class: `icon-btn${className ? ` ${String(className)}` : ''}`,
      'aria-label': label,
      tabindex: -1,
      ...rest,
    },
    icon(draw, name, size),
  );
}

export const historyNav = (draw: Draw) =>
  h(
    'nav',
    { class: 'history-nav', 'aria-label': 'History' },
    h(
      'span',
      { class: 'history-pair' },
      iconButton(draw, 'navBack', 'Back', { class: 'history-half' }),
      iconButton(draw, 'navForward', 'Forward', { class: 'history-half' }),
    ),
  );

export const keepOnTop = (draw: Draw) =>
  draw.mac
    ? iconButton(draw, 'pin', 'Keep on Top', { class: 'keep-on-top', 'aria-pressed': 'false' }, 18)
    : '';

export const brand = () =>
  h(
    'h1',
    { class: 'brand' },
    h(
      'span',
      { class: 'brand-mark', 'aria-hidden': 'true' },
      h('img', {
        class: 'brand-mark-light',
        src: '/brand-mark-light.svg',
        alt: '',
        width: 20,
        height: 20,
      }),
      h('img', {
        class: 'brand-mark-dark',
        src: '/brand-mark-dark.svg',
        alt: '',
        width: 20,
        height: 20,
      }),
    ),
    h('span', {}, 'Penmoss'),
  );

/** The open note's title as the sidebar and the tab show it. */
export function noteTitle(note: FrameNote | null): string {
  if (!note?.title) return loremName('note:shown', 18);
  // As the note's own title field holds it; an empty title shows as the app shows it.
  return note.title.length === 0 ? 'Untitled' : loremOf(note.title.seed, note.title.length);
}

/** The theme a frame is drawn in: the recorded built-in one, or Penmoss. */
export function themeOf(frame: Frame) {
  return BUILT_IN_THEMES.find((theme) => theme.id === frame.theme) ?? PENMOSS;
}
