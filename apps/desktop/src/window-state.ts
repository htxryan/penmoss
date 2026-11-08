/**
 * The main window's size and place, kept between launches (T29). A saved
 * place that no display shows any more (a monitor unplugged) is dropped, so
 * the window opens centred instead of off screen. Since T46 it also keeps whether the main
 * window is pinned above other apps (A721); note windows are never saved here.
 */
import { readFileSync, renameSync, writeFileSync } from 'node:fs';

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface WindowState {
  readonly x?: number;
  readonly y?: number;
  readonly width: number;
  readonly height: number;
  readonly maximized: boolean;
  readonly fullScreen: boolean;
  /** Keep on top (T46, A721): the main window floats above other apps' windows. */
  readonly keepOnTop: boolean;
}

export const DEFAULT_WINDOW: WindowState = {
  width: 1200,
  height: 800,
  maximized: false,
  fullScreen: false,
  keepOnTop: false,
};
export const MIN_WIDTH = 480;
export const MIN_HEIGHT = 360;
/** How much of the title bar must be on some display for a saved place to count. */
const VISIBLE_W = 120;
const VISIBLE_H = 40;

const finite = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

/** Parses saved state, ignoring anything malformed. */
export function parseWindowState(raw: unknown): WindowState {
  if (typeof raw !== 'object' || raw === null) return DEFAULT_WINDOW;
  const value = raw as Record<string, unknown>;
  const width = finite(value['width']) ? value['width'] : DEFAULT_WINDOW.width;
  const height = finite(value['height']) ? value['height'] : DEFAULT_WINDOW.height;
  const state: WindowState = {
    width: Math.max(MIN_WIDTH, Math.round(width)),
    height: Math.max(MIN_HEIGHT, Math.round(height)),
    maximized: value['maximized'] === true,
    fullScreen: value['fullScreen'] === true,
    keepOnTop: value['keepOnTop'] === true,
  };
  return finite(value['x']) && finite(value['y'])
    ? { ...state, x: Math.round(value['x']), y: Math.round(value['y']) }
    : state;
}

/** The state to open with on these displays' work areas. */
export function fitToDisplays(state: WindowState, workAreas: readonly Rect[]): WindowState {
  const largest = workAreas.reduce<Rect | null>(
    (best, area) => (!best || area.width * area.height > best.width * best.height ? area : best),
    null,
  );
  const width = largest ? Math.min(state.width, largest.width) : state.width;
  const height = largest ? Math.min(state.height, largest.height) : state.height;
  const { x, y } = state;
  const sized: WindowState = {
    width,
    height,
    maximized: state.maximized,
    fullScreen: state.fullScreen,
    keepOnTop: state.keepOnTop,
  };
  if (x === undefined || y === undefined) return sized;
  const visible = workAreas.some((area) => {
    const left = Math.max(x, area.x);
    const right = Math.min(x + width, area.x + area.width);
    const top = Math.max(y, area.y);
    const bottom = Math.min(y + VISIBLE_H, area.y + area.height);
    return right - left >= VISIBLE_W && bottom - top >= VISIBLE_H / 2;
  });
  return visible ? { ...sized, x, y } : sized;
}

export function loadWindowState(file: string): WindowState {
  try {
    return parseWindowState(JSON.parse(readFileSync(file, 'utf8')));
  } catch {
    return DEFAULT_WINDOW;
  }
}

export function saveWindowState(file: string, state: WindowState): void {
  const temp = `${file}.tmp`;
  writeFileSync(temp, JSON.stringify(state), { mode: 0o600 });
  renameSync(temp, file);
}
