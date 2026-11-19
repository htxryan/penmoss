/**
 * Search Settings (PEN-146): a field over the nav, and while it has a query, the settings it
 * finds in place of the page, each with its label (the match marked) and the page › group it is
 * on. Enter opens the first; Escape clears; ↓ moves into the results and ↑ back. Opening one goes
 * to its page, which scrolls to it and marks it (SettingsPage's `revealSetting`).
 */
import { Icon } from '@penmoss/ui/icons';
import { useId, type KeyboardEvent, type ReactNode } from 'react';
import { isPlainLeftClick, settingsPath } from '../router';
import type { SettingEntry, SettingMatch } from './settings-index';
import type { SettingsSearchState } from './settings-search';
import { SettingsHeader } from './SettingsHeader';

export function SettingsSearch({
  search,
  onOpen,
}: {
  search: SettingsSearchState;
  onOpen: (entry: SettingEntry) => void;
}) {
  const { query, setQuery, results, input, listId } = search;
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      const first = results[0];
      if (!first) return;
      event.preventDefault();
      onOpen(first.entry);
    } else if (event.key === 'Escape') {
      if (!query) return;
      // Clears the field only: Escape does nothing else here while it has a query.
      event.preventDefault();
      event.stopPropagation();
      setQuery('');
    } else if (event.key === 'ArrowDown' && results.length > 0) {
      event.preventDefault();
      document.getElementById(listId)?.querySelector<HTMLElement>('a')?.focus();
    }
  };
  return (
    <div className="settings-search" role="search">
      <Icon name="search" size={14} />
      <input
        ref={input}
        type="search"
        className="input"
        placeholder="Search Settings"
        aria-label="Search Settings"
        aria-controls={query ? listId : undefined}
        autoComplete="off"
        spellCheck={false}
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={onKeyDown}
        data-testid="settings-search"
      />
    </div>
  );
}

/** The results, in place of the page while there is a query. */
export function SettingsSearchResults({
  search,
  onOpen,
}: {
  search: SettingsSearchState;
  onOpen: (entry: SettingEntry) => void;
}) {
  const id = useId();
  const { query, results, input, listId } = search;
  const shownQuery = query.trim();
  const count =
    results.length === 0
      ? `No settings match “${shownQuery}”.`
      : `${results.length} ${results.length === 1 ? 'setting matches' : 'settings match'} “${shownQuery}”.`;
  const onKeyDown = (event: KeyboardEvent<HTMLUListElement>) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp' && event.key !== 'Escape') return;
    const links = [...event.currentTarget.querySelectorAll<HTMLElement>('a')];
    const at = links.indexOf(document.activeElement as HTMLElement);
    event.preventDefault();
    if (event.key === 'Escape') {
      event.stopPropagation();
      search.clear();
      input.current?.focus();
    } else if (event.key === 'ArrowDown') {
      links[Math.min(at + 1, links.length - 1)]?.focus();
    } else if (at <= 0) {
      input.current?.focus();
    } else {
      links[at - 1]?.focus();
    }
  };
  return (
    <section
      className="settings-section settings-results"
      aria-labelledby={`${id}-h`}
      data-testid="settings-search-results"
    >
      <SettingsHeader id={`${id}-h`} title="Search Results" intro={count} live />
      {results.length > 0 ? (
        <ul id={listId} className="setting-results" onKeyDown={onKeyDown}>
          {results.map(({ entry, marks, place }) => (
            <li key={`${entry.section}/${entry.group ?? ''}/${entry.id}`}>
              <a
                href={settingsPath(entry.section)}
                data-ui="item"
                data-testid="settings-search-result"
                data-setting-result={entry.id}
                data-event="settings.search.result"
                onClick={(event) => {
                  if (!isPlainLeftClick(event)) return;
                  event.preventDefault();
                  onOpen(entry);
                }}
              >
                <span className="setting-result-label">{marked(entry.label, marks)}</span>
                <span className="setting-result-place muted">{place}</span>
              </a>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">Try another word, such as “font”, “sync” or “shortcut”.</p>
      )}
      <p className="muted settings-help">
        Search reads each setting’s name, help and other names. Enter opens the first match on its
        page; Esc clears.
      </p>
    </section>
  );
}

/** The label with each matched range in a `<mark>`. */
function marked(label: string, marks: SettingMatch['marks']) {
  const parts: ReactNode[] = [];
  let from = 0;
  for (const [start, end] of marks) {
    if (start > from) parts.push(label.slice(from, start));
    parts.push(<mark key={start}>{label.slice(start, end)}</mark>);
    from = end;
  }
  if (from < label.length) parts.push(label.slice(from));
  return parts;
}
