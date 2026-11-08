/**
 * Settings → Appearance → Fonts (T51 item 16, A944): the Interface Font, the Note Font and the
 * Note Font Size, three synced settings laid over the theme's fonts on every device. A font is
 * the theme's own, a preset (each offered in its own letters) or a family typed in; the size
 * runs from 12 to 28 px. A sample line shows each choice as it will look.
 */
import {
  CUSTOM_FONT_PREFIX,
  FONT_PRESET_LABELS,
  FONT_PRESETS,
  INTERFACE_FONT_SETTING,
  MAX_FONT_FAMILY_CHARS,
  NOTE_FONT_SETTING,
  NOTE_FONT_SIZE,
  NOTE_FONT_SIZE_SETTING,
  customFamily,
  fontChoiceOf,
  fontFamilyProblem,
  fontStack,
  noteFontSizeOf,
  type FontChoice,
  type FontPreset,
} from '@penmoss/core/fonts';
import { Select } from '@penmoss/ui/controls/Select';
import { Icon } from '@penmoss/ui/icons';
import { useId, useState } from 'react';
import { useWorkspace } from '../workspace/hooks';
import { useThemeState } from './hooks';

/** The select's value for a family typed in. */
const CUSTOM = 'custom';

const SAMPLE = 'The quick brown fox jumps over the lazy dog. 0123456789';

/** A rule's words as a sentence: "Font name is longer than 64 characters." */
const sentence = (problem: string) => `${problem.charAt(0).toUpperCase()}${problem.slice(1)}.`;

type FontKey = typeof INTERFACE_FONT_SETTING | typeof NOTE_FONT_SETTING;

function FontField({
  settingKey,
  label,
  themeStack,
  testId,
}: {
  readonly settingKey: FontKey;
  readonly label: string;
  /** The theme's own font for this, shown for Theme Default. */
  readonly themeStack: string;
  readonly testId: string;
}) {
  const workspace = useWorkspace();
  const id = useId();
  const stored = fontChoiceOf(workspace.settings(), settingKey);
  const family = customFamily(stored);
  // "Custom…" chosen with no family typed yet: the field shows, nothing is stored.
  const [customOpen, setCustomOpen] = useState(false);
  const [draft, setDraft] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const custom = family !== null || customOpen;
  const store = (choice: FontChoice) =>
    // The theme's own is no setting at all, as before any was made.
    workspace.setSetting(settingKey, choice === 'theme' ? undefined : choice);
  const stackOf = (preset: FontPreset) => fontStack(preset) ?? themeStack;
  const shown = custom
    ? (fontStack(`${CUSTOM_FONT_PREFIX}${(draft ?? family ?? '').trim() || 'x'}` as FontChoice) ??
      themeStack)
    : stackOf(stored as FontPreset);
  const commit = () => {
    if (draft === null) return;
    const trimmed = draft.trim();
    const refused = fontFamilyProblem(trimmed);
    if (refused) {
      setProblem(sentence(refused));
      return;
    }
    setProblem(null);
    setDraft(null);
    if (trimmed !== family) store(`${CUSTOM_FONT_PREFIX}${trimmed}`);
  };
  return (
    <div className="font-field" data-testid={testId}>
      <label htmlFor={id}>{label}</label>
      <Select
        id={id}
        value={custom ? CUSTOM : stored}
        style={{ fontFamily: shown }}
        onChange={(event) => {
          const value = event.target.value;
          setProblem(null);
          setDraft(null);
          if (value === CUSTOM) {
            setCustomOpen(true);
            return;
          }
          setCustomOpen(false);
          store(value as FontPreset);
        }}
      >
        {FONT_PRESETS.map((preset) => (
          <option key={preset} value={preset} style={{ fontFamily: stackOf(preset) }}>
            {FONT_PRESET_LABELS[preset]}
          </option>
        ))}
        <option value={CUSTOM}>Custom…</option>
      </Select>
      {custom ? (
        <span className="font-custom">
          <input
            className="input"
            aria-label={`${label} Name`}
            placeholder="A font installed on this device, e.g. Avenir Next"
            value={draft ?? family ?? ''}
            maxLength={MAX_FONT_FAMILY_CHARS}
            spellCheck={false}
            autoComplete="off"
            aria-invalid={problem ? true : undefined}
            aria-describedby={problem ? `${id}-problem` : undefined}
            data-testid={`${testId}-custom`}
            onChange={(event) => {
              setDraft(event.target.value);
              setProblem(null);
            }}
            onBlur={commit}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                commit();
              } else if (event.key === 'Escape') {
                setDraft(null);
                setProblem(null);
              }
            }}
          />
          {problem ? (
            <span id={`${id}-problem`} className="font-problem" role="alert">
              {problem}
            </span>
          ) : null}
        </span>
      ) : null}
      <p className="font-sample" style={{ fontFamily: shown }} aria-hidden="true">
        {SAMPLE}
      </p>
    </div>
  );
}

