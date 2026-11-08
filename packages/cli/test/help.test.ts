import { describe, expect, it } from 'vitest';
import { COMMANDS, NOTEBOOK_COMMANDS } from '../src/main';

// T39 pass 3 (A899), #172 (A920): a note command that mentions Agent activity says where a git
// notebook's change is undone: its own Agent activity in the apps for folders (an --agent
// clone's), each note's History for a tag rename.
describe('help', () => {
  it('says what undoes a change in a git notebook wherever it promises Agent activity’s Undo', () => {
    const promising = COMMANDS.filter(
      (command) =>
        NOTEBOOK_COMMANDS.has(command.name) &&
        command.description.some((line) => line.includes('Agent activity')),
    );
    expect(promising.map((command) => command.name).sort()).toEqual(['retag', 'rmdir']);
    const said = (name: string) =>
      promising.find((command) => command.name === name)!.description.join(' ');
    expect(said('rmdir')).toMatch(
      /for a clone added with --agent the change is also in the notebook’s Agent activity in the Mac and Android apps, with an Undo/,
    );
    expect(said('retag')).toMatch(
      /an edit of each note, so it is not in the notebook’s Agent activity[^.]*History/,
    );
    for (const command of promising) {
      expect(command.description.join(' '), command.name).not.toMatch(/no Agent activity/);
    }
  });
});
