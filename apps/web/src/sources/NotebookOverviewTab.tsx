/** A notebook page's Overview tab (GitNotebooksSettings.tsx). */
import { Icon } from '@penmoss/ui/icons';
import { useId, useState, useSyncExternalStore, type FormEvent } from 'react';
import { type DesktopGit } from '../desktop/bridge';
import { navigate } from '../router';
import { BadgeSettings } from './BadgeSettings';
import { repositoryLink } from './repository-link';
import { useGitInfo, useSourcesRegistry, useSourcesState } from './hooks';
import { forgetGitStores } from './forget';
import type { GitSource } from './git-source';
import { NameClash } from './NameClash';
import { useNotebookRename } from './notebook-names';
import { SettingRow } from '../theme/look-rows';
import { NotebookAiRow } from './NotebookAiRow';
import { ConfirmBlock } from '../shell/ConfirmBlock';
import { counted } from '@penmoss/core/words';
import { ALL_OTHERS, type Answer } from './notebook-settings-shared';
import { CopySettingsPanel } from './BetweenNotebooks';

/** “3 notes have changes”, “The folders have changes”, “2 notes and the folders have changes”. */
function unpushedWords(notes: number, folders: boolean): string {
  if (notes === 0) return 'The folders have changes';
  return `${counted(notes, 'note')}${folders ? ' and the folders' : ''} ${notes === 1 && !folders ? 'has' : 'have'} changes`;
}

/** How many notes a notebook holds, as its list changes. */
function useNoteCount(source: GitSource): number {
  return useSyncExternalStore(
    (listener) => source.notes.subscribe(listener),
    () => source.notes.list().length,
    () => source.notes.list().length,
  );
}

/** Overview: Name, Repository, its notes, Copy Settings…, and Remove from This Mac… at the foot. */
export function OverviewTab({
  source,
  git,
  answer,
  busy,
  onMessage,
}: {
  source: GitSource;
  git: DesktopGit;
  answer: Answer;
  busy: boolean;
  onMessage: (message: string) => void;
}) {
  const info = useGitInfo(source);
  const state = useSourcesState();
  const registry = useSourcesRegistry();
  const notes = useNoteCount(source);
  const [copying, setCopying] = useState(false);
  const primary = state.journal.id === source.id;
  const link = repositoryLink(info);

  /** What Remove would lose (null: not asked yet), and whether that was known. */
  const [removing, setRemoving] = useState<{
    readonly known: boolean;
    readonly notes: number;
    readonly folders: boolean;
  } | null>(null);

  const removeNow = (lost: { notes: number; folders: boolean } | null) =>
    void answer(
      () => git.remove(info.localId, lost ? lost.notes + (lost.folders ? 1 : 0) : null),
      () =>
        lost && lost.notes === 0 && !lost.folders
          ? `Removed “${info.name}” from this Mac. Everything was pushed: the repository keeps it all.`
          : `Removed “${info.name}” from this Mac. Changes that were not pushed are gone; the repository keeps everything pushed before.`,
    ).then(() => {
      setRemoving(null);
      // Its source has stopped (the list was read again): its local data goes too, and its page.
      if (!registry.gitSource(source.id)) {
        void forgetGitStores(source.id);
        navigate('/settings/git-notebooks');
      }
    });

  /** Remove: straight to Touch ID when everything is pushed; otherwise say what would be lost. */
  const remove = async () => {
    const lost = await source.unpushed();
    if (lost && lost.notes === 0 && !lost.folders) removeNow(lost);
    else
      setRemoving({
        known: lost !== null,
        notes: lost?.notes ?? 0,
        folders: lost?.folders ?? false,
      });
  };

  return (
    <>
      <div className="lf-group nset-first-group">
        <NotebookName source={source} />
        {/* Its badge (PEN-140, ac17), right after its name. */}
        <BadgeSettings source={source} />
        <SettingRow
          setting="repository"
          label="Repository"
          help={
            <span className="selectable" data-testid="git-repository">
              {info.repository} · branch {info.branch}
              {info.dir ? ` · folder ${info.dir}` : ''}
            </span>
          }
        >
          {link ? (
            // The help keeps the remote's own words (an SSH alias stays the alias); the link
            // goes to the host's real name (A1565).
            <a
              href={link.url}
              target="_blank"
              rel="noopener noreferrer"
              className="btn"
              data-ui="item"
              data-event="settings.git-notebooks.repository-link"
              data-testid="git-repository-link"
            >
              <Icon name="globe" size={14} />
              {link.github ? 'Open on GitHub' : 'Open in Browser'}
            </a>
          ) : null}
        </SettingRow>
        <SettingRow
          setting="notebook-notes"
          label="Notes"
          testId="git-note-count"
          help={counted(notes, 'note')}
        />
        <NotebookAiRow source={source} />
        {state.all.length > 1 ? (
          <SettingRow
            setting="notebook-copy-settings"
            label="Settings"
            help="Copy from or to other notebooks"
          >
            <button
              data-event="settings.git-notebooks.copy-settings.open"
              data-ui="item"
              type="button"
              className="btn"
              aria-expanded={copying}
              data-testid="git-copy-settings-open"
              onClick={() => setCopying((was) => !was)}
            >
              <Icon name="copy" size={14} />
              Copy Settings…
            </button>
          </SettingRow>
        ) : null}
        {copying ? (
          <CopySettingsPanel
            from={primary ? source.id : state.journal.id}
            to={primary ? ALL_OTHERS : source.id}
            onClose={() => setCopying(false)}
          />
        ) : null}
      </div>
      <div className="nset-foot" data-setting="remove-from-this-mac">
        <button
          data-event="settings.git-notebooks.remove"
          data-ui="item"
          type="button"
          className="btn danger"
          data-testid="git-remove"
          disabled={busy}
          onClick={() => void remove()}
        >
          <Icon name="trash" size={14} />
          Remove from This Mac…
        </button>
        {removing ? (
          <ConfirmBlock
            className="git-remove-confirm"
            title="Remove This Notebook?"
            testId="git-remove-confirm"
          >
            <p>
              {removing.known
                ? `${unpushedWords(removing.notes, removing.folders)} not pushed yet: removing now loses ${removing.notes + (removing.folders ? 1 : 0) === 1 ? 'it' : 'them'}.`
                : 'Penmoss cannot tell yet whether everything here is pushed: removing now may lose changes.'}
            </p>
            <div className="settings-actions">
              <button
                data-event="settings.git-notebooks.remove.push-first"
                data-ui="item"
                type="button"
                className="btn primary"
                data-testid="git-remove-push"
                onClick={() => {
                  setRemoving(null);
                  source.syncNow();
                  onMessage('Pushing first. Remove once it says Synced.');
                }}
              >
                <Icon name="refresh" size={14} />
                Push First
              </button>
              <button
                data-event="settings.git-notebooks.remove.anyway"
                data-ui="item"
                type="button"
                className="btn danger"
                data-testid="git-remove-anyway"
                disabled={busy}
                onClick={() =>
                  removeNow(
                    removing.known ? { notes: removing.notes, folders: removing.folders } : null,
                  )
                }
              >
                Remove Anyway
              </button>
              <button
                data-event="settings.git-notebooks.remove.keep"
                data-ui="item"
                type="button"
                className="btn"
                onClick={() => setRemoving(null)}
              >
                Keep It
              </button>
            </div>
          </ConfirmBlock>
        ) : (
          <p className="muted nset-foot-note">
            Removes this Mac’s copy, after Touch ID. The repository keeps everything pushed.
          </p>
        )}
      </div>
    </>
  );
}

