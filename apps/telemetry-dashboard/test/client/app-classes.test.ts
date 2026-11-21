// @vitest-environment happy-dom
// The replay's frame (PEN-178) is the app's own markup written again by hand, a stated exception
// to A1564: this fails when a class or attribute the frame uses is no longer in the app's
// stylesheets (apps/web/src, in the order the app loads them), so a change to the app's CSS that
// the frame would silently miss breaks the dashboard's tests instead. The frame's own classes
// (pf-) are frame.css's.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import { frameData, type FrameData } from '../../src/client/replay/frame-data';
import { frameMarkup } from '../../src/client/replay/frame-draw';
import { createReplay, type Frame } from '../../src/client/replay/state';
import { FIXTURE_SESSIONS, timelineEvents } from '../fixtures/sessions';

const repo = join(__dirname, '..', '..', '..', '..');
// The app's stylesheets in the order it loads them, as build.mjs puts them in the frame.
const { appStylesheets } = (await import(
  pathToFileURL(join(repo, 'scripts', 'design-system.mjs')).href
)) as { appStylesheets: () => string[] };
const appCss = ['apps/web/src/theme/defaults.css', ...appStylesheets()]
  .map((path) => readFileSync(join(repo, path), 'utf8'))
  .join('\n')
  .replace(/\/\*[\s\S]*?\*\//g, '');
const frameCss = readFileSync(
  join(__dirname, '..', '..', 'src', 'client', 'replay', 'frame.css'),
  'utf8',
);

/**
 * Classes the app renders without styling them itself: they are in its markup (named in its
 * source) and are drawn so the structure matches. Each must still be in apps/web/src.
 */
const UNSTYLED = new Set<string>([
  'keep-on-top', // KeepOnTopButton's
  'sb-graph', // SidebarShortcuts' Graph link
  'sb-recent', // RecentSection's
  'sb-section-body', // a notebook's section body (SidebarSections)
  'palette', // the pickers' dialog (Palette, SearchOverlay)
]);

/** The app's TypeScript sources, where an unstyled class must still be written. */
function sources(dir: string): string {
  let text = '';
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) text += sources(path);
    else if (/\.tsx?$/.test(entry.name)) text += readFileSync(path, 'utf8');
  }
  return text;
}

let data: FrameData;
beforeAll(() => {
  data = frameData();
});

/** Every state the frame draws: each event of every recorded session, and each kind of dialog. */
function frames(): Frame[] {
  const out: Frame[] = [];
  for (const fixture of Object.values(FIXTURE_SESSIONS)) {
    if (fixture.client.client !== 'mac' && fixture.client.client !== 'android') continue;
    const replay = createReplay(timelineEvents(fixture));
    for (const t of replay.times) out.push(replay.frameAt(t));
  }
  const base = out[10]!;
  for (const name of [
    'palette',
    'quickOpen',
    'recent',
    'search',
    'confirm',
    'move',
    'cheatsheet',
  ]) {
    out.push({ ...base, dialogs: [{ name, field: 'query', chars: 5 }] });
    out.push({ ...base, dialogs: [{ name, field: null, chars: null }] });
  }
  out.push({
    ...base,
    window: { width: 1440, height: 900, recorded: true },
    layout: { ...base.layout, sidebar: 'hidden' },
  });
  return out;
}

const escapeRe = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

describe("the frame's markup", () => {
  it("uses only classes the app's stylesheets still have", () => {
    const host = document.createElement('div');
    const classes = new Set<string>();
    const attributes = new Set<string>();
    for (const frame of frames()) {
      host.innerHTML = frameMarkup(frame, data);
      for (const element of host.querySelectorAll('*')) {
        for (const name of element.classList) classes.add(name);
        for (const attr of [
          'data-panel',
          'data-width',
          'data-sidebar',
          'data-drawer',
          'data-type',
          'data-callout-type',
          'data-pinned',
        ]) {
          if (element.hasAttribute(attr)) attributes.add(`${attr}=${element.getAttribute(attr)}`);
        }
      }
    }
    expect(classes.size).toBeGreaterThan(100);
    const missing: string[] = [];
    for (const name of classes) {
      if (name === 'i') continue; // The icon's own class (Icon.tsx).
      const css = name.startsWith('pf-') ? frameCss : appCss;
      if (UNSTYLED.has(name)) continue;
      if (!new RegExp(`\\.${escapeRe(name)}(?![\\w-])`).test(css)) missing.push(name);
    }
    expect(missing, 'classes the frame uses that the app no longer styles').toEqual([]);
    const app = sources(join(repo, 'apps', 'web', 'src'));
    for (const name of UNSTYLED) {
      expect(
        new RegExp(`['"\`\\s]${escapeRe(name)}['"\`\\s]`).test(app),
        `${name} in apps/web/src`,
      ).toBe(true);
    }
    const missingAttributes: string[] = [];
    // A closed panel is the app's own default: its CSS keys on `open` alone.
    attributes.delete('data-panel=closed');
    for (const pair of attributes) {
      const [attr, value] = pair.split('=') as [string, string];
      const found =
        value === ''
          ? new RegExp(`\\[${attr}\\]`).test(appCss)
          : new RegExp(`\\[${attr}=['"]?${escapeRe(value)}['"]?\\]`).test(appCss);
      if (!found) missingAttributes.push(pair);
    }
    expect(missingAttributes, 'attribute selectors the frame relies on').toEqual([]);
  });
});
