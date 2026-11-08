/**
 * The `[text](url)` shortcut (T14): typing the closing parenthesis turns a
 * markdown link into linked text. Only web and mail addresses qualify, so a
 * typed `[x](y)` in prose stays text; `![alt](…)` (an image) and `[[…]]`
 * (a wikilink, T16) never match.
 */
import { Extension, InputRule } from '@tiptap/core';

/** `[label](https://…)`, typed up to the closing parenthesis, not after `!` or `\`. */
const MARKDOWN_LINK = /(?:^|[^!\\[])(\[([^[\]\n]+)\]\(((?:https?:\/\/|mailto:)[^\s()]+)\))$/;

export const LinkShortcut = Extension.create({
  name: 'linkShortcut',

  addInputRules() {
    return [
      new InputRule({
        find: MARKDOWN_LINK,
        handler: ({ state, range, match }) => {
          const [whole, link, label, href] = match;
          const type = state.schema.marks['link'];
          if (!whole || !link || !label || !href || !type) return null;
          const start = range.from + whole.length - link.length;
          if (!state.doc.resolve(start).parent.type.allowsMarkType(type)) return null;
          const marks = state.doc.resolve(start).marks();
          const text = state.schema.text(label, [...marks, type.create({ href, title: null })]);
          state.tr.replaceWith(start, range.to, text).removeStoredMark(type);
          return undefined;
        },
      }),
    ];
  },
});
