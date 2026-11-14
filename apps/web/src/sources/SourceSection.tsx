import { Icon } from '@penmoss/ui/icons';
import { useId, useRef, useState, useSyncExternalStore, type MouseEvent } from 'react';
import { gitNotebookPath, linkHandler, navigate, useLocation } from '../router';
import { ContextMenu } from '../shell/ContextMenu';
import { TIME_MACHINE_PATH, timeMachinePath } from '../time-machine/path';
import { FolderTree } from '../workspace/FolderTree';
import { TreeActions } from '../workspace/TreeActions';
import type { GitSyncStatus } from './engine-host';
import type { GitSource } from './git-source';
import { NameClash } from './NameClash';
import { useNotebookRename } from './notebook-names';
import type { Source } from './registry';
import './sources.css';

/** Which sections are collapsed on this device (A862). */
export const COLLAPSED_SECTIONS_KEY = 'penmoss.sidebar.sections.collapsed';

function readCollapsed(): Set<string> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(COLLAPSED_SECTIONS_KEY) ?? '[]');
    return new Set(Array.isArray(parsed) ? parsed.filter((id) => typeof id === 'string') : []);
  } catch {
    return new Set();
  }
}

function writeCollapsed(ids: ReadonlySet<string>): void {
  try {
    localStorage.setItem(COLLAPSED_SECTIONS_KEY, JSON.stringify([...ids]));
  } catch {
    // Remembering is a convenience: the section still works.
  }
}

const LABELS: Record<GitSyncStatus['phase'], string> = {
  starting: 'Starting',
  syncing: 'Syncing',
  synced: 'Synced',
  offline: 'Offline',
  stopped: 'Sync Stopped',
};

/**
 * A git notebook's sync state on its section's header (T50; a dot since T51, A933): the words
 * and the detail are its tooltip and accessible name. It links to its page in Settings (A1098).
 */
function GitSectionStatus({ source }: { source: GitSource }) {
  const status = useSyncExternalStore(
    source.feed.subscribe,
    () => source.feed.status,
    () => source.feed.status,
  );
  const waiting = status.pending.filter((id) => id !== 'workspace').length;
  // Quitting waits for this push (#170 F8).
  const label = status.closing
    ? 'Pushing…'
    : `${LABELS[status.phase]}${waiting > 0 ? ` · ${waiting} waiting` : ''}`;
  const tip = status.detail ? `${label}. ${status.detail}` : label;
  return (
    <a
      className="sync-dot"
      data-ui="item"
      href={gitNotebookPath(source.id)}
      data-testid="section-sync"
      data-state={status.phase}
      data-pending={waiting}
      data-label={label}
      aria-label={`Sync status: ${tip}`}
      data-tip={tip}
      onClick={linkHandler(gitNotebookPath(source.id))}
    >
      <span className="dot" aria-hidden="true" />
    </a>
  );
}

/**
 * One source's part of the sidebar (T50 G3, A862; the T43 P3 section): its name, its sync
 * state (a dot, T51 A933), its folder tree and its own Trash (on its name's row, T53).
 * Collapsed or open on this device. Rendered inside
 * the source's `SourceScope`, so the tree and everything it opens are the source's own.
 */
