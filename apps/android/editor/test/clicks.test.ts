/**
 * The editor page's tracked controls (PEN-175, AC5): a use of a widget's `data-event` control in
 * the note posts `{v: 1, type: 'click', id, state?}` for the app to record, as the Mac's page
 * records it; a `data-command` control, a disabled one and the theme preview's note post nothing;
 * a select or a range input posts once when it changes, never its value.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { installClickTracking } from '../src/clicks';
import type { FromEditor } from '../src/protocol';

const removals: Array<() => void> = [];
afterEach(() => {
  for (const remove of removals.splice(0)) remove();
  document.body.replaceChildren();
});

function tracking(active = () => true): FromEditor[] {
  const sent: FromEditor[] = [];
  removals.push(installClickTracking(document, (message) => sent.push(message), active));
  return sent;
}

function add(html: string): HTMLElement {
  const holder = document.createElement('div');
  holder.innerHTML = html;
  document.body.append(holder);
  return holder;
}

describe('the editor page’s clicks', () => {
  it('posts a widget’s id, from a tap anywhere inside it', () => {
    const sent = tracking();
    const page = add(
      '<button data-event="editor.callout.fold"><span class="glyph">›</span></button>' +
        '<button data-event="editor.code.copy">Copy</button>',
    );
    page.querySelector<HTMLElement>('.glyph')!.click();
    page.querySelector<HTMLElement>('[data-event="editor.code.copy"]')!.click();
    expect(sent).toEqual([
      { v: 1, type: 'click', id: 'editor.callout.fold' },
      { v: 1, type: 'click', id: 'editor.code.copy' },
    ]);
  });

  it('says which way a task’s check box went', () => {
    const sent = tracking();
    const page = add('<input type="checkbox" data-event="editor.task.toggle">');
    const box = page.querySelector<HTMLInputElement>('input')!;
    box.click();
    box.click();
    expect(sent).toEqual([
      { v: 1, type: 'click', id: 'editor.task.toggle', state: 'on' },
      { v: 1, type: 'click', id: 'editor.task.toggle', state: 'off' },
    ]);
  });

  it('posts nothing for a command’s control, a disabled one or an untracked one', () => {
    const sent = tracking();
    const page = add(
      '<button data-command="app.search" data-event="x.y">Search</button>' +
        '<button data-event="editor.code.copy" disabled>Copy</button>' +
        '<button data-event="editor.code.copy" aria-disabled="true">Copy</button>' +
        '<button data-untracked="only moves the caret">Here</button>',
    );
    for (const button of page.querySelectorAll('button')) button.click();
    expect(sent).toEqual([]);
  });

  it('posts a select once, when it changes, without its value', () => {
    const sent = tracking();
    const page = add(
      '<select data-event="editor.code.language"><option>ts</option><option>kotlin</option></select>',
    );
    const select = page.querySelector('select')!;
    select.click();
    select.value = 'kotlin';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    expect(sent).toEqual([{ v: 1, type: 'click', id: 'editor.code.language' }]);
  });

  it('posts nothing while the theme preview’s sample note shows', () => {
    const sent = tracking(() => false);
    add('<button data-event="editor.callout.fold">›</button>').querySelector('button')!.click();
    expect(sent).toEqual([]);
  });
});
