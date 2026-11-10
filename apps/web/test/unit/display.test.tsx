import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { App } from '../../src/App';
import { NotesProvider } from '../../src/notes/context';
import { NoteDirectory } from '../../src/notes/directory';
import { DirectoryProvider } from '../../src/notes/links-context';
import { WorkspaceProvider } from '../../src/workspace/context';
import { memoryNotes } from './support/memory-notes';
import { testNotes, testWorkspace } from './support/local-sources';

// T42 item 7 (A576): Settings → Display hides Today, This week, Graph or Commands from the
// sidebar (and its rail, the same buttons); Search always shows.

function setup() {
  const store = memoryNotes();
  const notes = testNotes(store);
  const workspace = testWorkspace(store);
  const directory = new NoteDirectory({
    notes,
    folderOf: () => null,
    folderName: () => null,
    register: () => undefined,
    navigate: () => undefined,
  });
  const render = (pathname: string) =>
    renderToString(
      <NotesProvider notes={notes}>
        <WorkspaceProvider workspace={workspace}>
          <DirectoryProvider directory={directory}>
            <App location={{ pathname, search: '' }} />
          </DirectoryProvider>
        </WorkspaceProvider>
      </NotesProvider>,
    );
  return { render, workspace };
}

/** The `<input>` tag holding `marker` (a test id, or the Search row's description). */
const inputWith = (html: string, marker: string) =>
  html.match(/<input[^>]*>/g)?.find((tag) => tag.includes(marker)) ?? '';

/** The sidebar's shortcuts, between New note and the note list. */
const shortcuts = (html: string) =>
  html.slice(html.indexOf('class="sb-actions"'), html.indexOf('class="sb-list"'));

describe('Settings → Display (T42, A576)', () => {
  it('shows every shortcut by default', () => {
    const html = shortcuts(setup().render('/'));
    for (const command of [
      'app.search',
      'journal.today',
      'journal.thisWeek',
      'app.graph',
      'app.palette',
    ]) {
      expect(html, command).toContain(`data-command="${command}"`);
    }
  });

  it('hides the shortcuts the user turned off, never Search', () => {
    const { render, workspace } = setup();
    workspace.setSetting('sidebar.today', false);
    workspace.setSetting('sidebar.graph', false);
    workspace.setSetting('sidebar.commands', true);
    const html = shortcuts(render('/'));
    expect(html).toContain('data-command="app.search"');
    expect(html).toContain('data-command="journal.thisWeek"');
    expect(html).toContain('data-command="app.palette"');
    expect(html).not.toContain('data-command="journal.today"');
    expect(html).not.toContain('data-command="app.graph"');
  });

  it('is a Settings section with a toggle for each shortcut but Search', async () => {
    const { render, workspace } = setup();
    // This device's copy read: the toggles can change (not before, A576).
    expect(inputWith(render('/settings/display'), 'display-today')).toContain('disabled=""');
    await workspace.start();
    workspace.stop();
    workspace.setSetting('sidebar.thisWeek', false);
    const html = render('/settings/display');
    expect(html).toContain('href="/settings/display"');
    expect(html).toContain('data-testid="display-settings"');
    // PEN-85: a muted hint right under the heading.
    expect(html).toMatch(
      /Display<\/h2><p class="muted settings-help" data-testid="display-applies-hint">Changes apply at once\.<\/p>/,
    );
    for (const item of ['today', 'thisWeek', 'graph', 'commands']) {
      expect(html, item).toContain(`data-testid="display-${item}"`);
    }
    expect(html).not.toContain('data-testid="display-search"');
    const search = inputWith(html, '-search"');
    expect(search).toContain('checked=""');
    expect(search).toContain('disabled=""');
    expect(inputWith(html, 'display-thisWeek')).not.toContain('checked');
    expect(inputWith(html, 'display-today')).toContain('checked=""');
    expect(inputWith(html, 'display-today')).not.toContain('disabled');
  });
});
