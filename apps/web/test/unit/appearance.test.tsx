import {
  BUILT_IN_THEMES,
  COLOUR_TOKENS,
  duplicateAndChoose,
  NORD,
  resolveThemeSettings,
} from '@penmoss/ui/theme';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App } from '../../src/App';
import { ThemeController } from '../../src/theme/controller';
import { ThemeEditor } from '../../src/theme/ThemeEditor';
import { ThemeProvider } from '../../src/theme/ThemeProvider';
import { WorkspaceContext } from '../../src/workspace/hooks';
import { InSources, oneSource, type OneSource } from './support/one-source';

let one: OneSource;
beforeEach(async () => {
  one = await oneSource();
});
afterEach(() => one.stop());

function setup() {
  const { workspace } = one.source;
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
      <InSources sources={one.sources}>
        <ThemeProvider controller={controller}>
          <App location={{ pathname, search: '' }} />
        </ThemeProvider>
      </InSources>,
    );
  /** The theme editor alone, as Customize… opens it. */
  const renderEditor = () => {
    const resolved = resolveThemeSettings(workspace.settings());
    return renderToString(
      <InSources sources={one.sources}>
        <ThemeProvider controller={controller}>
          <WorkspaceContext.Provider value={workspace}>
            <ThemeEditor theme={resolved.theme} themes={resolved.all} onDone={() => undefined} />
          </WorkspaceContext.Provider>
        </ThemeProvider>
      </InSources>,
    );
  };
  return { render, renderEditor, workspace, controller };
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
    for (const href of ['/settings/shortcuts', '/settings/journal', '/settings/sidebar']) {
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
    // Customize… copies a built-in and opens the editor on the copy (PEN-146).
    expect(html).toContain('Customize Penmoss…');
    // Nothing in the section is disabled (Back and Forward, in the bar above, may be: T51).
    expect(html.slice(html.indexOf('class="settings-content"'))).not.toContain('disabled=""');
  });

  it('lays its groups beside a live preview, each row findable by Search Settings (PEN-146)', () => {
    const { render } = setup();
    const html = render('/settings/appearance');
    const page = html.slice(html.indexOf('data-testid="appearance-settings"'));
    for (const group of ['Theme', 'Text']) expect(page).toContain(`<span>${group}</span>`);
    for (const id of [
      'mode',
      'theme',
      'customize-theme',
      'interface-font',
      'note-font',
      'note-font-size',
      'show-tooltips-after',
    ]) {
      expect(page, id).toContain(`data-setting="${id}"`);
    }
    // One preview, the same one the theme editor shows.
    expect(page).toContain('data-testid="app-preview"');
    // Note Width and Note Panel are on the Note page; Window is the Mac app's only.
    expect(page).not.toContain('note-width-setting');
    expect(page).not.toContain('note-panel-setting');
    expect(page).not.toContain('compact-title-bar');
  });

  it('edits a custom theme: a colour input per token, fonts, width and a contrast report', () => {
    const { render, renderEditor, workspace, controller } = setup();
    duplicateAndChoose(workspace, NORD);
    controller.setSettings(workspace.settings());
    // The page offers to customize the copy; Customize… opens the editor in its place.
    expect(render('/settings/appearance')).toContain('Customize Nord copy…');
    const html = renderEditor();
    expect(html).toContain('data-testid="custom-theme-editor"');
    // Beside the same preview Appearance shows (one renderer).
    expect(html).toContain('data-testid="theme-preview"');
    expect(html).toContain('Garden Plan');
    expect(html).toContain('value="Nord copy"');
    expect(html.match(/type="color"/g)).toHaveLength(COLOUR_TOKENS.length);
    for (const label of ['Interface Font', 'Note Font', 'Code Font', 'Note Width']) {
      expect(html).toContain(label);
    }
    expect(html).toContain('passes WCAG AA');
    expect(html).toContain('Delete This Theme');
  });
});
