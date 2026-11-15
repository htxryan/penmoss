import { renderToString } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../../src/App';
import { InSources, oneSource, type OneSource } from './support/one-source';

// T42 item 7 (A576): Settings → Display hides Today, This week, Graph or Commands from the
// sidebar (and its rail, the same buttons); Search always shows.

let one: OneSource | null = null;
afterEach(() => {
  one?.stop();
  one = null;
});

/** The app over one notebook; with `opened`, its store opens (and its settings read) then. */
async function setup(opened?: Promise<void>) {
  const source = await oneSource(opened ? { opened } : {});
  one = source;
  const render = (pathname: string) =>
    renderToString(
      <InSources sources={source.sources}>
        <App location={{ pathname, search: '' }} />
      </InSources>,
    );
  return { render, workspace: source.source.workspace };
}

/** The `<input>` tag holding `marker` (a test id, or the Search row's description). */
const inputWith = (html: string, marker: string) =>
  html.match(/<input[^>]*>/g)?.find((tag) => tag.includes(marker)) ?? '';

/** The sidebar's shortcuts, between New note and the note list. */
const shortcuts = (html: string) =>
  html.slice(html.indexOf('class="sb-actions"'), html.indexOf('class="sb-list"'));

describe('Settings → Display (T42, A576)', () => {
  it('shows every shortcut by default', async () => {
    const html = shortcuts((await setup()).render('/'));
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

  it('hides the shortcuts the user turned off, never Search', async () => {
    const { render, workspace } = await setup();
    await workspace.start();
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
    let open = () => undefined as void;
    const { render, workspace } = await setup(new Promise<void>((resolve) => (open = resolve)));
    // This device's copy read: the toggles can change (not before, A576).
    expect(inputWith(render('/settings/display'), 'display-today')).toContain('disabled=""');
    open();
    await workspace.start();
    workspace.setSetting('sidebar.thisWeek', false);
    const html = render('/settings/display');
    expect(html).toContain('href="/settings/display"');
    expect(html).toContain('data-testid="display-settings"');
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
