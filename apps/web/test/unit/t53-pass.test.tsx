import { renderToString } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App } from '../../src/App';
import { InSources, oneSource, type OneSource } from './support/one-source';
import { appCss } from './support/app-css';

// What T53's manual pass found on the web and the Mac app (docs/evidence/t53/web-mac.md).

let one: OneSource;
beforeEach(async () => {
  one = await oneSource();
});
afterEach(() => one.stop());

function render(pathname: string): string {
  return renderToString(
    <InSources sources={one.sources}>
      <App location={{ pathname, search: '' }} />
    </InSources>,
  );
}

const css = appCss();

/** The declarations of the first rule whose selector is exactly `selector`. */
function rule(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? '';
}

describe('Settings → Sidebar (Display until PEN-146) after the T53 pass', () => {
  it('names the Quick Access setting as A984 does', () => {
    const html = render('/settings/sidebar');
    // Under Quick Access, on its own row (PEN-146).
    const row = html.slice(html.indexOf('data-setting="quick-access"'));
    expect(row.slice(0, row.indexOf('</li>'))).toContain('Show Notebook Names');
    expect(html).not.toContain('notebook under its title');
  });

  // Open or Close Notebooks went with the server's notebooks (T59, D49).
  it('names the shortcuts always on the sidebar (A979)', () => {
    expect(render('/settings/sidebar')).toContain(
      'New Note, Settings, Feedback and Trash are always on the sidebar.',
    );
  });

  it('draws the Recent Notes count as a − and + stepper on its row, as on Android (PEN-146)', () => {
    const html = render('/settings/sidebar');
    const row = html.slice(html.indexOf('data-setting="recent-notes"'));
    const recent = row.slice(0, row.indexOf('</li>'));
    expect(recent).toContain('Shows 10 notes');
    expect(recent).toMatch(/<output[^>]*data-testid="recent-count"[^>]*>10<\/output>/);
    expect(recent).toContain('aria-label="Fewer Recent Notes"');
    expect(recent).toContain('aria-label="More Recent Notes"');
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
