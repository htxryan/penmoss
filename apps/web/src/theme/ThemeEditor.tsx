import { Icon } from '@penmoss/ui/icons';
import {
  builtInTheme,
  COLOUR_GROUPS,
  COLOUR_TOKENS,
  contrastProblems,
  deleteCustomTheme,
  duplicateAndChoose,
  EDITOR_WIDTH,
  FONT_CHOICES,
  isHexColour,
  saveCustomTheme,
  themeVariables,
  type ColourToken,
  type Theme,
  type ThemeFonts,
  type ThemeVariant,
} from '@penmoss/ui/theme';
import { Select } from '@penmoss/ui/controls/Select';
import { useEffect, useId, useRef, useState, type CSSProperties } from 'react';
import { useWorkspace } from '../workspace/hooks';
import { useThemeController, useThemeState } from './hooks';

/** Edits are saved (and synced) once they pause this long; the page shows them at once. */
const SAVE_DELAY_MS = 400;

const FONT_FIELDS: ReadonlyArray<{ key: keyof ThemeFonts; label: string }> = [
  { key: 'ui', label: 'Interface font' },
  { key: 'body', label: 'Note font' },
  { key: 'mono', label: 'Code font' },
];

/**
 * The theme editor (T28, D14): built-in themes are read-only, so editing
 * starts by duplicating one. A custom theme's colours (light and dark), fonts
 * and editor width are edited with colour pickers and lists; the whole app
 * and the preview here change as you edit, and the theme is saved to the
 * synced settings once edits pause. There is no custom CSS.
 */
export function ThemeEditor({ theme, themes }: { theme: Theme; themes: readonly Theme[] }) {
  const workspace = useWorkspace();
  const id = useId();
  const builtIn = Boolean(builtInTheme(theme.id));
  return (
    <section className="theme-editor" aria-labelledby={`${id}-h`} data-testid="theme-editor">
      <h3 id={`${id}-h`}>Theme editor</h3>
      {builtIn ? (
        <div className="theme-editor-empty">
          <p>
            Built-in themes can’t be changed. Duplicate {theme.name} to edit its colours, fonts and
            note width; your copy syncs to your other devices.
          </p>
          <button
            type="button"
            className="btn primary"
            data-ui="item"
            onClick={() =>
              duplicateAndChoose(
                workspace,
                theme,
                themes.map((each) => each.name),
              )
            }
          >
            <Icon name="copy" size={14} />
            {`Duplicate ${theme.name}`}
          </button>
        </div>
      ) : (
        <CustomThemeEditor key={theme.id} theme={theme} themes={themes} />
      )}
    </section>
  );
}