export function SourceSection({
  source,
  activeId,
  currentFolder,
  onCurrentFolderChange,
  active,
  onActivate,
  shown,
}: {
  source: Source;
  activeId: string | null;
  currentFolder: string | null;
  onCurrentFolderChange: (folderId: string | null) => void;
  /** This section's tree answers the tree commands (the one in use). */
  active: boolean;
  /**
   * Makes this section the one in use, before a click in it lands (A862): its buttons run the
   * tree commands, which the section in use answers.
   */
  onActivate?: () => void;
  shown: boolean;
}) {
  const [collapsed, setCollapsed] = useState(() => readCollapsed().has(source.id));
  const id = useId();
  const trash = `/trash?source=${encodeURIComponent(source.id)}`;
  const location = useLocation();
  const trashOpen =
    location.pathname === '/trash' &&
    new URLSearchParams(location.search).get('source') === source.id;
  const timeMachine = timeMachinePath(source.id);
  const timeMachineOpen =
    location.pathname === TIME_MACHINE_PATH &&
    new URLSearchParams(location.search).get('source') === source.id;
  // Its row's menu (Ryan's review of PR #192): Rename Notebook, in place, and its settings.
  const head = useRef<HTMLElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [renaming, setRenaming] = useState(false);
  const { rename, clash, message, cancel } = useNotebookRename(source);
  const openMenu = (event: MouseEvent) => {
    if (renaming) return;
    event.preventDefault();
    // From the keyboard (the context-menu key, Shift+F10) there is no pointer: under the row.
    const rect = head.current?.getBoundingClientRect();
    const fromKeys = event.clientX === 0 && event.clientY === 0;
    setMenu({
      x: fromKeys && rect ? rect.left + 16 : event.clientX,
      y: fromKeys && rect ? rect.bottom : event.clientY,
    });
  };
  const closeMenu = () => {
    setMenu(null);
    toggle.current?.focus();
  };
  const finish = (name: string | null) => {
    setRenaming(false);
    if (name !== null) void rename(name);
    requestAnimationFrame(() => toggle.current?.focus());
  };
  return (
    <section
      className="sb-section sb-source"
      aria-labelledby={`${id}-name`}
      data-testid="source-section"
      data-source={source.id}
      data-kind={source.kind}
      data-collapsed={collapsed ? 'true' : undefined}
      onPointerDownCapture={onActivate}
      onFocusCapture={onActivate}
    >
      <header ref={head} className="sb-section-head" onContextMenu={openMenu}>
        {renaming ? (
          <div className="sb-section-rename">
            <Icon name={collapsed ? 'chevR' : 'chevD'} size={12} />
            <NotebookNameInput
              label={`Rename Notebook ${source.name}`}
              initial={source.name}
              onDone={finish}
            />
          </div>
        ) : (
          <button
            ref={toggle}
            type="button"
            className="sb-section-toggle sb-notebook-name"
            data-ui="item"
            aria-expanded={!collapsed}
            aria-controls={`${id}-body`}
            onClick={() => {
              const next = readCollapsed();
              if (collapsed) next.delete(source.id);
              else next.add(source.id);
              writeCollapsed(next);
              setCollapsed(!collapsed);
            }}
          >
            <Icon name={collapsed ? 'chevR' : 'chevD'} size={12} />
            <span id={`${id}-name`} className="sb-section-name">
              {source.name}
            </span>
          </button>
        )}
        {/* Its actions on the name's row, on hover (T53 item 4), even while it is collapsed. */}
        <TreeActions
          currentFolder={currentFolder}
          onCurrentFolderChange={onCurrentFolderChange}
          trash={{ href: trash, testId: 'section-trash', current: trashOpen }}
          timeMachine={{ href: timeMachine, current: timeMachineOpen }}
        />
        <GitSectionStatus source={source} />
      </header>
      {menu ? (
        <ContextMenu label={`Notebook ${source.name}`} x={menu.x} y={menu.y} onClose={closeMenu}>
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            className="menu-item"
            data-ui="item"
            data-testid="notebook-rename"
            onClick={() => {
              setMenu(null);
              setRenaming(true);
            }}
          >
            <Icon name="pencil" />
            <span className="menu-label">Rename Notebook</span>
          </button>
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            className="menu-item"
            data-ui="item"
            data-testid="notebook-settings"
            onClick={() => {
              setMenu(null);
              navigate(gitNotebookPath(source.id));
            }}
          >
            <Icon name="settings" />
            <span className="menu-label">Notebook Settings</span>
          </button>
        </ContextMenu>
      ) : null}
      {renaming ? (
        <p className="sb-section-clash muted" data-testid="notebook-rename-hint">
          Renames it on every device that syncs it.
        </p>
      ) : clash ? (
        <div className="sb-section-clash">
          <NameClash
            name={clash.name}
            other={clash.other}
            suggestion={clash.suggestion}
            onUse={(name) => void rename(name)}
            onKeep={() => void rename(clash.name, true)}
            onCancel={cancel}
          />
        </div>
      ) : message && !message.startsWith('Renamed') ? (
        <p className="sb-section-clash muted" role="status">
          {message}
        </p>
      ) : null}
      {collapsed ? null : (
        <div id={`${id}-body`} className="sb-section-body">
          <FolderTree
            activeId={activeId}
            currentFolder={currentFolder}
            onCurrentFolderChange={onCurrentFolderChange}
            shown={shown}
            active={active}
          />
        </div>
      )}
    </section>
  );
}

/**
 * The notebook's name, edited in place on its row (Rename Notebook): Enter or leaving it renames,
 * Escape keeps the name. As a folder's Rename in the tree (FolderTree's NameInput).
 */
function NotebookNameInput({
  label,
  initial,
  onDone,
}: {
  label: string;
  initial: string;
  /** The name typed, or null for Escape. */
  onDone: (name: string | null) => void;
}) {
  const done = useRef(false);
  const finish = (name: string | null) => {
    if (done.current) return;
    done.current = true;
    onDone(name);
  };
  return (
    <input
      className="tree-input"
      aria-label={label}
      data-testid="notebook-rename-input"
      defaultValue={initial}
      autoFocus
      maxLength={80}
      onFocus={(event) => event.currentTarget.select()}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === 'Enter') {
          event.preventDefault();
          finish(event.currentTarget.value);
        } else if (event.key === 'Escape') {
          event.preventDefault();
          finish(null);
        }
      }}
      onBlur={(event) => finish(event.currentTarget.value)}
    />
  );
}
