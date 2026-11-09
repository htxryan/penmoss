import type { Context2D, DrawState } from '../../src/graph/renderer';

/** A 2D context that records calls (canvas is not available in Node). */
export function recorder() {
  const calls: string[] = [];
  const texts: string[] = [];
  const props: Record<string, unknown> = {
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    globalAlpha: 1,
    font: '',
    textAlign: 'start',
    textBaseline: 'alphabetic',
    lineJoin: 'miter',
  };
  const ctx = new Proxy(props, {
    get(target, key: string): unknown {
      if (key in target) return target[key];
      return (...args: unknown[]) => {
        calls.push(key);
        if (key === 'fillText') texts.push(String(args[0]));
        return key === 'measureText' ? { width: 10 } : undefined;
      };
    },
    set(target, key: string, value: unknown) {
      target[key] = value;
      return true;
    },
  });
  return { ctx: ctx as unknown as Context2D, calls, texts };
}

export const state = (over: Partial<DrawState> = {}): DrawState => ({
  transform: { x: 0, y: 0, k: 1 },
  hovered: null,
  focused: null,
  centre: null,
  neighbours: null,
  ...over,
});
