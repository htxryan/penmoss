/**
 * The colour picker (T51 item 10, A939): a button showing the colour, opening a popover with
 * the theme's colours as swatches and any colour of one's own: a colour wheel (hue around,
 * saturation out from the centre), a brightness slider, an opacity slider and a hex field
 * taking #RGB, #RRGGBB or #RRGGBBAA. A custom colour is given as `#rrggbb`, or `#rrggbbaa`
 * when it is not opaque, lower case.
 *
 * Every part works from the keyboard: arrows across the swatches; on the wheel, left and right
 * turn the hue and up and down change the saturation (Shift for bigger steps); the sliders are
 * native ranges. A drag or a key changes a draft the popover shows, given out when it ends
 * (the pointer lifted, the key let go), so a drag is one change, not hundreds.
 */
import { Icon } from '@penmoss/ui/icons';
import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
} from 'react';
import { hexToHsv, hsvToHex, normaliseHex, wheelPoint, wheelPosition, type Hsva } from './colour';
import { onGridKeyDown, usePopover } from './popover';

export interface ColourSwatch {
  /** What `onChange` gives for it (a theme colour's key). */
  readonly value: string;
  readonly label: string;
  /** Its CSS colour (`var(--pm-accent)`). */
  readonly css: string;
}

/** Swatches per row: the arrow keys move by this many up and down. */
const SWATCH_COLUMNS = 6;

/** A theme colour's value on this page, for the custom section to start from. */
function resolvedHex(css: string): string | null {
  const name = /^var\((--[\w-]+)\)$/.exec(css)?.[1];
  if (!name || typeof document === 'undefined') return normaliseHex(css);
  return normaliseHex(getComputedStyle(document.documentElement).getPropertyValue(name));
}

const GREY: Hsva = { h: 0, s: 0, v: 0.5, a: 1 };

/**
 * The colour space's own colours, which the wheel, the sliders and the checks behind a
 * see-through colour are drawn in, the same in every theme: computed, as they are the
 * picker's subject rather than the interface's colours (T28's rule on literal colours).
 */
const grey = (v: number) => hsvToHex({ h: 0, s: 0, v, a: 1 });
const SPACE_VARS = {
  '--cp-white': grey(1),
  '--cp-black': grey(0),
  '--cp-check': grey(0.8),
  '--cp-hues': Array.from({ length: 7 }, (_, at) =>
    hsvToHex({ h: at * 60, s: 1, v: 1, a: 1 }),
  ).join(', '),
};

