// @vitest-environment happy-dom
import { useLayoutEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react';
import { describe, expect, it } from 'vitest';
import { CommandCenter, memoryBindings } from '../../src/commands/center';
import { COMMANDS } from '../../src/commands/definitions';
import { CommandsContext, useCommand, useCommands } from '../../src/commands/hooks';

// T39 pass 2: a command that arrives between a render's commit and its passive effects (a
// Mac menu choice over IPC, a key) must run the handler of the screen as it now shows. The
// Mac admin test failed now and then in CI: the second request ran the
// handler from the render before, which still saw the first request as under way.
function Probe({ value, seen }: { value: number; seen: number[] }) {
  useCommand('app.trash', () => {
    seen.push(value);
  });
  const commands = useCommands();
  // Runs in the commit, before passive effects: as early as anything outside can run it.
  useLayoutEffect(() => {
    if (value === 2) commands.run('app.trash');
  });
  return null;
}

describe('useCommand', () => {
  it('runs the handler of the latest committed render, even before its passive effects', () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const center = new CommandCenter(COMMANDS, memoryBindings());
    const root = createRoot(document.createElement('div'));
    const seen: number[] = [];
    const tree = (value: number) => (
      <CommandsContext.Provider value={center}>
        <Probe value={value} seen={seen} />
      </CommandsContext.Provider>
    );
    act(() => root.render(tree(1)));
    act(() => root.render(tree(2)));
    expect(seen).toEqual([2]);
    act(() => root.unmount());
  });
});
