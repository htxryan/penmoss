// @vitest-environment happy-dom
// PEN-177: typed lengths and the tree from the page. A dialog's field records its length, never
// its text, 500 ms after typing stops, a repeat dropped, and what waits when it closes; the tree
// records folders opened and closed and notes opened by their real ids in `refs`, which only the
// Mac's main process turns into refs: no prop holds an id.
import { act, useEffect, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { INPUT_SETTLE_MS } from '@penmoss/core/analytics';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushRecorded, record } from '../../src/analytics/record';
import { useTypedLength } from '../../src/analytics/typed';
import type { PageEvent } from '../../src/desktop/bridge';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement;

beforeEach(() => {
  vi.useFakeTimers();
  window.__penmossAnalytics = [];
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host.remove();
  vi.useRealTimers();
});

function events(kind: string): PageEvent[] {
  flushRecorded();
  return (window.__penmossAnalytics ?? []).filter((event) => event.kind === kind);
}

/** The field's setter, as the test types through it. */
const control: { set: (value: string) => void } = { set: () => undefined };
const setText = (value: string) => control.set(value);

function Field({ initial = '' }: { readonly initial?: string }) {
  const [text, set] = useState(initial);
  useEffect(() => {
    control.set = set;
  }, [set]);
  const typed = useTypedLength('palette', 'query', text);
  return <input value={text} onChange={(event) => set(event.target.value)} {...typed} />;
}

describe('useTypedLength', () => {
  it('records the length once typing settles, never the text, and drops a repeat', () => {
    act(() => root!.render(<Field />));
    expect(host.querySelector('input')!.getAttribute('data-typed')).toBe('palette');
    for (const value of ['h', 'he', 'hel', 'hell', 'hello']) {
      act(() => setText(value));
      act(() => {
        vi.advanceTimersByTime(100);
      });
    }
    act(() => {
      vi.advanceTimersByTime(INPUT_SETTLE_MS);
    });
    act(() => setText('hellx'));
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    const input = events('input');
    expect(input.map((event) => [event.name, event.props])).toEqual([
      ['palette', { field: 'query', chars: 5 }],
    ]);
    expect(JSON.stringify(window.__penmossAnalytics)).not.toContain('hel');
  });

  it('takes the length it opened with as recorded, and sends what waits when it closes', () => {
    act(() => root!.render(<Field initial="Plans" />));
    act(() => setText('Plan'));
    act(() => setText('Plans'));
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(events('input')).toEqual([]);
    act(() => setText('Plans for'));
    act(() => root!.render(<></>));
    expect(events('input').map((event) => event.props)).toEqual([{ field: 'query', chars: 9 }]);
  });
});

describe('record with refs', () => {
  it('keeps the real ids apart from the props, in refs', () => {
    record('tree', 'expand', { depth: 1, source: 'click' }, { folder: 'folder-123' });
    record('note', 'cursor', { block: 2 }, { note: 'note-abc', folder: undefined });
    const [expand] = events('tree');
    expect(expand).toMatchObject({
      name: 'expand',
      props: { depth: 1, source: 'click' },
      refs: { folder: 'folder-123' },
    });
    const [cursor] = events('note');
    expect(cursor!.refs).toEqual({ note: 'note-abc' });
    expect(JSON.stringify(cursor!.props)).not.toContain('note-abc');
  });

  it('drops an event whose props hold an id', () => {
    record('tree', 'expand', { depth: 1, source: 'click', folder: 'folder-123' });
    expect(events('tree')).toEqual([]);
  });
});
