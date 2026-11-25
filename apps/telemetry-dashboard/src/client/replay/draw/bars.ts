/** The replay frame's bars (PEN-178): the note's bar, the tab strip and the phone's app bar. */
import {
  NOTE_BAR_BUTTONS,
  NOTE_BAR_BUTTON_INFO,
  noteBarShows,
} from '@penmoss/web/src/notes/note-bar-buttons';
import { displayName } from '../../names';
import { bucketFloor, isNoteScreen } from '../state';
import {
  h,
  text,
  loremName,
  type Draw,
  icon,
  iconButton,
  historyNav,
  keepOnTop,
  noteTitle,
} from './markup';

/** The note's bar's buttons: those noteBarShows gives with no settings recorded, then More. */
export function noteBar(draw: Draw): string {
  const full = draw.frame.layout.fullWidth;
  return h(
    'div',
    { class: 'note-actions' },
    ...NOTE_BAR_BUTTONS.filter((button) => noteBarShows({}, button)).map((button) => {
      const info = NOTE_BAR_BUTTON_INFO[button];
      return iconButton(draw, info.icon, info.label, {
        'aria-pressed': button === 'fullWidth' ? String(full) : undefined,
      });
    }),
    h('div', { class: 'menu-anchor' }, iconButton(draw, 'more', 'Note Actions')),
  );
}

export function tabStrip(draw: Draw, navInTitleBar: boolean): string {
  const { frame } = draw;
  const count = Math.max(1, bucketFloor(frame.layout.tabs) ?? 1);
  const onNote = isNoteScreen(frame.screen);
  const currentTitle = onNote
    ? noteTitle(frame.note)
    : displayName('screen', frame.screen ?? 'home');
  const currentIcon = onNote
    ? 'file'
    : frame.screen === 'tags'
      ? 'hash'
      : frame.screen === 'graph'
        ? 'graph'
        : frame.screen === 'trash'
          ? 'trash'
          : 'file';
  const tabs = Array.from({ length: count }, (_, i) => {
    const current = i === 0;
    return h(
      'div',
      {
        role: 'tab',
        class: 'tab',
        'aria-selected': String(current),
        'data-kind': current && !onNote ? 'page' : 'note',
        tabindex: -1,
      },
      h(
        'span',
        { class: 'tab-mark', 'aria-hidden': 'true' },
        icon(draw, current ? currentIcon : 'file'),
      ),
      h(
        'span',
        { class: 'tab-title' },
        h('bdi', {}, text(current ? currentTitle : loremName(`tab:${i}`, 9 + (i % 3) * 4))),
      ),
      h('span', { class: 'tab-close', 'aria-hidden': 'true' }, icon(draw, 'close', 12)),
    );
  });
  return h(
    'div',
    { class: 'tab-strip' },
    navInTitleBar ? h('div', { class: 'tab-strip-lead' }, historyNav(draw), keepOnTop(draw)) : '',
    h(
      'div',
      { class: 'tab-list', role: 'tablist', 'aria-label': 'Open Tabs' },
      h('div', { class: 'tab-group tab-group-scroll', role: 'presentation' }, ...tabs),
    ),
    iconButton(draw, 'plus', 'New Tab', { class: 'tab-new' }),
    h(
      'button',
      { type: 'button', class: 'tab-all', 'aria-label': `All Tabs, ${count}`, tabindex: -1 },
      icon(draw, 'chevD', 14),
      h('span', {}, String(count)),
    ),
    h('span', { class: 'tab-strip-fill', 'aria-hidden': 'true' }),
    h('div', { class: 'tab-strip-end' }, onNote ? noteBar(draw) : ''),
  );
}

/** The phone's app bar, at the top of every notes screen (AppBar.tsx). */
export const appBar = (draw: Draw, title: string, brandMark = false) =>
  h(
    'header',
    { class: 'app-bar' },
    iconButton(draw, 'menu', 'Open Navigation'),
    brandMark
      ? h(
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
        )
      : '',
    h('h1', { class: 'app-bar-title' }, text(title)),
    iconButton(draw, 'search', 'Search Notes'),
  );
