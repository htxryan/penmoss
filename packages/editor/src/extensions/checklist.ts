/**
 * The `- [ ] ` checklist shortcut (T11). Typing `- ` first makes a bullet
 * list, so `[ ] ` (or `[x] `) at the start of a bullet item turns that item
 * into a task: the list is split around it, and the new task list joins task
 * lists next to it. GFM has no mixed lists, so an item never sits in a list
 * of the other kind (the codec would keep such a list as raw markdown).
 * `[ ] ` in a plain paragraph is TipTap's own TaskItem rule.
 */
import { Extension, InputRule } from '@tiptap/core';
import { Fragment, type Node as PMNode } from '@tiptap/pm/model';
import { TextSelection } from '@tiptap/pm/state';

const TASK_MARKER = /^\[([ xX])\]\s$/;

export const ChecklistShortcut = Extension.create({
  name: 'checklistShortcut',
  // Ahead of TaskItem's rule, which would wrap the paragraph inside the bullet item.
  priority: 200,

  addInputRules() {
    return [
      new InputRule({
        find: TASK_MARKER,
        handler: ({ state, range, match }) => {
          const { $from } = state.selection;
          const { taskList, taskItem, bulletList } = state.schema.nodes;
          if (!taskList || !taskItem || !bulletList) return null;
          const depth = $from.depth;
          if (depth < 3 || $from.parent.type.name !== 'paragraph') return null;
          const item = $from.node(depth - 1);
          const list = $from.node(depth - 2);
          if (item.type.name !== 'listItem' || list.type !== bulletList) return null;
          if ($from.index(depth - 1) !== 0) return null;

          const tr = state.tr;
          tr.delete(range.from, range.to);
          const $item = tr.doc.resolve(tr.mapping.map($from.pos));
          const listNode = $item.node(depth - 2);
          const listStart = $item.before(depth - 2);
          const index = $item.index(depth - 2);
          const current = listNode.child(index);
          const task = taskItem.create({ checked: match[1] !== ' ' }, current.content);

          const before: PMNode[] = [];
          const after: PMNode[] = [];
          listNode.forEach((child, _offset, i) => {
            if (i < index) before.push(child);
            if (i > index) after.push(child);
          });
          const tight = listNode.attrs['tight'] as boolean;
          const parts: PMNode[] = [];
          if (before.length) parts.push(bulletList.create(listNode.attrs, before));
          parts.push(taskList.create({ tight }, task));
          if (after.length) parts.push(bulletList.create(listNode.attrs, after));
          tr.replaceWith(listStart, listStart + listNode.nodeSize, Fragment.from(parts));

          // The task list starts after the bullet items before it; the caret goes into its paragraph.
          const taskListPos = listStart + (before.length ? parts[0]!.nodeSize : 0);
          tr.setSelection(TextSelection.create(tr.doc, taskListPos + 3));
          // Join neighbouring task lists (`- [ ] a` Enter Enter `- [ ] b`), as markdown would.
          const joined = tr.doc.resolve(taskListPos);
          const next = taskListPos + tr.doc.nodeAt(taskListPos)!.nodeSize;
          if (tr.doc.resolve(next).nodeAfter?.type === taskList) tr.join(next);
          if (joined.nodeBefore?.type === taskList) tr.join(taskListPos);
          return undefined;
        },
      }),
    ];
  },
});
