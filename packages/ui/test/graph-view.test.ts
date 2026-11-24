import { afterEach, describe, expect, it, vi } from 'vitest';
import { clampZoom, MAX_ZOOM, MIN_ZOOM, openingTicks, SMALL_GRAPH } from '../src/graph/view';

describe('the graph view rules the Mac and the phone share', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('keeps the zoom between its limits', () => {
    expect(clampZoom(0)).toBe(MIN_ZOOM);
    expect(clampZoom(1)).toBe(1);
    expect(clampZoom(100)).toBe(MAX_ZOOM);
  });

  it('opens a small graph settled and a large one moving, unless motion is reduced', () => {
    vi.stubGlobal('matchMedia', () => ({ matches: false }));
    expect(openingTicks(SMALL_GRAPH)).toBe(300);
    expect(openingTicks(SMALL_GRAPH + 1)).toBe(40);
    vi.stubGlobal('matchMedia', (query: string) => ({ matches: query.includes('reduce') }));
    expect(openingTicks(SMALL_GRAPH + 1)).toBe(300);
  });
});
