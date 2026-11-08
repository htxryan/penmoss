/**
 * The app's icon set (T36, A180): the clickable prototype's own line icons
 * (prototype/index.html, `ICONS`), on a 24-unit grid with a 1.5 stroke in
 * the current colour. Icons are always decorative here: the button or link
 * around one carries its name (`aria-label`, or visible text beside it).
 */
import type { ReactNode } from 'react';

const dot = (cx: number, cy: number, r: number) => (
  <circle cx={cx} cy={cy} r={r} fill="currentColor" stroke="none" />
);

const PATHS = {
  arrowL: <path d="M19 12H5m6-6-6 6 6 6" />,
  arrowR: <path d="M5 12h14m-6-6 6 6-6 6" />,
  // A branch, for Settings → Git Mirror (T39 pass 3, A902): Android's icon there since T40 P2.
  branch: (
    <>
      <circle cx="6.5" cy="6" r="2" />
      <circle cx="6.5" cy="18" r="2" />
      <circle cx="17.5" cy="9" r="2" />
      <path d="M6.5 8v8M17.5 11c0 3-3.5 3.3-9.6 6" />
    </>
  ),
  bold: (
    <path d="M7.5 5h5.5a3.5 3.5 0 0 1 0 7H7.5zM7.5 12h6.5a3.5 3.5 0 0 1 0 7H7.5z" strokeWidth="2" />
  ),
  brush: (
    <>
      <path d="M14.5 4.5 19.5 9.5 11 18l-5-5z" />
      <path d="M6 13c-2 0-2.5 3-3 6.5 3.5-.5 6.5-1 6.5-3" />
    </>
  ),
  calendar: (
    <path d="M5.5 5h13a2 2 0 0 1 2 2v11.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2zM3.5 9.5h17M8 3v4M16 3v4" />
  ),
  check: <path d="m5 12.5 4.5 4.5L19 7.5" />,
  checklist: (
    <>
      <rect x="3.5" y="4.5" width="6" height="6" rx="1.5" />
      <path d="m4.9 7.6 1.3 1.3 2.1-2.4M13 7.5h7.5M13 16.5h7.5" />
      <rect x="3.5" y="13.5" width="6" height="6" rx="1.5" />
    </>
  ),
  chevD: <path d="m6 9 6 6 6-6" />,
  chevL: <path d="m15 6-6 6 6 6" />,
  chevR: <path d="m9 6 6 6-6 6" />,
  chevU: <path d="m6 15 6-6 6 6" />,
  // Back and Forward's halves (T52): narrow, tall chevrons, as a browser's toolbar has them.
  navBack: <path d="m14 6.5-4.5 5.5 4.5 5.5" />,
  navForward: <path d="m10 6.5 4.5 5.5-4.5 5.5" />,
  close: <path d="M6.5 6.5l11 11M17.5 6.5l-11 11" />,
  code: <path d="m8.5 8-4 4 4 4M15.5 8l4 4-4 4M13.5 5.5l-3 13" />,
  comment: (
    <path d="M5.5 5h13A1.5 1.5 0 0 1 20 6.5v8.5a1.5 1.5 0 0 1-1.5 1.5H11l-4.5 3.5v-3.5h-1A1.5 1.5 0 0 1 4 15V6.5A1.5 1.5 0 0 1 5.5 5z" />
  ),
  // Send Feedback (T62 item 7): a megaphone, apart from the comments' bubble.
  feedback: (
    <>
      <path d="M4.5 10v4a1 1 0 0 0 1 1h2L15 19.5v-15L7.5 9h-2a1 1 0 0 0-1 1z" />
      <path d="M8 15l1.3 4.2a1 1 0 0 0 1 .8h.9a.8.8 0 0 0 .8-1l-1-3.6" />
      <path d="M18.5 9.5a3.5 3.5 0 0 1 0 5" />
    </>
  ),
  command: <path d="M15 6v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3V6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3" />,
  // Copy Agent Reference (T52 item 4): an agent's ✦, as comments mark agents.
  agentRef: <path d="M12 4.5l1.9 5.6 5.6 1.9-5.6 1.9L12 19.5l-1.9-5.6L4.5 12l5.6-1.9z" />,
  copy: (
    <>
      <rect x="8.5" y="8.5" width="11" height="11" rx="2" />
      <path d="M15.5 8.5V6a1.5 1.5 0 0 0-1.5-1.5H6A1.5 1.5 0 0 0 4.5 6v8A1.5 1.5 0 0 0 6 15.5h2.5" />
    </>
  ),
  devices: (
    <>
      <rect x="2.5" y="5" width="13" height="9.5" rx="1.5" />
      <path d="M1.5 18h11" />
      <rect x="16" y="9" width="6" height="11" rx="1.5" />
    </>
  ),
  file: (
    <path d="M6.5 3.5h7l4 4V19a1.5 1.5 0 0 1-1.5 1.5H6.5A1.5 1.5 0 0 1 5 19V5a1.5 1.5 0 0 1 1.5-1.5zM13.5 3.5V8H18M8.5 12.5h7M8.5 16h5" />
  ),
  folder: (
    <path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2.2h7a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" />
  ),
  folderPlus: (
    <path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2.2h7a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2zM12 10.5v5M9.5 13h5" />
  ),
  globe: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M3.5 12h17M12 3.5c2.4 2.6 3.4 5.4 3.4 8.5s-1 5.9-3.4 8.5c-2.4-2.6-3.4-5.4-3.4-8.5s1-5.9 3.4-8.5z" />
    </>
  ),
  graph: (
    <>
      <circle cx="6" cy="7" r="2.2" />
      <circle cx="18" cy="6" r="2.2" />
      <circle cx="12" cy="17.5" r="2.5" />
      <path d="m7.1 9 3.7 6.4M17 8l-3.8 7.3M8.2 6.8l7.6-.6" />
    </>
  ),
  hash: <path d="M9.5 4 7.5 20M16.5 4l-2 16M4.5 9h15M4 15h15" />,
  history: <path d="M3.8 12a8.2 8.2 0 1 0 2.5-5.9M3.8 4.2v4h4M12 7.5V12l3 2" />,
  inbox: (
    <path d="M3.5 13.5 6 5.5h12l2.5 8V18a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 18zM3.5 13.5H8l1.5 2.5h5l1.5-2.5h4.5" />
  ),
  info: <path d="M12 3.5a8.5 8.5 0 1 1 0 17 8.5 8.5 0 0 1 0-17zM12 11v5.2M12 7.8h.01" />,
  italic: <path d="M10.5 5H18M6 19h7.5M14.5 5l-5 14" />,
  journal: (
    <path d="M6.5 3.5h11A1.5 1.5 0 0 1 19 5v14a1.5 1.5 0 0 1-1.5 1.5h-11zM6.5 3.5A1.5 1.5 0 0 0 5 5v14a1.5 1.5 0 0 0 1.5 1.5M10 8h5.5M10 11.5h4" />
  ),
  key: (
    <>
      <circle cx="8" cy="15.5" r="3.5" />
      <path d="m10.5 13 8-8M15.5 8l2.5 2.5M13.5 10l2 2" />
    </>
  ),
  keyboard: (
    <>
      <rect x="2.5" y="6" width="19" height="12" rx="2" />
      <path d="M6 10h.01M9.5 10h.01M13 10h.01M16.5 10h.01M18 10h.01M7 14h10" />
    </>
  ),
  laptop: (
    <>
      <rect x="5" y="5.5" width="14" height="9.5" rx="1.5" />
      <path d="M2.5 18.5h19" />
    </>
  ),
  link: (
    <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />
  ),
  list: (
    <>
      <path d="M9.5 6.5H20M9.5 12H20M9.5 17.5H20" />
      {dot(5, 6.5, 1.1)}
      {dot(5, 12, 1.1)}
      {dot(5, 17.5, 1.1)}
    </>
  ),
  logIn: (
    <path d="M10 4.5H6A1.5 1.5 0 0 0 4.5 6v12A1.5 1.5 0 0 0 6 19.5h4M14 16.5l4.5-4.5L14 7.5M18.5 12H9" />
  ),
  logOut: (
    <path d="M14 4.5h4A1.5 1.5 0 0 1 19.5 6v12a1.5 1.5 0 0 1-1.5 1.5h-4M10 16.5 5.5 12 10 7.5M5.5 12H15" />
  ),
  md: (
    <>
      <rect x="2.5" y="5.5" width="19" height="13" rx="2" />
      <path d="M6 15V9l2.5 3L11 9v6M16.5 9v6m-2.2-2.2 2.2 2.2 2.2-2.2" />
    </>
  ),
  menu: <path d="M4 7h16M4 12h16M4 17h16" />,
  // A notebook (T43): a bound book with a label, apart from the Journal's.
  notebook: (
    <path d="M7 3.5h10.5A1.5 1.5 0 0 1 19 5v14a1.5 1.5 0 0 1-1.5 1.5H7zM7 3.5v17M4.5 7.5h5M4.5 12h5M4.5 16.5h5M11.5 8h4.5v3h-4.5z" />
  ),
  monitor: (
    <>
      <rect x="3" y="4.5" width="18" height="12" rx="1.8" />
      <path d="M8.5 20h7M12 16.5V20" />
    </>
  ),
  // A drag handle (T53 item 8): two columns of three dots.
  grip: (
    <>
      {dot(9, 6, 1.3)}
      {dot(15, 6, 1.3)}
      {dot(9, 12, 1.3)}
      {dot(15, 12, 1.3)}
      {dot(9, 18, 1.3)}
      {dot(15, 18, 1.3)}
    </>
  ),
  moon: <path d="M19.5 14.5A7.8 7.8 0 0 1 9.5 4.5a7.8 7.8 0 1 0 10 10z" />,
  more: (
    <>
      {dot(5.5, 12, 1.3)}
      {dot(12, 12, 1.3)}
      {dot(18.5, 12, 1.3)}
    </>
  ),
  moreV: (
    <>
      {dot(12, 5.5, 1.4)}
      {dot(12, 12, 1.4)}
      {dot(12, 18.5, 1.4)}
    </>
  ),
  palette: (
    <>
      <path d="M12 3.5a8.5 8.5 0 1 0 0 17c1.2 0 1.8-.8 1.8-1.7 0-1.2-1-1.6-1-2.6 0-.9.7-1.6 1.7-1.6h2.1a3.9 3.9 0 0 0 3.9-3.9c0-4.1-3.8-7.2-8.5-7.2z" />
      <circle cx="7.8" cy="11" r="1.1" />
      <circle cx="10.5" cy="7.6" r="1.1" />
      <circle cx="15" cy="8" r="1.1" />
    </>
  ),
  panelL: (
    <>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2" />
      <path d="M9.5 4.5v15" />
    </>
  ),
  /** A note in a window of its own (T45): a window with an arrow out of its corner. */
  windowNew: (
    <>
      <path d="M11 4.5H5.5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V13" />
      <path d="M14.5 3.5h6v6M20.5 3.5 12 12" />
    </>
  ),
  panelR: (
    <>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2" />
      <path d="M14.5 4.5v15" />
    </>
  ),
  pencil: <path d="M4 20h4L19 9a2.1 2.1 0 0 0-3-3L5 17zM14 7l3 3" />,
  /** Keep on top (T46): a push pin. */
  pin: <path d="M9 4h6M10 4v5.5L6.5 13h11L14 9.5V4M12 13v7" />,
  phone: (
    <>
      <rect x="7" y="2.8" width="10" height="18.4" rx="2.2" />
      <path d="M11 18h2" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  minus: <path d="M5 12h14" />,
  // A pulse, for Settings → Status (T39 pass 3, A902): Android's; `info` is the Info panel's.
  pulse: <path d="M3.5 12.5h4l2-5 3.5 10 2.5-6.5 1.5 1.5h3.5" />,
  redo: <path d="m15 14 5-5-5-5M20 9H9.5a5.5 5.5 0 0 0 0 11H13" />,
  refresh: (
    <path d="M19.5 11A7.6 7.6 0 0 0 6 7.3L4.5 9M4.5 4.5V9H9M4.5 13A7.6 7.6 0 0 0 18 16.7l1.5-1.7M19.5 19.5V15H15" />
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="m20 20-4.2-4.2" />
    </>
  ),
  sort: <path d="M7.5 4.5v15m0 0-3-3m3 3 3-3M16.5 19.5v-15m0 0-3 3m3-3 3 3" />,
  // T51 (A935): Settings, in the sidebar's footer; eight teeth round a hub.
  gear: (
    <>
      <path d="M10.34 5.82 10.51 3.53 13.49 3.53 13.66 5.82 15.2 6.46 16.93 4.96 19.04 7.07 17.54 8.8 18.18 10.34 20.47 10.51 20.47 13.49 18.18 13.66 17.54 15.2 19.04 16.93 16.93 19.04 15.2 17.54 13.66 18.18 13.49 20.47 10.51 20.47 10.34 18.18 8.8 17.54 7.07 19.04 4.96 16.93 6.46 15.2 5.82 13.66 3.53 13.49 3.53 10.51 5.82 10.34 6.46 8.8 4.96 7.07 7.07 4.96 8.8 6.46z" />
      <circle cx="12" cy="12" r="2.6" />
    </>
  ),
  settings: (
    <>
      <path d="M4 7h9M17 7h3M4 17h3M11 17h9" />
      <circle cx="15" cy="7" r="2" />
      <circle cx="9" cy="17" r="2" />
    </>
  ),
  // T44: line symbols (Settings → Symbols, the phone's symbol button).
  star: <path d="m12 3.8 2.5 5.2 5.7.8-4.1 4 1 5.7-5.1-2.7-5.1 2.7 1-5.7-4.1-4 5.7-.8z" />,
  sun: (
    <>
      <circle cx="12" cy="12" r="3.8" />
      <path d="M12 2.8v2M12 19.2v2M2.8 12h2M19.2 12h2M5.5 5.5l1.4 1.4M17.1 17.1l1.4 1.4M5.5 18.5l1.4-1.4M17.1 6.9l1.4-1.4" />
    </>
  ),
  terminal: (
    <>
      <rect x="3" y="4.5" width="18" height="15" rx="2" />
      <path d="m7 9.5 3 2.5-3 2.5M12.5 15h4.5" />
    </>
  ),
  today: (
    <>
      <path d="M5.5 5h13a2 2 0 0 1 2 2v11.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2zM3.5 9.5h17M8 3v4M16 3v4" />
      {dot(12, 15, 1.5)}
    </>
  ),
  trash: <path d="M5 7h14M10 4h4M7 7l.8 12a1.5 1.5 0 0 0 1.5 1.4h5.4a1.5 1.5 0 0 0 1.5-1.4L17 7" />,
  undo: <path d="M9 14 4 9l5-5M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />,
  week: (
    <path d="M5.5 5h13a2 2 0 0 1 2 2v11.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2zM3.5 9.5h17M8 3v4M16 3v4M7.5 13.5h9M7.5 16.8h5" />
  ),
  widthFull: <path d="M3.5 5v14M20.5 5v14M7 12h10M9.5 9.5 7 12l2.5 2.5M14.5 9.5 17 12l-2.5 2.5" />,
} satisfies Record<string, ReactNode>;

