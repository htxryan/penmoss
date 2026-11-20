// @vitest-environment happy-dom
/**
 * The one click listener the Mac's page and Android's editor page both install (PEN-175): it
 * calls back with each tracked control's id, and a switch's or a check box's state, and nothing
 * else.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { installClickListener, type ClickState } from '../src/analytics/clicks';

const removals: Array<() => void> = [];
afterEach(() => {
  for (const remove of removals.splice(0)) remove();
  document.body.replaceChildren();
});

function listening(): Array<[string, ClickState | undefined]> {
  const sent: Array<[string, ClickState | undefined]> = [];
  removals.push(installClickListener(document, (id, state) => sent.push([id, state])));
  return sent;
}

describe('installClickListener', () => {
  it('calls back with the id, and a switch’s or a check box’s state, once per use', () => {
    const sent = listening();
    document.body.innerHTML = `
      <button data-event="editor.code.copy"><span id="inner">Copy</span></button>
      <input type="checkbox" data-event="editor.task.toggle" id="box" />
      <button role="switch" aria-checked="true" data-event="settings.menu-bar-icon" id="switch"></button>
      <select data-event="editor.code.language" id="select"><option>ts</option><option>kt</option></select>
      <input type="range" data-event="time-machine.scrub" id="range" />`;
    document.getElementById('inner')!.click();
    document.getElementById('box')!.click();
    document.getElementById('switch')!.click();
    document.getElementById('select')!.click();
    document.getElementById('range')!.click();
    for (const id of ['select', 'range'])
      document.getElementById(id)!.dispatchEvent(new Event('change', { bubbles: true }));
    expect(sent).toEqual([
      ['editor.code.copy', undefined],
      ['editor.task.toggle', 'on'],
      ['settings.menu-bar-icon', 'off'],
      ['editor.code.language', undefined],
      ['time-machine.scrub', undefined],
    ]);
  });

  it('never calls back for a command’s control, a disabled one or an untracked one', () => {
    const sent = listening();
    document.body.innerHTML = `
      <button data-command="app.search" data-event="x.y">Search</button>
      <button data-event="editor.code.copy" disabled>Copy</button>
      <button data-event="editor.code.copy" aria-disabled="true">Copy</button>
      <select data-event="editor.code.language" disabled><option>ts</option></select>
      <button data-untracked="only moves the caret">Here</button>`;
    for (const button of document.querySelectorAll('button')) button.click();
    document.querySelector('select')!.dispatchEvent(new Event('change', { bubbles: true }));
    expect(sent).toEqual([]);
  });

  it('stops when removed, and a callback that throws never breaks the click', () => {
    let clicked = 0;
    const remove = installClickListener(document, () => {
      throw new Error('recording failed');
    });
    document.body.innerHTML = `<button data-event="editor.code.copy" id="copy">Copy</button>`;
    const copy = document.getElementById('copy')!;
    copy.addEventListener('click', () => clicked++);
    copy.click();
    remove();
    const sent = listening();
    removals.pop()!();
    copy.click();
    expect(clicked).toBe(2);
    expect(sent).toEqual([]);
  });
});
