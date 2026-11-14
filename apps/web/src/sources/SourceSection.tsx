import { Icon } from '@penmoss/ui/icons';
import { useId, useState, useSyncExternalStore, type ReactNode } from 'react';
import { gitNotebookPath, linkHandler, useLocation } from '../router';
import { TIME_MACHINE_PATH, timeMachinePath } from '../time-machine/path';
import { FolderTree } from '../workspace/FolderTree';
import { TreeActions } from '../workspace/TreeActions';
import type { GitSyncStatus } from './engine-host';
import type { GitSource } from './git-source';
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
  stopped: 'Sync stopped',
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
 * A section's header without its tree (T51, A933): the source in use's above a tag's notes, so
 * the dot always names what it covers. Rendered in the source's scope.
 */
export function SourceHeading({
  source,
  actions,
}: {
  source: Source;
  /** The notebook's actions on its row (T53 item 4), above its tree; none above a tag's notes. */
  actions?: ReactNode;
}) {
  return (
    <div
      className="sb-section-head sb-heading"
      data-testid="source-heading"
      data-source={source.id}
      data-kind={source.kind}
    >
      <h2 className="sb-section-name">{source.name}</h2>
      {actions}
      <GitSectionStatus source={source} />
    </div>
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
      <header className="sb-section-head">
        <button
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
        {/* Its actions on the name's row, on hover (T53 item 4), even while it is collapsed. */}
        <TreeActions
          currentFolder={currentFolder}
          onCurrentFolderChange={onCurrentFolderChange}
          trash={{ href: trash, testId: 'section-trash', current: trashOpen }}
          timeMachine={{ href: timeMachine, current: timeMachineOpen }}
        />
        <GitSectionStatus source={source} />
      </header>
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
