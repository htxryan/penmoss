/**
 * Agent edits light up in open editors (T24, A126). The NoteDoc announces an
 * agent's change to the body (protocol message 102, naming the agent) just
 * before the update itself; the app calls `highlightAgentEdit` as that update
 * is applied and disarms it right after, and the change the Yjs binding
 * renders meanwhile gets a soft highlight labelled with the agent, which
 * fades and is dropped after AGENT_HIGHLIGHT_MS. Typing, and remote changes
 * nobody announced, are never highlighted. Decorations only: nothing is
 * written to the document (D31).
 */
import { Extension, type Editor } from '@tiptap/core';
import { Plugin, PluginKey, type EditorState, type Transaction } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { isBindingTransaction } from '../collab/binding';
import { changedRanges } from './changes';

/** How long a highlight shows (and how long an announcement waits for its update). */
export const AGENT_HIGHLIGHT_MS = 4000;

interface HighlightState {
  /** The agent whose change is expected next, and since when. */
  readonly armed: { readonly label: string; readonly at: number } | null;
  readonly decorations: DecorationSet;
  /** Ids of highlights shown, so each is dropped once on its own timer. */
  readonly shown: readonly number[];
}

type Meta = { readonly arm: string } | { readonly disarm: true } | { readonly clear: number };

export const agentHighlightKey = new PluginKey<HighlightState>('penmossAgentHighlight');

let nextId = 1;

function highlight(state: EditorState, tr: Transaction, label: string, id: number) {
  const decorations: Decoration[] = [];
  const size = state.doc.content.size;
  for (const [from, to] of changedRanges([tr])) {
    const a = Math.max(0, Math.min(from, size));
    const b = Math.max(a, Math.min(to, size));
    if (b <= a) continue;
    // One chip naming the agent, before the first change it made.
    if (decorations.length === 0) {
      decorations.push(
        Decoration.widget(a, () => labelChip(label), { id, side: -1, ignoreSelection: true }),
      );
    }
    decorations.push(
      Decoration.inline(
        a,
        b,
        { class: 'pm-agent-edit', 'data-agent': label, title: `Edited by ${label}` },
        { id },
      ),
    );
  }
  return decorations;
}

function labelChip(label: string): HTMLElement {
  const chip = document.createElement('span');
  chip.className = 'pm-agent-label';
  chip.contentEditable = 'false';
  chip.setAttribute('aria-hidden', 'true');
  chip.textContent = label;
  return chip;
}

export const AgentHighlight = Extension.create({
  name: 'agentHighlight',

  addProseMirrorPlugins() {
    return [
      new Plugin<HighlightState>({
        key: agentHighlightKey,
        state: {
          init: () => ({ armed: null, decorations: DecorationSet.empty, shown: [] }),
          apply: (tr, previous, _old, state) => {
            const meta = tr.getMeta(agentHighlightKey) as Meta | undefined;
            let { armed, decorations, shown } = previous;
            if (tr.docChanged) decorations = decorations.map(tr.mapping, state.doc);
            if (meta && 'arm' in meta) armed = { label: meta.arm, at: Date.now() };
            if (meta && 'disarm' in meta) armed = null;
            if (meta && 'clear' in meta) {
              decorations = decorations.remove(
                decorations.find(
                  undefined,
                  undefined,
                  (spec: { id?: number }) => spec.id === meta.clear,
                ),
              );
              shown = shown.filter((id) => id !== meta.clear);
            }
            if (armed && Date.now() - armed.at >= AGENT_HIGHLIGHT_MS) armed = null;
            if (armed && tr.docChanged && isBindingTransaction(tr)) {
              const id = nextId++;
              const added = highlight(state, tr, armed.label, id);
              if (added.length > 0) {
                decorations = decorations.add(state.doc, added);
                shown = [...shown, id];
              }
              armed = null;
            }
            return { armed, decorations, shown };
          },
        },
        props: {
          decorations: (state) => agentHighlightKey.getState(state)?.decorations,
        },
        view: () => {
          const timers = new Map<number, ReturnType<typeof setTimeout>>();
          return {
            update: (view) => {
              for (const id of agentHighlightKey.getState(view.state)?.shown ?? []) {
                if (timers.has(id)) continue;
                timers.set(
                  id,
                  setTimeout(() => {
                    timers.delete(id);
                    if (view.isDestroyed) return;
                    view.dispatch(
                      view.state.tr
                        .setMeta(agentHighlightKey, { clear: id } satisfies Meta)
                        .setMeta('addToHistory', false),
                    );
                  }, AGENT_HIGHLIGHT_MS),
                );
              }
            },
            destroy: () => {
              for (const timer of timers.values()) clearTimeout(timer);
              timers.clear();
            },
          };
        },
      }),
    ];
  },
});

/**
 * The next remote change this editor renders is `label`'s: highlight it.
 * Returns a function that drops the announcement, to call once that update
 * is applied (the provider does, T24 review): an update that changed nothing
 * shown here (the title, tags) then never leaves it armed for someone else's
 * change.
 */
export function highlightAgentEdit(editor: Editor, label: string): () => void {
  const signal = (meta: Meta) => {
    if (editor.isDestroyed) return;
    const { view } = editor;
    view.dispatch(view.state.tr.setMeta(agentHighlightKey, meta).setMeta('addToHistory', false));
  };
  signal({ arm: label });
  return () => signal({ disarm: true });
}
