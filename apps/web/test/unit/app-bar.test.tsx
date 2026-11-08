// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CommandCenter, memoryBindings } from '../../src/commands/center';
import { COMMANDS } from '../../src/commands/definitions';
import { CommandsContext } from '../../src/commands/hooks';
import { AppBar } from '../../src/shell/AppBar';

// The phone's app bar on a note shows where it is (A907); a note at the top level names its
// notebook (T52), not "Top level".

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

function render(path: readonly string[], notebook?: string): string {
  act(() =>
    root.render(
      <CommandsContext.Provider value={new CommandCenter(COMMANDS, memoryBindings())}>
        <AppBar title="Plans" path={path} {...(notebook === undefined ? {} : { notebook })} />
      </CommandsContext.Provider>,
    ),
  );
  return host.querySelector('[data-testid="app-bar-path"]')!.textContent ?? '';
}

describe('the app bar’s place for a note', () => {
  it('names the notebook of a note at its top level', () => {
    expect(render([], 'Personal')).toBe('Personal');
  });

  it('shows the notebook and folders of a filed note, outermost first', () => {
    expect(render(['Work', 'Projects'], 'Personal')).toBe('Work › Projects');
  });

  it('says Top level only when it knows no notebook', () => {
    expect(render([])).toBe('Top level');
  });
});