/**
 * The notebook's name (Ryan's review of PR #192): Rename writes it to `notebook.json` at the next
 * sync, so every device and agent follows; a name another notebook here has is warned about.
 */
function NotebookName({ source }: { source: GitSource }) {
  const info = useGitInfo(source);
  const id = useId();
  const { rename, clash, message, cancel } = useNotebookRename(source);
  const [draft, setDraft] = useState(info.name);
  // Renamed elsewhere (the sidebar, another device): the field shows the new name.
  const [shown, setShown] = useState(info.name);
  if (shown !== info.name) {
    setShown(info.name);
    setDraft(info.name);
  }
  const unchanged = draft.trim() === '' || draft.trim() === info.name;
  return (
    <>
      <SettingRow
        setting="notebook-name"
        label="Name"
        labelFor={`${id}-name`}
        help={
          <>
            Renames it on every device that syncs it. Agents still find it by its old name.
            {info.pendingName ? ' The new name goes to the repository at the next sync.' : ''}
          </>
        }
      >
        <form
          className="git-notebook-rename"
          onSubmit={(event: FormEvent) => {
            event.preventDefault();
            void rename(draft);
          }}
        >
          <input
            id={`${id}-name`}
            className="input nset-name-input"
            maxLength={80}
            value={draft}
            data-testid="git-notebook-name"
            onChange={(event) => setDraft(event.target.value)}
          />
          <button
            data-event="settings.git-notebooks.rename"
            type="submit"
            className="btn"
            data-ui="submit"
            data-testid="git-notebook-rename"
            disabled={unchanged}
          >
            Rename
          </button>
        </form>
      </SettingRow>
      {clash ? (
        <div className="nset-row-note">
          <NameClash
            name={clash.name}
            other={clash.other}
            suggestion={clash.suggestion}
            onUse={(name) => {
              setDraft(name);
              void rename(name);
            }}
            onKeep={() => void rename(clash.name, true)}
            onCancel={() => {
              cancel();
              setDraft(info.name);
            }}
          />
        </div>
      ) : null}
      <p role="status" className="git-message muted nset-row-note" data-testid="git-rename-message">
        {message}
      </p>
    </>
  );
}
