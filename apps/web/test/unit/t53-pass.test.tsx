import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { App } from '../../src/App';
import { NotesProvider } from '../../src/notes/context';
import { NoteDirectory } from '../../src/notes/directory';
import { DirectoryProvider } from '../../src/notes/links-context';
import { WorkspaceProvider } from '../../src/workspace/context';
import { memoryNotes } from './support/memory-notes';
import { testNotes, testWorkspace } from './support/local-sources';

// What T53's manual pass found on the web and the Mac app (docs/evidence/t53/web-mac.md).

function render(pathname: string): string {
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
  return renderToString(
    <NotesProvider notes={notes}>
      <WorkspaceProvider workspace={workspace}>
        <DirectoryProvider directory={directory}>
          <App location={{ pathname, search: '' }} />
        </DirectoryProvider>
      </WorkspaceProvider>
    </NotesProvider>,
  );
}

const css = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../../src/styles.css'),
  'utf8',
);

/** The declarations of the first rule whose selector is exactly `selector`. */
function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? '';
}

describe('Settings → Display after the T53 pass', () => {
  it('names the Quick Access setting as A984 does', () => {
    const html = render('/settings/display');
    expect(html).toContain('Show Notebook Names in Quick Access');
    expect(html).not.toContain('notebook under its title');
  });

  // Open or Close Notebooks went with the server's notebooks (T59, D49).
  it('names the shortcuts always on the sidebar (A979)', () => {
    expect(render('/settings/display')).toContain(
      'New Note, Settings, Feedback and Trash are always on the sidebar.',
    );
  });

  it('draws the Recent Notes count as a field, its own size', () => {
    const tag =
      render('/settings/display')
        .match(/<input[^>]*>/g)
        ?.find((input) => input.includes('data-testid="recent-count"')) ?? '';
    expect(tag).toContain('class="input settings-count"');
    expect(rule('.settings-field > .settings-count')).toMatch(/width:\s*6rem/);
  });
});

describe('the sidebar after the T53 pass', () => {
  it('lets the row of icons narrow inside the sidebar, so ⋯ is never cut off', () => {
    // A grid item's automatic minimum is its content's: without this the row overflowed.
    expect(rule('.sb-shortcuts')).toMatch(/min-width:\s*0/);
  });

  it('keeps Recent Notes’ title and up to three notes before it gives way', () => {
    expect(rule(".sb-part[data-section='recent']")).toMatch(
      /min-height:\s*calc\([^;]*var\(--recent-rows\) \* var\(--pm-control-sm\)\)/,
    );
    for (const rows of [2, 3]) {
      expect(
        rule(`.sb-part[data-section='recent']:has(.sb-quick-list > li:nth-child(${rows}))`),
      ).toMatch(new RegExp(`--recent-rows:\\s*${rows};`));
    }
    expect(css).not.toContain('li:nth-child(4)');
    // A collapsed section still asks for nothing.
    expect(
      rule(".sb-part:is([data-section='recent'], [data-section='tags']):has([data-collapsed])"),
    ).toMatch(/min-height:\s*0/);
  });
});

describe('the note panel after the T53 pass', () => {
  it('keeps History’s current entry (a div, padded and bordered) inside the panel', () => {
    expect(rule('.history-entry')).toMatch(/box-sizing:\s*border-box/);
    expect(rule('.history-entry')).toMatch(/width:\s*100%/);
  });
});
