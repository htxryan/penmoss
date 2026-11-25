/** The dashboard's Paths view. */
import { tree, type TreeNode } from '../charts';
import { eventName, fullNumber, kindName } from '../names';
import { redraw, state } from '../state';
import { type Cell, card, type Answer } from '../cards';

export function paths(answer: Answer): HTMLElement[] {
  const options = (answer['options'] as { event: string; events: number }[] | undefined) ?? [];
  const events = options.map((option) => option.event);
  // The box shows display names; a name two events share says which kind each is ("Command
  // Palette · Dialog"), so each maps back to its event.
  const titles = options.map((option) => eventName(option.event).title);
  const shownAs = new Map(
    options.map((option) => {
      const { title } = eventName(option.event);
      const shared = titles.indexOf(title) !== titles.lastIndexOf(title);
      return [option.event, shared ? `${title} · ${kindName(option.event)}` : title];
    }),
  );
  const byShown = new Map([...shownAs].map(([event, shown]) => [shown, event]));
  const picker = document.createElement('div');
  picker.className = 'picker';
  const label = document.createElement('label');
  label.htmlFor = 'start';
  label.textContent = 'Start From';
  const input = document.createElement('input');
  input.id = 'start';
  input.type = 'search';
  input.value = shownAs.get(state.start) ?? eventName(state.start).title;
  input.title = eventName(state.start).id;
  input.setAttribute('list', 'start-options');
  input.autocomplete = 'off';
  input.spellcheck = false;
  const list = document.createElement('datalist');
  list.id = 'start-options';
  // Each catalogued event, the most frequent first, with how often it occurred in the period.
  for (const option of options) {
    const node = document.createElement('option');
    node.value = shownAs.get(option.event) ?? option.event;
    node.label = `${eventName(option.event).id} · ${fullNumber(option.events)} ${
      option.events === 1 ? 'time' : 'times'
    }`;
    list.append(node);
  }
  const chosen = options.find((option) => option.event === state.start);
  const occurrences = document.createElement('span');
  occurrences.className = 'occurrences';
  occurrences.textContent = chosen
    ? `${fullNumber(chosen.events)} ${chosen.events === 1 ? 'time' : 'times'} in the period`
    : '';
  input.addEventListener('change', () => {
    // A display name, or an id typed as recorded ("command:note.new").
    const event = byShown.get(input.value) ?? input.value;
    if (events.includes(event) && event !== state.start) {
      state.start = event;
      redraw();
    }
  });
  picker.append(label, input, list, occurrences);

  const root = answer['tree'] as TreeNode | null;
  const flat: Cell[][] = [];
  const walk = (node: TreeNode, trail: string[]) => {
    const here = [...trail, eventName(node.event).title];
    if (trail.length > 0) {
      flat.push([
        { title: here.join(' → '), id: eventName(node.event).id },
        node.sessions,
        node.share,
      ]);
    }
    node.children.forEach((child) => walk(child, here));
  };
  if (root) walk(root, []);
  return [
    picker,
    card({
      id: 'paths',
      wide: true,
      title: `What Comes After ${eventName(state.start).title}`,
      note: `The three most common next events, three steps deep, over the last ${String(answer['days'])} days. A path fewer than 5 sessions took isn't shown.`,
      chart: root
        ? (width) => tree({ label: `Paths after ${eventName(state.start).title}`, root }, width)
        : null,
      table: { columns: ['Path', 'Sessions', 'Share %'], rows: flat },
      empty: !root,
    }),
  ];
}
