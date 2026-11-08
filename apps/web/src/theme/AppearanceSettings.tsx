import { Icon, type IconName } from '@penmoss/ui/icons';
import {
  chooseTheme,
  resolveThemeSettings,
  setThemeMode,
  type Theme,
  type ThemeMode,
} from '@penmoss/ui/theme';
import { useId, type CSSProperties } from 'react';
import { useKeys } from '../commands/hooks';
import { CompactTitleBarSetting } from '../desktop/CompactTitleBarSetting';
import { Kbd } from '../commands/Kbd';
import { useFullWidth } from '../notes/width';
import { NOTE_PANEL_MODES, useDefaultPanelMode } from '../notes/panel-mode';
import { useWorkspace, useWorkspaceState } from '../workspace/hooks';
import { useThemeState } from './hooks';
import { FontSettings } from './FontSettings';
import { ThemeEditor } from './ThemeEditor';

const MODES: ReadonlyArray<{ mode: ThemeMode; label: string; icon: IconName }> = [
  { mode: 'light', label: 'Light', icon: 'sun' },
  { mode: 'dark', label: 'Dark', icon: 'moon' },
  { mode: 'system', label: 'System', icon: 'monitor' },
];

/**
 * Settings → Appearance (T28): the mode (Light, Dark, System), the theme
 * (eight built-ins and the user's own), the fonts (T51 item 16, A944), and
 * the theme editor. All of it is the Journal notebook's settings (A827), so it follows Ryan to
 * every device. In the Mac app, the compact title bar (T47, A724) is this Mac's own.
 */
export function AppearanceSettings() {
  const workspace = useWorkspace();
  useWorkspaceState(); // re-render when settings change (here or by sync)
  const state = useThemeState();
  const id = useId();
  const themes = resolveThemeSettings(workspace.settings()).all;
  return (
    <section
      className="settings-section appearance"
      aria-labelledby={`${id}-h`}
      data-testid="appearance-settings"
    >
      <h2 id={`${id}-h`}>Appearance</h2>
      <p>
        Your theme and mode are kept in your Primary Notebook, so they sync to your other devices.
        Every theme has a light and a dark variant.
      </p>

      <fieldset className="appearance-group">
        <legend>Mode</legend>
        <div className="seg" data-testid="theme-mode">
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
        <p className="muted appearance-note">
          {state.mode === 'system'
            ? `System follows this device's setting: ${state.variant} right now.`
            : `Always ${state.mode}, whatever the device's setting.`}
        </p>
      </fieldset>

      <fieldset className="appearance-group">
        <legend>Theme</legend>
        <div className="theme-grid" data-testid="theme-grid">
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
      </fieldset>

      <NoteWidthSetting editorWidth={state.theme.editorWidth} name={`${id}-width`} />

      <NotePanelSetting name={`${id}-panel`} />

      <FontSettings />

      <CompactTitleBarSetting />

      <ThemeEditor theme={state.theme} themes={themes} />
    </section>
  );
}

/**
 * Note width (T41, A501): the theme's width, or the whole window. The note's
 * Full width button, its command and its shortcut change the same setting.
 */
function NoteWidthSetting({ editorWidth, name }: { editorWidth: number; name: string }) {
  const [full, setFull] = useFullWidth();
  const keys = useKeys('note.fullWidth');
  return (
    <fieldset className="appearance-group" data-testid="note-width-setting">
      <legend>Note width</legend>
      <div className="seg">
        <label className="seg-option">
          <input type="radio" name={name} checked={!full} onChange={() => setFull(false)} />
          <span className="bold-steady" data-label={`The Theme’s (${editorWidth} rem)`}>
            The Theme’s ({editorWidth} rem)
          </span>
        </label>
        <label className="seg-option">
          <input type="radio" name={name} checked={full} onChange={() => setFull(true)} />
          <Icon name="widthFull" size={14} />
          <span className="bold-steady" data-label="Full Window Width">
            Full Window Width
          </span>
        </label>
      </div>
      <p className="muted appearance-note">
        Also the Full Width button above a note
        {keys[0] ? (
          <>
            {' '}
            and <Kbd combo={keys[0]} />
          </>
        ) : null}
        . Synced to your other devices.
      </p>
    </fieldset>
  );
}

/**
 * Note Panel (T52 item 6; T53 item 9, A985): whether a note's panel starts open or closed until
 * the note's own tab icons open or close it, which each note then remembers. This device's own,
 * like the compact title bar, so it works signed out too.
 */
function NotePanelSetting({ name }: { name: string }) {
  const [mode, setMode] = useDefaultPanelMode();
  return (
    <fieldset className="appearance-group" data-testid="note-panel-setting">
      <legend>Note Panel</legend>
      <div className="seg">
        {NOTE_PANEL_MODES.map((item) => (
          <label key={item.mode} className="seg-option">
            <input
              type="radio"
              name={name}
              value={item.mode}
              checked={mode === item.mode}
              onChange={() => setMode(item.mode)}
            />
            <span className="bold-steady" data-label={item.label}>
              {item.label}
            </span>
          </label>
        ))}
      </div>
      <p className="muted appearance-note">
        How a note’s panel starts. The icons at a note’s right edge open its tabs beside the note
        (over its text where there is no room for both) and close them again; each note remembers
        its own. This device only.
      </p>
    </fieldset>
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