export type IconName = keyof typeof PATHS;

export const ICON_NAMES = Object.keys(PATHS) as IconName[];

/** One icon, sized in CSS pixels (16 by default; `sm` 14, `lg` 20 through CSS). */
export function Icon({
  name,
  size = 16,
  className,
}: {
  readonly name: IconName;
  readonly size?: number;
  readonly className?: string;
}) {
  return (
    <svg
      className={className ? `i ${className}` : 'i'}
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      data-icon={name}
    >
      {PATHS[name]}
    </svg>
  );
}

/** The logo files (scripts/brand-assets.mjs): small, so the build inlines them. */
const BRAND_MARK_LIGHT = new URL('./brand-mark-light.svg', import.meta.url).href;
const BRAND_MARK_DARK = new URL('./brand-mark-dark.svg', import.meta.url).href;

/**
 * The Penmoss mark, Moss Pen (A402, docs/brand.md): the logo tile's small cut. Its
 * colours are the brand's, not the theme's, so it is drawn from the logo files, which
 * hold them; the stylesheet shows the light or the dark one with the page's mode.
 */
export function BrandMark({ size = 20 }: { readonly size?: number }) {
  return (
    <span className="brand-mark" aria-hidden="true">
      <img className="brand-mark-light" src={BRAND_MARK_LIGHT} alt="" width={size} height={size} />
      <img className="brand-mark-dark" src={BRAND_MARK_DARK} alt="" width={size} height={size} />
    </span>
  );
}
