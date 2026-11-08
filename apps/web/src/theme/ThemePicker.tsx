import { Icon } from '@penmoss/ui/icons';
import { DialogClose } from '../shell/DialogClose';
import type { Theme } from '@penmoss/ui/theme';
import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import { fuzzy, highlightRuns } from '../commands/fuzzy';
import { useThemeController } from './hooks';

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
  const [query, setQuery] = useState('');
  const start = Math.max(
    0,
    themes.findIndex((theme) => theme.id === currentId),
  );
  const [active, setActive] = useState(start);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const id = useId();

  const items = useMemo(() => {
    const q = query.trim();
    return themes.flatMap((theme) => {
      if (!q) return [{ theme, indices: [] as readonly number[] }];
      const match = fuzzy(q, theme.name);
      return match ? [{ theme, indices: match.indices }] : [];
    });
  }, [themes, query]);
  const current = Math.min(active, Math.max(0, items.length - 1));
  const activeTheme = items[current]?.theme ?? null;

  useLayoutEffect(() => input.current?.focus(), []);
  useLayoutEffect(() => {
    list.current
      ?.querySelector<HTMLElement>(`[data-index="${current}"]`)
      ?.scrollIntoView?.({ block: 'nearest' });
  }, [current, items]);
  // Preview the highlighted theme; closing ends the preview.
  // The picker's own preview: closing it goes back to whatever was shown before (A254).
  const [owner] = useState(() => ({}));
  useEffect(() => controller.preview(activeTheme, owner), [controller, activeTheme, owner]);
  useEffect(() => () => controller.preview(null, owner), [controller, owner]);

  const choose = (theme: Theme | null) => {
    if (!theme) return;
    onChoose(theme.id);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing) return;
    const count = Math.max(1, items.length);
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        setActive((current + 1) % count);
        break;
      case 'ArrowUp':
        event.preventDefault();
        setActive((current - 1 + count) % count);
        break;
      case 'Enter':
        event.preventDefault();
        choose(activeTheme);
        break;
      case 'Escape':
        event.preventDefault();
        event.stopPropagation();
        onClose();
        break;
    }
  };

  const option = (index: number) => `${id}-option-${index}`;
  return (
    <div
      className="overlay"
      data-testid="theme-picker"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="dialog palette" role="dialog" aria-modal="true" aria-label="Switch Theme">
        <div className="dlg-search">
          <input
            ref={input}
            type="text"
            role="combobox"
            aria-expanded="true"
            aria-controls={`${id}-list`}
            aria-autocomplete="list"
            aria-activedescendant={items.length > 0 ? option(current) : undefined}
            aria-label="Switch Theme"
            placeholder="Choose a theme…"
            autoComplete="off"
            spellCheck={false}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActive(0);
            }}
            onKeyDown={onKeyDown}
          />
          <DialogClose label="Close the Theme List" onClose={onClose} />
        </div>
        <div ref={list} className="dlg-list" id={`${id}-list`} role="listbox" aria-label="Themes">
          {items.length === 0 ? (
            <p className="dlg-empty" role="status">
              No theme matches “{query}”
            </p>
          ) : (
            items.map((item, index) => (
              <div
                key={item.theme.id}
                id={option(index)}
                role="option"
                className="opt"
                aria-selected={index === current}
                data-index={index}
                data-theme-id={item.theme.id}
                onMouseMove={() => {
                  if (index !== current) setActive(index);
                }}
                onMouseDown={(event) => event.preventDefault()}
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
        </div>
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
      </div>
    </div>
  );
}
