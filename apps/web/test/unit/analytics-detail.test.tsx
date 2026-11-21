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
import { installTypedTracking, useTypedChars, useTypedLength } from '../../src/analytics/typed';
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

/** A rich field's length (the feedback's description): null until its editor holds the draft. */
const rich: { set: (chars: number | null) => void } = { set: () => undefined };

function RichField() {
  const [chars, set] = useState<number | null>(null);
  useEffect(() => {
    rich.set = set;
  }, [set]);
  const typed = useTypedChars('feedback', 'body', chars);
  return <div contentEditable {...typed} />;
}

describe('useTypedChars', () => {
  it('starts from the length the field first has, then records its changes', () => {
    act(() => root!.render(<RichField />));
    expect(host.querySelector('div')!.getAttribute('data-typed')).toBe('feedback');
    // The draft arrives with 120 characters: that is where it opened, not typing.
    act(() => rich.set(120));
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(events('input')).toEqual([]);
    act(() => rich.set(131));
    act(() => {
      vi.advanceTimersByTime(INPUT_SETTLE_MS);
    });
    expect(events('input').map((event) => [event.name, event.props])).toEqual([
      ['feedback', { field: 'body', chars: 131 }],
    ]);
  });
});

describe('installTypedTracking', () => {
  /** A field the editor builds itself, as the selection toolbar's link form does. */
  function domField(value: string): HTMLInputElement {
    const input = document.createElement('input');
    input.type = 'url';
    input.value = value;
    input.dataset['typed'] = 'link';
    input.dataset['typedField'] = 'url';
    host.append(input);
    return input;
  }
  const typeInto = (input: HTMLInputElement, value: string) => {
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  };

  it('records a marked field by length once typing settles, from what it opened with, never the text', () => {
    const uninstall = installTypedTracking(document);
    try {
      const input = domField('example.org');
      input.focus();
      typeInto(input, 'example.or');
      typeInto(input, 'example.org');
      act(() => {
        vi.advanceTimersByTime(2000);
      });
      // Back to what it opened with: nothing new.
      expect(events('input')).toEqual([]);
      for (const value of ['penmoss.app/d', 'penmoss.app/do', 'penmoss.app/docs']) {
        typeInto(input, value);
      }
      act(() => {
        vi.advanceTimersByTime(INPUT_SETTLE_MS);
      });
      expect(events('input').map((event) => [event.name, event.props])).toEqual([
        ['link', { field: 'url', chars: 16 }],
      ]);
      expect(JSON.stringify(window.__penmossAnalytics)).not.toContain('penmoss');
    } finally {
      uninstall();
    }
  });

  it('sends what waits when the field loses focus, and leaves a field the hooks record alone', () => {
    const uninstall = installTypedTracking(document);
    try {
      const input = domField('');
      const hooked = document.createElement('input');
      hooked.dataset['typed'] = 'palette';
      host.append(hooked);
      input.focus();
      typeInto(input, 'a.io');
      input.blur();
      expect(events('input').map((event) => event.props)).toEqual([{ field: 'url', chars: 4 }]);
      hooked.focus();
      hooked.value = 'abc';
      hooked.dispatchEvent(new Event('input', { bubbles: true }));
      act(() => {
        vi.advanceTimersByTime(2000);
      });
      expect(events('input')).toHaveLength(1);
    } finally {
      uninstall();
    }
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
