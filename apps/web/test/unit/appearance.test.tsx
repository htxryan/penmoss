import { BUILT_IN_THEMES, COLOUR_TOKENS, duplicateAndChoose, NORD } from '@penmoss/ui/theme';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { App } from '../../src/App';
import { NotesProvider } from '../../src/notes/context';
import { NoteDirectory } from '../../src/notes/directory';
import { DirectoryProvider } from '../../src/notes/links-context';
import { ThemeController } from '../../src/theme/controller';
import { ThemeProvider } from '../../src/theme/ThemeProvider';
import { WorkspaceProvider } from '../../src/workspace/context';
import { memoryNotes } from './support/memory-notes';
import { testNotes, testWorkspace } from './support/local-sources';

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
  const controller = new ThemeController({
    root: {
      style: { colorScheme: '', setProperty: () => undefined },
      setAttribute: () => undefined,
    },
    storage: null,
    systemDark: { matches: false, subscribe: () => () => undefined },
  });
  const render = (pathname: string) =>
    renderToString(
      <NotesProvider notes={notes}>
        <WorkspaceProvider workspace={workspace}>
          <ThemeProvider controller={controller}>
            <DirectoryProvider directory={directory}>
              <App location={{ pathname, search: '' }} />
            </DirectoryProvider>
          </ThemeProvider>
        </WorkspaceProvider>
      </NotesProvider>,
    );
  return { render, workspace, controller };
}

describe('Settings → Appearance (T28)', () => {
  it('is a Settings section with its own address and nav entry', () => {
    const { render } = setup();
    const html = render('/settings/appearance');
    expect(html).toContain('data-testid="appearance-settings"');
    expect(html).toMatch(
      /href="\/settings\/appearance" data-command="app.appearance" aria-current="page"/,
    );
    // The other sections are still there.
    for (const href of ['/settings/shortcuts', '/settings/journal', '/settings/status']) {
      expect(html).toContain(`href="${href}"`);
    }
  });

  it('offers the mode, every built-in theme, and duplicating the current one', () => {
    const { render } = setup();
    const html = render('/settings/appearance');
    for (const mode of ['light', 'dark', 'system']) expect(html).toContain(`value="${mode}"`);
    expect(html).toMatch(/checked="" value="system"/);
    for (const theme of BUILT_IN_THEMES) {
      expect(html).toContain(`data-theme-id="${theme.id}"`);
      expect(html).toContain(theme.name);
    }
    expect(html).toMatch(/checked="" value="penmoss"/);
    expect(html).toContain('Duplicate Penmoss');
    // Nothing in the section is disabled (Back and Forward, in the bar above, may be: T51).
    expect(html.slice(html.indexOf('class="settings-content"'))).not.toContain('disabled=""');
  });

  it('edits a custom theme: a colour input per token, fonts, width and a contrast report', () => {
    const { render, workspace, controller } = setup();
    duplicateAndChoose(workspace, NORD);
    controller.setSettings(workspace.settings());
    const html = render('/settings/appearance');
    expect(html).toContain('data-testid="custom-theme-editor"');
    expect(html).toContain('value="Nord copy"');
    expect(html.match(/type="color"/g)).toHaveLength(COLOUR_TOKENS.length);
    for (const label of ['Interface font', 'Note font', 'Code font', 'Note width']) {
      expect(html).toContain(label);
    }
    expect(html).toContain('passes WCAG AA');
    expect(html).toContain('Delete This Theme');
  });
});
