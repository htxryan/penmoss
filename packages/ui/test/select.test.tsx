import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Select, selectClass } from '../src/controls/Select';

describe('Select (T51 item 13, A941)', () => {
  it('is a native select with the shared class, its options and attributes', () => {
    const html = renderToStaticMarkup(
      <Select
        aria-label="Folder"
        value="b"
        onChange={() => undefined}
        data-testid="folder"
        data-event="search.filter.folder"
      >
        <option value="a">A</option>
        <option value="b">B</option>
      </Select>,
    );
    expect(html).toMatch(/^<select /);
    expect(html).toContain('class="pm-select"');
    expect(html).toContain('aria-label="Folder"');
    expect(html).toContain('data-testid="folder"');
    // Its own tracked id (PEN-175): a change records it, never the value.
    expect(html).toContain('data-event="search.filter.folder"');
    expect(html).toContain('<option value="b" selected="">B</option>');
  });

  it('takes a size, a variant and the caller’s own class, in that order', () => {
    const html = renderToStaticMarkup(
      <Select size="small" variant="quiet" className="mine" disabled data-event="graph.depth">
        <option>One</option>
      </Select>,
    );
    expect(html).toContain('class="pm-select pm-select-sm pm-select-quiet mine"');
    expect(html).toContain('disabled=""');
  });

  it('never passes the size on as the native listbox size', () => {
    const html = renderToStaticMarkup(
      <Select size="small" data-event="graph.depth">
        <option>One</option>
      </Select>,
    );
    expect(html).not.toMatch(/ size="/);
  });

  it('gives selects made outside React the same classes', () => {
    expect(selectClass()).toBe('pm-select');
    expect(selectClass('small', 'quiet')).toBe('pm-select pm-select-sm pm-select-quiet');
    expect(selectClass('default', 'default', '')).toBe('pm-select');
  });
});
