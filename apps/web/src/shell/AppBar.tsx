import { ariaKeyShortcuts } from '@penmoss/editor/keys';
import { BrandMark, Icon } from '@penmoss/ui/icons';
import { Fragment, useContext, type ReactNode } from 'react';
import { useCommands, useKeys } from '../commands/hooks';
import { DrawerContext, withKeys } from './drawer';

/**
 * The phone's top app bar (T36, A181), after the prototype's: the menu button
 * that opens the drawer (folders, journal, tags, Settings, Trash), the
 * screen's title, search, and the screen's own actions. Hidden on wider
 * screens, where the sidebar and the note header carry the same actions.
 *
 * On a note, `path` is shown in place of the title, which the note shows just below: where the
 * note is (its notebook and folders; a note at a notebook's top level, the notebook's name, T52),
 * cut from the start so its own folder stays,
 * as Android's note bar shows it (T40 P4, NT11; T39 pass 3, A907). The title stays the page's
 * heading, for screen readers only.
 */
export function AppBar({
  title,
  brand = false,
  path,
  notebook,
  children,
}: {
  readonly title: string;
  /** The Penmoss mark before the title (screens that are not a note). */
  readonly brand?: boolean;
  /** A note's notebook and folders, outermost first (empty: the top level). */
  readonly path?: readonly string[];
  /** The notebook a note at its top level is in, shown when `path` is empty (T52). */
  readonly notebook?: string;
  readonly children?: ReactNode;
}) {
  const drawer = useContext(DrawerContext);
  const commands = useCommands();
  const searchKeys = useKeys('app.search');
  return (
    <header className="app-bar" data-testid="app-bar">
      {drawer ? (
        <button
          type="button"
          className="icon-btn"
          data-ui="menu"
          aria-label="Open Navigation"
          data-tip="Folders, journal, tags, Settings and Trash"
          aria-expanded={drawer.open}
          aria-controls={drawer.id}
          onClick={drawer.show}
        >
          <Icon name="menu" />
        </button>
      ) : null}
      {brand ? <BrandMark size={22} /> : null}
      {path ? (
        <>
          <h1 className="sr-only">{title || 'Untitled'}</h1>
          <p className="app-bar-title app-bar-path" data-testid="app-bar-path">
            <span>
              {/* Each part isolated (T39 pass 3 review): a bidi override in one name can't reorder the rest. */}
              {path.length > 0
                ? path.map((part, index) => (
                    <Fragment key={index}>
                      {index > 0 ? ' › ' : null}
                      <bdi>{part}</bdi>
                    </Fragment>
                  ))
                : (notebook ?? 'Top level')}
            </span>
          </p>
        </>
      ) : (
        <h1 className="app-bar-title" data-untitled={title ? undefined : ''}>
          {title || 'Untitled'}
        </h1>
      )}
      <button
        type="button"
        className="icon-btn"
        data-command="app.search"
        aria-label="Search Notes"
        aria-keyshortcuts={ariaKeyShortcuts(searchKeys) || undefined}
        data-tip={withKeys('Search Notes', searchKeys)}
        onClick={() => commands.run('app.search')}
      >
        <Icon name="search" />
      </button>
      {children}
    </header>
  );
}