function CustomThemeEditor({ theme, themes }: { theme: Theme; themes: readonly Theme[] }) {
  const workspace = useWorkspace();
  const controller = useThemeController();
  const shownVariant = useThemeState().variant;
  const id = useId();
  const [variant, setVariant] = useState<ThemeVariant>(shownVariant);
  /** Edits on screen; null when the editor shows the saved theme. */
  const [draft, setDraft] = useState<Theme | null>(null);
  /** Edits not yet saved: a newer saved theme (from sync) must not replace them. */
  const [dirty, setDirty] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  /**
   * The pending save: the edited theme, and `start`, the saved theme the edits
   * began from. Saving writes only what changed since `start` onto what is
   * stored by then (A250), so another device's edits meanwhile are kept, and a
   * theme deleted meanwhile stays deleted.
   */
  const save = useRef<{
    timer: ReturnType<typeof setTimeout> | null;
    theme: Theme | null;
    start: Theme | null;
  }>({ timer: null, theme: null, start: null });
  const current = draft ?? theme;

  // A new saved version (this device's save, or another device's edit) replaces a saved draft.
  const themeKey = JSON.stringify(theme);
  const [seenKey, setSeenKey] = useState(themeKey);
  if (seenKey !== themeKey) {
    setSeenKey(themeKey);
    if (!dirty) setDraft(null);
  }

  // The whole app shows the draft while there is one.
  useEffect(() => {
    controller.preview(draft, save.current);
  }, [draft, controller]);

  // Leaving the editor saves what was typed and ends the preview.
  useEffect(
    () => () => {
      const pending = save.current;
      if (pending.timer !== null && pending.theme) {
        clearTimeout(pending.timer);
        saveCustomTheme(workspace, pending.theme, pending.start ?? undefined);
      }
      pending.timer = null;
      pending.start = null;
      controller.preview(null, pending);
    },
    [workspace, controller],
  );

  const edit = (next: Theme) => {
    setDraft(next);
    setDirty(true);
    const pending = save.current;
    if (pending.timer !== null) clearTimeout(pending.timer);
    pending.start ??= theme;
    pending.theme = next;
    pending.timer = setTimeout(() => {
      pending.timer = null;
      const saved = saveCustomTheme(workspace, next, pending.start ?? undefined);
      // The next edit begins from what was saved (others' edits merged in).
      pending.start = saved;
      setDirty(false);
    }, SAVE_DELAY_MS);
  };

  const setColour = (key: ColourToken, value: string) => {
    if (!isHexColour(value)) return;
    edit({ ...current, [variant]: { ...current[variant], [key]: value.toLowerCase() } });
  };

  const problems = contrastProblems(current[variant]);
  const previewVars = themeVariables(current, variant) as CSSProperties;
  const otherNames = themes.filter((each) => each.id !== theme.id).map((each) => each.name);

  return (
    <div className="custom-theme" data-testid="custom-theme-editor">
      <fieldset className="theme-editor-head">
        <legend className="sr-only">Name and variant</legend>
        <label className="settings-field theme-name">
          <span>Name</span>
          <input
            className="input"
            value={current.name}
            maxLength={60}
            onChange={(event) => edit({ ...current, name: event.target.value })}
            onBlur={() => {
              if (!current.name.trim()) edit({ ...current, name: 'Untitled theme' });
            }}
            aria-invalid={otherNames.includes(current.name.trim()) || undefined}
          />
        </label>
        <div className="seg" role="radiogroup" aria-label="Variant to edit">
          {(['light', 'dark'] as const).map((each) => (
            <label key={each} className="seg-option">
              <input
                type="radio"
                name={`${id}-variant`}
                value={each}
                checked={variant === each}
                onChange={() => setVariant(each)}
              />
              <Icon name={each === 'light' ? 'sun' : 'moon'} size={14} />
              <span className="bold-steady" data-label={each === 'light' ? 'Light' : 'Dark'}>
                {each === 'light' ? 'Light' : 'Dark'}
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      {variant !== shownVariant ? (
        <p className="muted appearance-note">
          The app is showing the {shownVariant} variant; the preview below shows the {variant} one.
        </p>
      ) : null}

      <div
        className="theme-preview"
        style={previewVars}
        data-testid="theme-preview"
        aria-hidden="true"
      >
        <div className="tp-side">
          <span className="tp-item tp-current">Today</span>
          <span className="tp-item">Projects</span>
          <span className="tp-item tp-muted">Inbox · 3</span>
        </div>
        <div className="tp-main">
          <p className="tp-title">Garden plan</p>
          <p className="tp-text">
            Raised beds by the <span className="tp-link">fence</span>, with <mark>tomatoes</mark>{' '}
            and <code>basil</code>.
          </p>
          <p className="tp-muted">Edited 2 minutes ago</p>
          <div className="tp-callout">
            <b>Tip</b> Water in the morning.
          </div>
          <pre className="tp-code">
            <span className="tp-k">const</span> <span className="tp-f">beds</span> ={' '}
            <span className="tp-n">4</span>; <span className="tp-c">{'// by the fence'}</span>
            {'\n'}
            <span className="tp-k">plant</span>(<span className="tp-s">{"'tomato'"}</span>);
          </pre>
          <span className="tp-actions">
            <span className="tp-button">Save</span>
            <span className="tp-danger">Delete</span>
          </span>
        </div>
      </div>

      <p
        className={problems.length ? 'theme-contrast warn' : 'theme-contrast'}
        role="status"
        data-testid="theme-contrast"
      >
        {problems.length === 0
          ? `Every text and icon colour in the ${variant} variant passes WCAG AA.`
          : `${problems.length} colour ${problems.length === 1 ? 'pair is' : 'pairs are'} below WCAG AA in the ${variant} variant: ${problems
              .slice(0, 4)
              .map((problem) => `${problem.label} (${problem.ratio.toFixed(1)}:1)`)
              .join('; ')}${problems.length > 4 ? '; …' : '.'}`}
      </p>

      {COLOUR_GROUPS.map((group) => (
        <fieldset key={group.id} className="token-group">
          <legend>{group.label}</legend>
          {COLOUR_TOKENS.filter((token) => token.group === group.id).map((token) => (
            <ColourRow
              key={token.key}
              label={token.label}
              value={current[variant][token.key]}
              onChange={(value) => setColour(token.key, value)}
            />
          ))}
        </fieldset>
      ))}

      <fieldset className="token-group">
        <legend>Type and layout</legend>
        {FONT_FIELDS.map((field) => (
          <label key={field.key} className="token-row">
            <span>{field.label}</span>
            <Select
              value={current.fonts[field.key]}
              onChange={(event) =>
                edit({ ...current, fonts: { ...current.fonts, [field.key]: event.target.value } })
              }
            >
              {FONT_CHOICES.some((choice) => choice.stack === current.fonts[field.key]) ? null : (
                <option value={current.fonts[field.key]}>{current.fonts[field.key]}</option>
              )}
              {FONT_CHOICES.map((choice) => (
                <option key={choice.stack} value={choice.stack}>
                  {choice.label}
                </option>
              ))}
            </Select>
          </label>
        ))}
        <label className="token-row">
          <span>Note width</span>
          <input
            type="range"
            min={EDITOR_WIDTH.min}
            max={EDITOR_WIDTH.max}
            step={1}
            value={current.editorWidth}
            onChange={(event) => edit({ ...current, editorWidth: Number(event.target.value) })}
          />
          <output>{current.editorWidth} rem</output>
        </label>
      </fieldset>

      <div className="settings-actions theme-editor-actions">
        {confirmDelete ? (
          <>
            <span>Delete “{current.name}” on every device?</span>
            <button
              type="button"
              className="btn danger-fill"
              data-ui="submit"
              onClick={() => {
                if (save.current.timer !== null) clearTimeout(save.current.timer);
                save.current.timer = null;
                setDraft(null);
                deleteCustomTheme(workspace, theme);
              }}
            >
              <Icon name="trash" size={14} />
              Delete Theme
            </button>
            <button
              type="button"
              className="btn"
              data-ui="dismiss"
              onClick={() => setConfirmDelete(false)}
            >
              Keep It
            </button>
          </>
        ) : (
          <button
            type="button"
            className="btn danger"
            data-ui="item"
            onClick={() => setConfirmDelete(true)}
          >
            <Icon name="trash" size={14} />
            Delete This Theme
          </button>
        )}
      </div>
    </div>
  );
}

function ColourRow({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const [text, setText] = useState<string | null>(null);
  const id = useId();
  return (
    <div className="token-row">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        type="color"
        value={value}
        onChange={(event) => {
          setText(null);
          onChange(event.target.value);
        }}
      />
      <input
        className="input token-hex"
        aria-label={`${label}, hex`}
        value={text ?? value}
        spellCheck={false}
        maxLength={7}
        aria-invalid={text !== null && !isHexColour(text) ? true : undefined}
        onChange={(event) => {
          const next = event.target.value.trim();
          setText(next);
          if (isHexColour(next)) onChange(next);
        }}
        onBlur={() => setText(null)}
      />
    </div>
  );
}
