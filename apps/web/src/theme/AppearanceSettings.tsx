import { Icon, type IconName } from '@penmoss/ui/icons';
import {
  builtInTheme,
  chooseTheme,
  duplicateAndChoose,
  resolveThemeSettings,
  setThemeMode,
  type Theme,
  type ThemeMode,
} from '@penmoss/ui/theme';
import { useId, useState, type CSSProperties } from 'react';
import { CompactTitleBarSetting } from '../desktop/CompactTitleBarSetting';
import { desktop } from '../desktop/bridge';
import { TooltipDelaySetting } from '../shell/TooltipDelaySetting';
import { useWorkspace, useWorkspaceState } from '../workspace/hooks';
import { AppPreview } from './AppPreview';
import { useThemeState } from './hooks';
import { FontSettings } from './FontSettings';
import { GroupHead, SettingRow } from './look-rows';
import { ThemeEditor } from './ThemeEditor';

const MODES: ReadonlyArray<{ mode: ThemeMode; label: string; icon: IconName }> = [
  { mode: 'light', label: 'Light', icon: 'sun' },
  { mode: 'dark', label: 'Dark', icon: 'moon' },
  { mode: 'system', label: 'System', icon: 'monitor' },
];

/**
 * Settings → Appearance (T28; PEN-146's Live Preview Studio): how Penmoss looks, in three groups
 * beside a live miniature of the app (`AppPreview`) that redraws as they change. Theme: the mode
 * (Light, Dark, System), the theme (eight built-ins and the user's own) and Customize…, which
 * opens the theme editor on a copy of a built-in. Text: the fonts (T51 item 16, A944) and Show
 * Tooltips After (A1247, from Display). Window, the Mac app's only and this Mac's own: the
 * compact title bar (T47, A724). The rest is the Primary Notebook's settings (A827), so it
 * follows Ryan to every device. Note Width and Note Panel are on the Note page now. On a narrow
 * window the preview goes under the controls.
 */