export function ColourPicker({
  label,
  value,
  valueLabel,
  css,
  swatches,
  onChange,
  disabled = false,
  testId,
}: {
  /** The button's and the popover's accessible name ("Colour of ★"). */
  readonly label: string;
  /** A swatch's value, or a custom `#rrggbb(aa)`. */
  readonly value: string;
  /** What the button says the colour is ("Orange", "#3366CC"). */
  readonly valueLabel: string;
  /** The colour as CSS, for the button's dot. */
  readonly css: string;
  readonly swatches: readonly ColourSwatch[];
  readonly onChange: (value: string) => void;
  readonly disabled?: boolean;
  readonly testId?: string;
}) {
  const id = useId();
  // A hex typed but not entered is kept when the picker closes, a press outside included.
  const { open, setOpen, button, panel, close, onPanelKeyDown } = usePopover({
    beforeClose: () => commitHex(),
  });
  const swatch = swatches.find((each) => each.value === value) ?? null;
  // The draft the custom section shows: from the value, unless it already is the value (so a
  // grey keeps the hue it was dragged to).
  const seed = (): Hsva => hexToHsv(swatch ? (resolvedHex(swatch.css) ?? '') : value) ?? GREY;
  const [draft, setShownDraft] = useState<Hsva>(seed);
  // The latest draft, for giving it out from a handler that runs before the next render (a
  // key let go in the same moment it was pressed).
  const latest = useRef(draft);
  const setDraft = (next: Hsva) => {
    latest.current = next;
    setShownDraft(next);
  };
  const [seededFor, setSeededFor] = useState(value);
  if (seededFor !== value) {
    setSeededFor(value);
    if (swatch || hsvToHex(draft) !== value) setShownDraft(seed());
  }
  useLayoutEffect(() => {
    latest.current = draft;
  });
  const draftHex = hsvToHex(draft);
  const [hexText, setHexText] = useState<string | null>(null);
  const [hexProblem, setHexProblem] = useState<string | null>(null);

  const give = (next: Hsva = latest.current) => {
    const hex = hsvToHex(next);
    if (hex !== value) onChange(hex);
  };
  const openPanel = () => {
    setDraft(seed());
    setHexText(null);
    setHexProblem(null);
    setOpen(true);
    // Focus the chosen swatch, else the first, once the panel is drawn.
    requestAnimationFrame(() => {
      const drawn = panel.current;
      (
        drawn?.querySelector<HTMLElement>('[data-grid-item][aria-checked="true"]') ??
        drawn?.querySelector<HTMLElement>('[data-grid-item]')
      )?.focus();
    });
  };

  const fromPointer = (event: PointerEvent<HTMLDivElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    const radius = box.width / 2;
    const { h, s } = wheelPoint(
      event.clientX - box.left - radius,
      event.clientY - box.top - radius,
      radius,
    );
    const next = { ...draft, h, s, v: draft.v === 0 ? 1 : draft.v };
    setDraft(next);
    return next;
  };
  const onWheelKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 10 : 1;
    let next: Hsva | null = null;
    if (event.key === 'ArrowRight') next = { ...draft, h: (draft.h + step) % 360 };
    else if (event.key === 'ArrowLeft') next = { ...draft, h: (draft.h - step + 360) % 360 };
    else if (event.key === 'ArrowUp')
      next = { ...draft, s: Math.min(1, Math.round(draft.s * 100 + step) / 100) };
    else if (event.key === 'ArrowDown')
      next = { ...draft, s: Math.max(0, Math.round(draft.s * 100 - step) / 100) };
    if (!next) return;
    event.preventDefault();
    setDraft(next);
  };

  const commitHex = () => {
    if (hexText === null) return;
    const hex = normaliseHex(hexText);
    if (!hex) {
      setHexProblem('Use #RGB, #RRGGBB or #RRGGBBAA.');
      return;
    }
    setHexProblem(null);
    setHexText(null);
    const next = hexToHsv(hex)!;
    setDraft(next);
    give(next);
  };

  const radius = 72;
  const thumb = wheelPosition(draft.h, draft.s, radius);
  const vars = {
    ...SPACE_VARS,
    '--cp-colour': draftHex,
    '--cp-solid': hsvToHex({ ...draft, a: 1 }),
    '--cp-bright': hsvToHex({ ...draft, v: 1, a: 1 }),
    '--cp-dim': String(1 - draft.v),
  } as CSSProperties;
  const percent = (fraction: number) => Math.round(fraction * 100);

  return (
    <span className="colour-anchor">
      <button
        ref={button}
        type="button"
        className="btn colour-trigger"
        data-ui="menu"
        aria-label={`${label}: ${valueLabel}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? `${id}-panel` : undefined}
        data-tip={label}
        disabled={disabled}
        data-testid={testId}
        onClick={() => (open ? close(false) : openPanel())}
      >
        <span className="colour-dot" style={{ background: css }} aria-hidden="true" />
        <span className="colour-trigger-label">{valueLabel}</span>
        <Icon name="chevD" size={12} />
      </button>
      {open ? (
        <div
          ref={panel}
          id={`${id}-panel`}
          className="colour-popover"
          role="dialog"
          aria-label={label}
          data-testid={testId ? `${testId}-picker` : undefined}
          style={vars}
          onKeyDown={onPanelKeyDown}
        >
          <div
            className="colour-swatches"
            role="radiogroup"
            aria-label="Theme colours"
            onKeyDown={(event) => onGridKeyDown(event, SWATCH_COLUMNS)}
          >
            {swatches.map((each, index) => {
              const checked = each.value === value;
              const current = swatch ? checked : index === 0;
              return (
                <button
                  key={each.value}
                  type="button"
                  role="radio"
                  className="colour-swatch"
                  data-ui="option"
                  aria-checked={checked}
                  aria-label={each.label}
                  data-tip={each.label}
                  data-grid-item=""
                  data-colour={each.value}
                  tabIndex={current ? 0 : -1}
                  style={{ background: each.css }}
                  onClick={() => {
                    if (!checked) onChange(each.value);
                    close(true);
                  }}
                >
                  {checked ? <Icon name="check" size={14} /> : null}
                </button>
              );
            })}
          </div>
          <div
            className="colour-custom"
            role="group"
            aria-labelledby={`${id}-custom`}
            onPointerUp={(event) => {
              if ((event.target as HTMLElement).closest('.colour-hex')) return;
              give();
            }}
            onKeyUp={(event) => {
              if ((event.target as HTMLElement).closest('.colour-hex')) return;
              if (/^(Arrow|Home|End|Page)/.test(event.key)) give();
            }}
          >
            <span id={`${id}-custom`} className="colour-custom-title">
              Custom
            </span>
            <div className="colour-custom-row">
              <div
                className="colour-wheel"
                role="slider"
                tabIndex={0}
                aria-label="Hue and saturation"
                aria-valuemin={0}
                aria-valuemax={359}
                aria-valuenow={Math.round(draft.h)}
                aria-valuetext={`Hue ${Math.round(draft.h)}°, saturation ${percent(draft.s)}%`}
                data-testid={testId ? `${testId}-wheel` : undefined}
                style={{ width: radius * 2, height: radius * 2 }}
                onKeyDown={onWheelKey}
                onPointerDown={(event) => {
                  event.currentTarget.setPointerCapture?.(event.pointerId);
                  event.currentTarget.focus();
                  fromPointer(event);
                }}
                onPointerMove={(event) => {
                  if (event.currentTarget.hasPointerCapture?.(event.pointerId)) fromPointer(event);
                }}
              >
                <span
                  className="colour-wheel-thumb"
                  aria-hidden="true"
                  style={{ left: radius + thumb.x, top: radius + thumb.y }}
                />
              </div>
              <div className="colour-sliders">
                <span className="colour-preview" aria-hidden="true" />
                <label className="colour-slider">
                  <span>Brightness</span>
                  <input
                    type="range"
                    className="colour-range colour-range-value"
                    min={0}
                    max={100}
                    value={percent(draft.v)}
                    aria-valuetext={`${percent(draft.v)}%`}
                    onChange={(event) =>
                      setDraft({ ...draft, v: Number(event.target.value) / 100 })
                    }
                  />
                </label>
                <label className="colour-slider">
                  <span>Opacity</span>
                  <input
                    type="range"
                    className="colour-range colour-range-alpha"
                    min={0}
                    max={100}
                    value={percent(draft.a)}
                    aria-valuetext={`${percent(draft.a)}%`}
                    data-testid={testId ? `${testId}-alpha` : undefined}
                    onChange={(event) =>
                      setDraft({ ...draft, a: Number(event.target.value) / 100 })
                    }
                  />
                </label>
                <label className="colour-slider colour-hex">
                  <span>Hex</span>
                  <input
                    className="input"
                    value={hexText ?? draftHex.toUpperCase()}
                    maxLength={9}
                    spellCheck={false}
                    autoComplete="off"
                    aria-invalid={hexProblem ? true : undefined}
                    aria-describedby={hexProblem ? `${id}-hex-problem` : undefined}
                    data-testid={testId ? `${testId}-hex` : undefined}
                    onChange={(event) => {
                      setHexText(event.target.value);
                      setHexProblem(null);
                    }}
                    onBlur={commitHex}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault();
                        commitHex();
                      }
                    }}
                  />
                </label>
              </div>
            </div>
            {hexProblem ? (
              <span id={`${id}-hex-problem`} className="colour-problem" role="alert">
                {hexProblem}
              </span>
            ) : null}
          </div>
        </div>
      ) : null}
    </span>
  );
}
