import { Icon } from '@penmoss/ui/icons';
import { DialogClose } from '../shell/DialogClose';
import { PickerField, PickerListbox, PickerOverlay } from '../shell/picker';
import { usePickerList } from '../shell/picker-list';
import type { Theme } from '@penmoss/ui/theme';
import { useEffect, useMemo, useState } from 'react';
import { fuzzyMatch, highlightRuns } from '@penmoss/core/fuzzy';
import { useThemeController } from './hooks';
import { useTrackedDialog } from '../analytics/dialog';

export interface ThemePickerProps {
  readonly themes: readonly Theme[];
  readonly currentId: string;
  readonly onChoose: (id: string) => void;
  readonly onClose: () => void;
}

/**
 * "Switch theme…" (T28): the palette's combobox over the themes. Moving
 * through the list previews each theme on the whole app; Enter or a click
 * chooses it (synced), Esc goes back to the theme you had.
 */
export function ThemePicker({ themes, currentId, onChoose, onClose }: ThemePickerProps) {
  const controller = useThemeController();
  const tracked = useTrackedDialog('themePicker');
  const [query, setQuery] = useState('');
  const start = Math.max(
    0,
    themes.findIndex((theme) => theme.id === currentId),
  );
  const [active, setActive] = useState(start);

  const items = useMemo(() => {
    const q = query.trim();
    return themes.flatMap((theme) => {
      if (!q) return [{ theme, indices: [] as readonly number[] }];
      const match = fuzzyMatch(q, theme.name, { scattered: false });
      return match ? [{ theme, indices: match.indices }] : [];
    });
  }, [themes, query]);

  const choose = (theme: Theme | null | undefined) => {
    if (!theme) return;
    tracked.done();
    onChoose(theme.id);
  };
  const picker = usePickerList({
    items,
    active,
    setActive,
    onChoose: (index) => choose(items[index]?.theme),
    onClose,
  });
  const activeTheme = items[picker.current]?.theme ?? null;

  // Preview the highlighted theme; closing ends the preview.
  // The picker's own preview: closing it goes back to whatever was shown before (A254).
  const [owner] = useState(() => ({}));
  useEffect(() => controller.preview(activeTheme, owner), [controller, activeTheme, owner]);
  useEffect(() => () => controller.preview(null, owner), [controller, owner]);

  return (
    <PickerOverlay testId="theme-picker" className="palette" label="Switch Theme" onClose={onClose}>
      <div className="dlg-search">
        <PickerField
          picker={picker}
          aria-label="Switch Theme"
          placeholder="Choose a theme…"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
          }}
        />
        <DialogClose label="Close the Theme List" onClose={onClose} />
      </div>
      <PickerListbox picker={picker} label="Themes">
        {items.length === 0 ? (
          <p className="dlg-empty" role="status">
            No theme matches “{query}”
          </p>
        ) : (
          items.map((item, index) => (
            <div
              key={item.theme.id}
              {...picker.optionProps(index)}
              className="opt"
              data-theme-id={item.theme.id}
              onClick={() => choose(item.theme)}
            >
              <span className="oic" aria-hidden="true">
                <Icon name="palette" size={14} />
              </span>
              <span className="ot">
                {highlightRuns(item.theme.name, item.indices).map((run, i) =>
                  run.match ? <b key={i}>{run.text}</b> : <span key={i}>{run.text}</span>,
                )}
                <span className="p">{item.theme.description}</span>
              </span>
              <span className="os">
                {item.theme.id === currentId ? <Icon name="check" size={14} /> : null}
              </span>
            </div>
          ))
        )}
      </PickerListbox>
      <div className="dlg-foot" aria-hidden="true">
        <span className="keys">
          <kbd>↑</kbd>
          <kbd>↓</kbd>
        </span>
        Preview
        <span className="keys">
          <kbd>↵</kbd>
        </span>
        Choose
        <span className="grow" />
        <span className="keys">
          <kbd>Esc</kbd>
        </span>
        Keep the current theme
      </div>
    </PickerOverlay>
  );
}
