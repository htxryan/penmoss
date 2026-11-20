import { renderToString } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App } from '../../src/App';
import { InSources, oneSource, type OneSource } from './support/one-source';

// The app as the Mac app's window holds it: one notebook in the registry (web.md 2.2).
let one: OneSource;
beforeEach(async () => {
  one = await oneSource();
});
afterEach(() => one.stop());

/**
 * The page at `pathname`. `knows`: whether a note's id is known to be a note (B12); every id
 * is, by default.
 */
function render(pathname: string, { knows = true }: { knows?: boolean | null } = {}) {
  const [path = pathname, query = ''] = pathname.split('?');
  one.source.notes.knows = () => knows;
  return renderToString(
    <InSources sources={one.sources}>
      <App location={{ pathname: path, search: query ? `?${query}` : '' }} />
    </InSources>,
  );
}

describe('App', () => {
  it('renders the notes shell with an empty state at /', () => {
    const html = render('/');

    expect(html).toContain('data-testid="app-root"');
    expect(html).toContain('Penmoss');
    expect(html).toContain('New Note');
    expect(html).toContain('data-testid="empty-state"');
  });

  it('opens a note at /notes/:id with a title field above the body', () => {
    const html = render('/notes/01JB7Q3V6M8K2T9RZ4XN5C1HPD');
    expect(html).toContain('data-testid="note-title"');
    expect(html).toContain('placeholder="Untitled"');
    expect(html).toContain('data-testid="note-body"');
    expect(html.indexOf('note-title')).toBeLessThan(html.indexOf('note-body'));
  });

  it('shows the note’s backlinks beside it (T16)', () => {
    const html = render('/notes/01JB7Q3V6M8K2T9RZ4XN5C1HPD');
    expect(html).toContain('data-testid="backlinks"');
    expect(html).toContain('Linked mentions');
    expect(html).toContain('Unlinked mentions');
  });

  // T45 (D37, A710): a note in a window of its own.
  it('opens a note window at /window/notes/:id: the note, Back and Forward, no sidebar', () => {
    const html = render('/window/notes/01JB7Q3V6M8K2T9RZ4XN5C1HPD');
    expect(html).toContain('data-testid="note-window"');
    expect(html).toContain('data-testid="note-title"');
    expect(html).toContain('data-testid="note-body"');
    expect(html).toContain('data-testid="note-menu"');
    expect(html).toContain('data-testid="note-rail"');
    expect(html).toContain('data-testid="window-back"');
    expect(html).toContain('data-testid="window-forward"');
    // No sidebar, rail or breadcrumbs.
    expect(html).not.toContain('id="app-sidebar"');
    expect(html).not.toContain('data-testid="note-list"');
    expect(html).not.toContain('aria-label="Breadcrumb"');
    expect(html).not.toContain('New Note');
    // The main window keeps its breadcrumbs and has no Back or Forward of its own.
    const main = render('/notes/01JB7Q3V6M8K2T9RZ4XN5C1HPD');
    expect(main).toContain('aria-label="Breadcrumb"');
    expect(main).not.toContain('data-testid="window-back"');
  });

  it('says when an address is not a note', () => {
    expect(render('/notes/nope')).toContain('This address is not a note');
  });

  it('says when no note has the id, and waits until it can tell (B12)', () => {
    const id = '/notes/01JB7Q3V6M8K2T9RZ4XN5C1HPD';
    const missing = render(id, { knows: false });
    expect(missing).toContain('Note not found');
    expect(missing).not.toContain('data-testid="note-title"');
    const loading = render(id, { knows: null });
    expect(loading).toContain('Opening the note');
    expect(loading).not.toContain('data-testid="note-title"');
  });

  // T59 (D49): no sign-in, devices or agent tokens: those were the server's.
  it('has no sign-in, devices or link pages', () => {
    const home = render('/');
    expect(home).not.toContain('Sign In Again');
    expect(home).not.toContain('data-testid="sign-in-banner"');
    for (const path of ['/settings/devices', '/link', '/native-sign-in']) {
      expect(render(path), path).not.toContain('Signed-in devices');
    }
  });

  // T36: the phone layout's controls are in the page, whatever the width (CSS shows them).
  it('gives every notes screen an app bar whose menu opens the sidebar drawer', () => {
    for (const path of ['/', '/notes/01JB7Q3V6M8K2T9RZ4XN5C1HPD', '/trash', '/notes/nope']) {
      const html = render(path);
      expect(html, path).toContain('data-testid="app-bar"');
      expect(html, path).toContain('aria-label="Open Navigation"');
      expect(html, path).toContain('aria-expanded="false" aria-controls="app-sidebar"');
      expect(html, path).toContain('id="app-sidebar"');
      expect(html, path).toContain('aria-label="Close Navigation"');
      // Settings is in the drawer, and the notebook's ⋯, which holds Trash (R2-21).
      expect(html, path).toContain('href="/settings"');
      expect(html, path).toContain('aria-label="More Notebook Actions"');
    }
  });

  // T42 item 6 (A575): Copy, Markdown source, History, Local graph and Delete are in the ⋯
  // menu; Full width and Info stay on the top bar.
  it('puts the note’s actions in the app bar’s menu and the top bar’s ⋯ menu', () => {
    const html = render('/notes/01JB7Q3V6M8K2T9RZ4XN5C1HPD');
    expect(html).toContain('data-testid="note-actions"');
    expect(html).toContain('data-testid="note-menu"');
    for (const label of ['Full Width', 'Note Panel']) {
      expect(html).toContain(`aria-label="${label}"`);
    }
    for (const label of ['Markdown source', 'Version history', 'Local graph', 'Move to Trash']) {
      expect(html).not.toContain(`aria-label="${label}"`);
    }
    expect(html).not.toContain('data-testid="copy-note"');
  });

  it('lays Settings out with a way back and every section', () => {
    for (const path of ['/settings', '/settings/journal', '/settings/sidebar']) {
      const html = render(path);
      expect(html, path).toContain('data-command="app.home"');
      expect(html, path).toContain('aria-label="Settings Sections"');
      expect(html, path).toContain('aria-label="Search Settings"');
      for (const href of [
        '/settings/appearance',
        '/settings/sidebar',
        '/settings/note',
        '/settings/symbols',
        '/settings/journal',
        '/settings/quick-capture',
        '/settings/shortcuts',
      ]) {
        expect(html, path).toContain(`href="${href}"`);
      }
      for (const gone of [
        '/settings/devices',
        '/settings/sync',
        '/settings/git-mirror',
        '/settings/display',
        '/settings/status',
      ]) {
        expect(html, path).not.toContain(`href="${gone}"`);
      }
    }
    expect(render('/settings/sidebar')).toMatch(
      /href="\/settings\/sidebar" data-command="app.display" aria-current="page"/,
    );
  });

  // PEN-146: the nav in groups, each under its heading; without the Mac app's git, updates,
  // meaning and GitHub sign-in, only Look and Feel and Writing.
  it('groups the sections under their headings', () => {
    const html = render('/settings');
    const groups = [...html.matchAll(/class="settings-nav-heading">([^<]+)</g)].map(
      ([, label]) => label,
    );
    expect(groups).toEqual(['Look and Feel', 'Writing']);
  });

  // PEN-146: Display became Sidebar and Status became GitHub; old links still land.
  it('opens a renamed section’s old address on the new one', () => {
    expect(render('/settings/display')).toMatch(
      /href="\/settings\/sidebar" data-command="app.display" aria-current="page"/,
    );
  });

  // T39 pass 3 (A902): one icon per section, the phone's too (SettingsRoutes.kt).
  it('gives each Settings section its own icon, as the phone does', () => {
    const html = render('/settings');
    const icons = [...html.matchAll(/href="\/settings\/([a-z-]+)"[^>]*>.*?data-icon="(\w+)"/g)].map(
      ([, id, icon]) => [id, icon],
    );
    expect(Object.fromEntries(icons)).toMatchObject({
      appearance: 'palette',
      sidebar: 'panelL',
      journal: 'journal',
    });
    expect(new Set(icons.map(([, icon]) => icon)).size).toBe(icons.length);
  });
});
