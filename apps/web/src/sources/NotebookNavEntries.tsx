/**
 * Each notebook's entry in Settings' nav (PEN-146), under All Notebooks, like accounts in Mail:
 * its badge (PEN-140), its sync dot (fine, at work, offline or stopped, as the sidebar's dot reads it, R2-7) and its
 * name, opening its page at `/settings/git-notebooks/<id>`. The shell places these links in its
 * nav; the one open is `aria-current="page"`.
 */
import { desktop } from '../desktop/bridge';
import { gitNotebookPath, linkHandler } from '../router';
import type { GitSource } from './git-source';
import { NotebookBadge } from './NotebookBadge';
import { useAllSources, useGitInfo, useShownGitStatus } from './hooks';
import { dotState, syncLine } from './sync-words';
import './notebook-settings.css';

export function NotebookNavEntries({ current }: { readonly current?: string | undefined }) {
  const state = useAllSources();
  if (!desktop()?.git) return null;
  return (
    <>
      {state.all.map((source) => (
        <NotebookNavEntry key={source.id} source={source} current={source.id === current} />
      ))}
    </>
  );
}

function NotebookNavEntry({ source, current }: { source: GitSource; current: boolean }) {
  const info = useGitInfo(source);
  const status = useShownGitStatus(source);
  const path = gitNotebookPath(source.id);
  const dot = dotState(status);
  return (
    <a
      href={path}
      className="nset-nav-entry"
      data-ui="item"
      data-testid="settings-notebook-entry"
      data-notebook-id={source.id}
      data-state={dot}
      aria-current={current ? 'page' : undefined}
      onClick={linkHandler(path)}
    >
      {/* Its badge (PEN-140), then its sync dot; the name after them says it aloud. */}
      <NotebookBadge source={source} size={16} decorative />
      <span className="nset-dot" data-state={dot} aria-hidden="true" />
      {/* As wide as its bold self, as the other entries are (A988). */}
      <span className="bold-steady" data-label={info.name}>
        {info.name}
      </span>
      <span className="sr-only">, {syncLine(status)}</span>
    </a>
  );
}