function NoteSizeField() {
  const workspace = useWorkspace();
  const id = useId();
  const stored = noteFontSizeOf(workspace.settings());
  // A drag shows as it goes and is stored once, when it ends.
  const [draft, setDraft] = useState<number | null>(null);
  const size = draft ?? stored;
  const store = (value: number | null) => {
    setDraft(null);
    if (value === null) workspace.setSetting(NOTE_FONT_SIZE_SETTING, undefined);
    else if (value !== stored)
      workspace.setSetting(
        NOTE_FONT_SIZE_SETTING,
        value === NOTE_FONT_SIZE.default ? undefined : value,
      );
  };
  const clamp = (value: number) =>
    Math.min(NOTE_FONT_SIZE.max, Math.max(NOTE_FONT_SIZE.min, Math.round(value)));
  return (
    <div className="font-field" data-testid="note-size-setting">
      <label htmlFor={id}>Note Font Size</label>
      <span className="font-size-row">
        <button
          type="button"
          className="btn quiet"
          data-ui="item"
          aria-label="Smaller"
          data-tip="Smaller"
          disabled={size <= NOTE_FONT_SIZE.min}
          onClick={() => store(clamp(size - 1))}
        >
          <Icon name="minus" />
        </button>
        <input
          id={id}
          type="range"
          className="font-size-range"
          min={NOTE_FONT_SIZE.min}
          max={NOTE_FONT_SIZE.max}
          step={1}
          value={size}
          aria-valuetext={`${size} pixels`}
          data-testid="note-size"
          onChange={(event) => setDraft(Number(event.target.value))}
          onPointerUp={() => draft !== null && store(draft)}
          onKeyUp={() => draft !== null && store(draft)}
          onBlur={() => draft !== null && store(draft)}
        />
        <button
          type="button"
          className="btn quiet"
          data-ui="item"
          aria-label="Larger"
          data-tip="Larger"
          disabled={size >= NOTE_FONT_SIZE.max}
          onClick={() => store(clamp(size + 1))}
        >
          <Icon name="plus" />
        </button>
        <output htmlFor={id} className="font-size-value" data-testid="note-size-value">
          {size} px
        </output>
        <button
          type="button"
          className="btn quiet"
          data-ui="item"
          onClick={() => {
            // Already the default: nothing to store.
            if (draft !== null || workspace.settings()[NOTE_FONT_SIZE_SETTING] !== undefined)
              store(null);
          }}
        >
          Reset
        </button>
      </span>
      <p
        className="font-sample"
        style={{ fontFamily: 'var(--pm-font-body, var(--pm-font))', fontSize: `${size}px` }}
        aria-hidden="true"
      >
        {SAMPLE}
      </p>
    </div>
  );
}

export function FontSettings() {
  const { theme } = useThemeState();
  return (
    <fieldset className="appearance-group" data-testid="font-settings">
      <legend>Fonts</legend>
      <div className="font-fields">
        <FontField
          settingKey={INTERFACE_FONT_SETTING}
          label="Interface Font"
          themeStack={theme.fonts.ui}
          testId="interface-font"
        />
        <FontField
          settingKey={NOTE_FONT_SETTING}
          label="Note Font"
          themeStack={theme.fonts.body}
          testId="note-font"
        />
        <NoteSizeField />
      </div>
      <p className="muted appearance-note">
        Over the theme’s own fonts, on every device. Code keeps the theme’s monospace font. A custom
        font shows where it is installed, else the system’s.
      </p>
    </fieldset>
  );
}
