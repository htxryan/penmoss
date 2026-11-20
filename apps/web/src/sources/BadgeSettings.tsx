import { Icon } from '@penmoss/ui/icons';
import { useId, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { ColourPicker } from '../shell/ColourPicker';
import { SettingRow } from '../theme/look-rows';
import { PreviewZoom } from '../theme/PreviewZoom';
import {
  BADGE_PRESETS,
  FIRST_BADGE_ICON,
  defaultBadge,
  glyphInk,
  setNotebookBadge,
  useNotebookBadge,
  type BadgeGlyph,
  type BadgeGlyphKind,
} from './badge';
import { BadgeIconChooser } from './BadgeIconChooser';
import type { GitSource } from './git-source';
import { BadgeView } from './NotebookBadge';
import { PreviewCommands } from '../commands/CommandsRoot';
import { useNoteList } from '../notes/hooks';
import { displayTitle } from '../notes/list';
import type { TabFace } from '../tabs/describe';
import { TabFaceView } from '../tabs/TabStrip';
import { SourceScope } from './context';
import { SourceSection } from './SourceSection';

const KINDS: ReadonlyArray<{ readonly kind: BadgeGlyphKind; readonly label: string }> = [
  { kind: 'letter', label: 'Letter' },
  { kind: 'number', label: 'Number' },
  { kind: 'icon', label: 'Icon' },
];

/** Arrow keys along a one-row radio group (the presets): focus and choose, as radios do. */
function onRowKeyDown(event: KeyboardEvent<HTMLElement>): void {
  const items = [...event.currentTarget.querySelectorAll<HTMLElement>('[role="radio"]')];
  const at = items.indexOf(document.activeElement as HTMLElement);
  if (at < 0) return;
  const step =
    event.key === 'ArrowRight' || event.key === 'ArrowDown'
      ? 1
      : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
        ? -1
        : 0;
  if (step === 0) return;
  event.preventDefault();
  const next = items[(at + step + items.length) % items.length]!;
  next.focus();
  next.click();
}

/**
 * A notebook's Badge (PEN-140, ac17), rows in the first group of its page's Overview in Settings:
 * a preview (alone, then on the sidebar's own row and the strip's own tab, A1564) with Reset to
 * Default, its colour (ten presets, or Custom… with the colour picker), and what it shows (a
 * letter, a number from 0 to 99, or an icon from the icon picker, A1568) with its field or its icon.
 * Each change is written at once to the notebook's own settings, so it syncs with it (A827).
 */
export function BadgeSettings({ source }: { source: GitSource }) {
  const id = useId();
  const badge = useNotebookBadge(source);
  // What is typed in the letter and number fields, while it is not a glyph yet (empty, 100).
  const [letterText, setLetterText] = useState<string | null>(null);
  const [numberText, setNumberText] = useState<string | null>(null);
  if (!badge) return null;
  const { glyph } = badge;
  const fallback = defaultBadge(source.id, source.name);
  const setGlyph = (next: BadgeGlyph) => {
    // The default (the name's first letter) is never written: a rename still changes it.
    const same = next.kind === fallback.glyph.kind && next.value === fallback.glyph.value;
    setNotebookBadge(source, { glyph: same ? null : next });
  };
  const chooseKind = (kind: BadgeGlyphKind) => {
    if (kind === glyph.kind) return;
    setLetterText(null);
    setNumberText(null);
    if (kind === fallback.glyph.kind) setGlyph(fallback.glyph);
    else if (kind === 'letter') setGlyph({ kind, value: fallback.glyph.value });
    else if (kind === 'number') setGlyph({ kind, value: '1' });
    else setGlyph({ kind, value: FIRST_BADGE_ICON });
  };
  const preset = BADGE_PRESETS.find((each) => each.id === badge.preset) ?? null;
  const name = source.name;
  return (
    <>
      <SettingRow
        setting="badge"
        label="Badge"
        testId="badge-row"
        help="Shown before the notebook’s name in the sidebar and on its notes’ tabs. Changes sync with the notebook to your other Macs."
      >
        <div
          className="badge-preview"
          aria-label="Preview"
          role="group"
          data-testid="badge-preview"
        >
          <BadgeView badge={badge} name={name} size={26} />
          <PreviewZoom name="Badge" testId="badge-preview-zoom">
            {(enlarged) => <BadgePlaces source={source} enlarged={enlarged} />}
          </PreviewZoom>
        </div>
        <button
          data-event="settings.git-notebooks.badge.reset"
          data-ui="item"
          type="button"
          className="btn"
          disabled={!badge.custom}
          data-testid="badge-reset"
          onClick={() => {
            setLetterText(null);
            setNumberText(null);
            setNotebookBadge(source, { color: null, glyph: null });
          }}
        >
          Reset to Default
        </button>
      </SettingRow>
      <SettingRow
        setting="badge-colour"
        label="Colour"
        labelId={`${id}-colour`}
        testId="badge-colour-row"
      >
        <div
          className="badge-swatches"
          role="radiogroup"
          aria-labelledby={`${id}-colour`}
          onKeyDown={onRowKeyDown}
        >
          {BADGE_PRESETS.map((each, index) => {
            const checked = badge.preset === each.id;
            const current = preset ? checked : index === 0;
            return (
              <button
                data-event="settings.git-notebooks.badge.preset"
                key={each.id}
                type="button"
                role="radio"
                className="badge-swatch"
                data-ui="option"
                aria-checked={checked}
                aria-label={each.label}
                data-tip={each.label}
                tabIndex={current ? 0 : -1}
                data-testid={`badge-preset-${each.id}`}
                style={
                  {
                    '--nb-badge-bg': each.hex,
                    '--nb-badge-ink': glyphInk(each.hex),
                  } as CSSProperties
                }
                onClick={() => {
                  if (checked) return;
                  setNotebookBadge(source, {
                    color: each.id === fallback.preset ? null : each.id,
                  });
                }}
              >
                {checked ? <Icon name="check" size={14} /> : null}
              </button>
            );
          })}
        </div>
        <ColourPicker
          label="Custom Colour"
          value={badge.preset ?? badge.color}
          valueLabel={preset ? 'Custom…' : badge.color.toUpperCase()}
          css={badge.color}
          swatches={BADGE_PRESETS.map((each) => ({
            value: each.id,
            label: each.label,
            css: each.hex,
          }))}
          testId="badge-custom"
          onChange={(value) => {
            // A badge is opaque: the picker's opacity is left out.
            const color = value.startsWith('#') ? value.slice(0, 7) : value;
            setNotebookBadge(source, { color: color === fallback.preset ? null : color });
          }}
        />
      </SettingRow>
      <SettingRow
        setting="badge-shows"
        label="Shows"
        labelId={`${id}-shows`}
        testId="badge-shows-row"
      >
        {/* A segmented control from real radios, the chosen kind in the accent (ac17, A988). */}
        <span
          className="segmented badge-kind-segments"
          role="radiogroup"
          aria-labelledby={`${id}-shows`}
        >
          {KINDS.map((each) => (
            <label key={each.kind} className="segment badge-kind">
              <input
                data-event="settings.git-notebooks.badge.kind"
                type="radio"
                name={`${id}-kind`}
                checked={glyph.kind === each.kind}
                data-testid={`badge-kind-${each.kind}`}
                onChange={() => chooseKind(each.kind)}
              />
              <span data-label={each.label}>{each.label}</span>
            </label>
          ))}
        </span>
      </SettingRow>
      {glyph.kind === 'letter' ? (
        <SettingRow
          setting="badge-letter"
          label="Letter"
          labelFor={`${id}-letter`}
          help="One character."
          helpId={`${id}-letter-help`}
        >
          <input
            id={`${id}-letter`}
            className="input badge-field"
            value={letterText ?? glyph.value}
            maxLength={4}
            autoComplete="off"
            spellCheck={false}
            aria-describedby={`${id}-letter-help`}
            data-testid="badge-letter"
            onChange={(event) => {
              const text = event.target.value;
              // The last character typed: typing over the one there replaces it.
              const chars = [...text.trim()];
              const last = chars.at(-1);
              setLetterText(last ?? '');
              if (last) {
                setLetterText(null);
                setGlyph({ kind: 'letter', value: last });
              }
            }}
            onBlur={() => setLetterText(null)}
          />
        </SettingRow>
      ) : glyph.kind === 'number' ? (
        <SettingRow
          setting="badge-number"
          label="Number"
          labelFor={`${id}-number`}
          help="From 0 to 99."
          helpId={`${id}-number-help`}
        >
          <input
            id={`${id}-number`}
            className="input badge-field"
            type="number"
            min={0}
            max={99}
            step={1}
            inputMode="numeric"
            value={numberText ?? glyph.value}
            aria-describedby={`${id}-number-help`}
            data-testid="badge-number"
            onChange={(event) => {
              const text = event.target.value;
              setNumberText(text);
              if (/^(0|[1-9][0-9]?)$/.test(text)) setGlyph({ kind: 'number', value: text });
            }}
            onBlur={() => setNumberText(null)}
          />
        </SettingRow>
      ) : (
        <SettingRow setting="badge-icon" label="Icon" labelId={`${id}-icon`}>
          <BadgeIconChooser
            value={glyph.value}
            labelledBy={`${id}-icon`}
            onChoose={(value) => setGlyph({ kind: 'icon', value })}
          />
        </SettingRow>
      )}
    </>
  );
}

const ignore = () => undefined;

/**
 * The badge where it shows (A1564): the notebook's own row in the sidebar (`SourceSection`, its
 * name's row alone) and a tab of one of its notes (`TabFaceView`), each the app's component,
 * inert, so a change shows exactly as the app will show it.
 */
function BadgePlaces({
  source,
  enlarged = false,
}: {
  readonly source: GitSource;
  /** In the larger preview's dialog (A1589): twice the size, to see the badge's detail. */
  readonly enlarged?: boolean;
}) {
  return (
    <PreviewCommands>
      <span
        className={enlarged ? 'badge-preview-places large' : 'badge-preview-places'}
        data-testid={enlarged ? 'badge-preview-large' : 'badge-preview-places'}
        inert
        aria-hidden="true"
      >
        <span className="sidebar badge-preview-sidebar">
          <SourceScope source={source}>
            <SourceSection
              source={source}
              activeId={null}
              currentFolder={null}
              onCurrentFolderChange={ignore}
              active={false}
              shown={false}
              headOnly
            />
          </SourceScope>
        </span>
        <span className="tab-strip badge-preview-strip">
          <SourceScope source={source}>
            <PreviewTab source={source} />
          </SourceScope>
        </span>
      </span>
    </PreviewCommands>
  );
}

/** A tab of the notebook's first note, as the strip draws it (active). */
function PreviewTab({ source }: { readonly source: GitSource }) {
  const first = useNoteList()[0];
  const face: TabFace = {
    id: 'badge-preview',
    kind: 'note',
    title: displayTitle(first?.title ?? ''),
    source,
    folders: [],
    suffix: null,
    number: null,
    pinned: false,
    active: true,
  };
  return (
    <span className="tab" aria-selected="true" data-kind="note">
      <TabFaceView face={face} />
    </span>
  );
}