export function AppearanceSettings() {
  const workspace = useWorkspace();
  useWorkspaceState(); // re-render when settings change (here or by sync)
  const state = useThemeState();
  const id = useId();
  const themes = resolveThemeSettings(workspace.settings()).all;
  /** The custom theme the editor is open on; the editor shows while it is the chosen one. */
  const [editing, setEditing] = useState<string | null>(null);
  /** The note size while its slider is dragged, for the preview. */
  const [sizeDraft, setSizeDraft] = useState<number | null>(null);
  const builtIn = Boolean(builtInTheme(state.theme.id));
  const mac = Boolean(desktop()?.macWindow);
  const device = desktop() ? 'this Mac' : 'this device';

  if (editing !== null && editing === state.theme.id && !builtIn) {
    return (
      <section
        className="settings-section appearance lf-page"
        aria-labelledby={`${id}-h`}
        data-testid="appearance-settings"
      >
        <h2 id={`${id}-h`}>Appearance</h2>
        <ThemeEditor theme={state.theme} themes={themes} onDone={() => setEditing(null)} />
      </section>
    );
  }

  const customize = () => {
    if (!builtIn) {
      setEditing(state.theme.id);
      return;
    }
    const copy = duplicateAndChoose(
      workspace,
      state.theme,
      themes.map((each) => each.name),
    );
    setEditing(copy.id);
  };

  const previewStyle =
    sizeDraft === null ? undefined : ({ '--pm-note-size': `${sizeDraft}px` } as CSSProperties);

  return (
    <section
      className="settings-section appearance lf-page"
      aria-labelledby={`${id}-h`}
      data-testid="appearance-settings"
    >
      <h2 id={`${id}-h`}>Appearance</h2>
      <p>
        Kept in your Primary Notebook, so it syncs to your other devices
        {mac ? ', except what says This Mac' : ''}. Every theme has a light and a dark variant.
      </p>

      <div className="lf-split">
        <div className="lf-controls">
          <GroupHead id={`${id}-theme`}>Theme</GroupHead>
          <div className="lf-group" role="group" aria-labelledby={`${id}-theme`}>
            <SettingRow
              setting="mode"
              label="Mode"
              labelId={`${id}-mode`}
              help={
                state.mode === 'system'
                  ? `System follows ${device}: ${state.variant} right now.`
                  : `Always ${state.mode}, whatever ${device} is set to.`
              }
            >
              <div
                className="seg"
                role="radiogroup"
                aria-labelledby={`${id}-mode`}
                data-testid="theme-mode"
              >
                {MODES.map((item) => (
                  <label key={item.mode} className="seg-option">
                    <input
                      type="radio"
                      name={`${id}-mode`}
                      value={item.mode}
                      checked={state.mode === item.mode}
                      onChange={() => setThemeMode(workspace, item.mode)}
                    />
                    <Icon name={item.icon} size={14} />
                    <span className="bold-steady" data-label={item.label}>
                      {item.label}
                    </span>
                  </label>
                ))}
              </div>
            </SettingRow>
          </div>
          <div
            className="theme-grid"
            role="radiogroup"
            aria-label="Theme"
            data-setting="theme"
            data-testid="theme-grid"
          >
            {themes.map((theme) => (
              <ThemeCard
                key={theme.id}
                theme={theme}
                name={`${id}-theme`}
                checked={theme.id === state.theme.id}
                onChoose={() => chooseTheme(workspace, theme.id)}
              />
            ))}
          </div>
          <div className="lf-actions" data-setting="customize-theme">
            <button
              type="button"
              className="btn"
              data-ui="item"
              data-testid="theme-customize"
              onClick={customize}
            >
              <Icon name="brush" size={14} />
              {`Customize ${state.theme.name}…`}
            </button>
            <span className="lf-help">
              {builtIn
                ? 'Edits a copy, which syncs to your other devices.'
                : 'Its colours, fonts and note width.'}
            </span>
          </div>

          <GroupHead id={`${id}-text`}>Text</GroupHead>
          <div
            className="lf-group"
            role="group"
            aria-labelledby={`${id}-text`}
            data-testid="font-settings"
          >
            <FontSettings onSizeDraft={setSizeDraft} />
            <TooltipDelaySetting />
          </div>
          <p className="lf-help">
            Fonts lie over the theme’s own on every device. Code keeps the theme’s monospace font. A
            custom font shows where it is installed, else the system’s.
          </p>

          {mac ? (
            <>
              <GroupHead id={`${id}-window`} scope>
                Window
              </GroupHead>
              <div className="lf-group" role="group" aria-labelledby={`${id}-window`}>
                <CompactTitleBarSetting />
              </div>
            </>
          ) : null}
        </div>

        <aside className="lf-preview-col" aria-label="Preview">
          <p className="lf-label">Preview</p>
          <AppPreview style={previewStyle} />
          <p className="lf-help">Redraws as you change the mode, theme, fonts or size.</p>
        </aside>
      </div>
    </section>
  );
}

/** A miniature of the theme's light and dark variants: sidebar, text, accent and code. */
export function ThemeSwatch({ theme }: { theme: Theme }) {
  return (
    <span className="theme-swatch" aria-hidden="true">
      {(['light', 'dark'] as const).map((variant) => {
        const c = theme[variant];
        const vars = {
          '--sw-bg': c.bg,
          '--sw-sidebar': c.sidebar,
          '--sw-fg': c.fg,
          '--sw-muted': c.muted,
          '--sw-border': c.border,
          '--sw-accent': c.accent,
          '--sw-k': c.codeKeyword,
          '--sw-s': c.codeString,
          '--sw-f': c.codeFunction,
        } as CSSProperties;
        return (
          <span key={variant} className="sw-half" style={vars}>
            <span className="sw-side" />
            <span className="sw-main">
              <span className="sw-line sw-title" />
              <span className="sw-line sw-text" />
              <span className="sw-line sw-text short" />
              <span className="sw-code">
                <span className="sw-k" />
                <span className="sw-s" />
                <span className="sw-f" />
              </span>
              <span className="sw-button" />
            </span>
          </span>
        );
      })}
    </span>
  );
}

function ThemeCard({
  theme,
  name,
  checked,
  onChoose,
}: {
  theme: Theme;
  name: string;
  checked: boolean;
  onChoose: () => void;
}) {
  return (
    <label className="theme-card" data-theme-id={theme.id}>
      <input type="radio" name={name} value={theme.id} checked={checked} onChange={onChoose} />
      <ThemeSwatch theme={theme} />
      <span className="theme-card-foot">
        <span className="theme-card-name">
          {theme.name}
          <span className="theme-card-note">{theme.description}</span>
        </span>
        {checked ? <Icon name="check" size={16} /> : null}
      </span>
    </label>
  );
}
