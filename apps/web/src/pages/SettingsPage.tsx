import { Icon, type IconName } from '@penmoss/ui/icons';
import { useLayoutEffect, useRef } from 'react';
import { ShortcutsSettings } from '../commands/ShortcutsSettings';
import { desktop } from '../desktop/bridge';
import { JournalSettings } from '../journal/JournalSettings';
import { GitNotebooksSettings } from '../sources/GitNotebooksSettings';
import { useEveryOpenNoteList } from '../sources/lists';
import { AgentsSettings } from '../sources/AgentsSettings';
import { JournalScope } from '../sources/JournalScope';
import { useSourcesState } from '../sources/hooks';
import { gitNotebookPath } from '../router';
import { browserStorage, lastOpenedNote, readOpened } from '../notes/recent';
import { linkHandler, notePath, type SettingsSection } from '../router';
import { DisplaySettings } from '../shell/DisplaySettings';
import { HistoryNav } from '../shell/HistoryNav';
import { SymbolsSettings } from '../notes/SymbolsSettings';
import { FeedbackStatus } from '../feedback/FeedbackStatus';
import { GitHubTokenSettings } from '../feedback/GitHubTokenSettings';
import { MeaningSettings } from '../search/MeaningSettings';
import { UpdatesSettings } from '../updates/UpdatesSettings';
import { AppearanceSettings } from '../theme/AppearanceSettings';

const SECTIONS: ReadonlyArray<{
  readonly id: SettingsSection;
  readonly label: string;
  readonly icon: IconName;
  readonly command?: string;
}> = [
  // The order of every client's Settings (T39 pass 3, A551): Appearance first; T42's Display
  // after it. One icon per section, the same on the phone (A902).
  { id: 'appearance', label: 'Appearance', icon: 'palette', command: 'app.appearance' },
  { id: 'display', label: 'Display', icon: 'panelL', command: 'app.display' },
  // T44 (A743): after Display, both about how notes look; the phone's Settings has it there too.
  { id: 'symbols', label: 'Symbols', icon: 'star', command: 'app.symbols' },
  // T50 (A856): git notebooks on this Mac.
  { id: 'git-notebooks', label: 'Notebooks', icon: 'terminal', command: 'app.gitNotebooks' },
  // The agents that reach them, and the penmoss command (Ryan's feedback, 5 Nov 2026; A1098).
  { id: 'agents', label: 'Agents', icon: 'agentRef' },
  { id: 'journal', label: 'Daily Notes', icon: 'journal', command: 'journal.settings' },
  { id: 'shortcuts', label: 'Keyboard Shortcuts', icon: 'keyboard', command: 'app.shortcuts' },
  // Search by meaning on this Mac (T78, A1158): the Mac app's.
  { id: 'meaning', label: 'Search by Meaning', icon: 'search' },
  // Auto-Update (T64 item 2, A1112): the Mac app's.
  { id: 'updates', label: 'Updates', icon: 'refresh', command: 'app.checkForUpdates' },
  // Send feedback's GitHub token and what waits in its outbox (T49, T57).
  { id: 'status', label: 'Status', icon: 'pulse', command: 'app.status' },
];

/**
 * Settings (T20 onwards, T36 layout): a header with the way back to the notes, the sections as
 * a side list (a row of tabs on a narrow window), and one section at a time.
 */
export function SettingsPage({
  section,
  item,
}: {
  section: SettingsSection;
  /** A git notebook's own page (A1098). */
  item?: string | undefined;
}) {
  // Git notebooks and their agents need the Mac app's git.
  const sections = (
    desktop()?.git
      ? SECTIONS
      : SECTIONS.filter((each) => each.id !== 'git-notebooks' && each.id !== 'agents')
  )
    .filter((each) => each.id !== 'updates' || Boolean(desktop()?.updates))
    .filter((each) => each.id !== 'meaning' || Boolean(desktop()?.meaning));
  // On a narrow window the sections are a row of tabs wider than the screen: the current one is
  // scrolled into sight, so the last does not open with its tab out of view (T39).
  // Every notebook's notes, not only the Journal's: the last note may be in any (T62 item 10).
  const list = useEveryOpenNoteList();
  const nav = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const row = nav.current;
    const tab = row?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!row || !tab || row.scrollWidth <= row.clientWidth) return;
    const start = tab.offsetLeft - row.offsetLeft;
    const end = start + tab.offsetWidth;
    if (start < row.scrollLeft) row.scrollLeft = start - 16;
    else if (end > row.scrollLeft + row.clientWidth) row.scrollLeft = end - row.clientWidth + 16;
  }, [section]);
  // In the Mac app, back to the note open before Settings, not the empty home page (B13).
  const last = desktop() ? lastOpenedNote(list, readOpened(browserStorage())) : null;
  const back = last ? notePath(last) : '/';
  return (
    <main className="settings-shell" data-testid="app-root">
      <header className="settings-bar">
        {/* Back and Forward, at the start of the window's first row as on every page (A943). */}
        <HistoryNav testIdPrefix="app" />
        <a
          href={back}
          className="back-link"
          data-command={back === '/' ? 'app.home' : undefined}
          onClick={linkHandler(back)}
          data-tip="Back to Your Notes"
        >
          <Icon name="arrowL" />
          Notes
        </a>
      </header>
      <div className="settings-page" data-testid="settings">
        <div className="settings-title">
          <h1>Settings</h1>
          <SettingsHome />
        </div>
        <div className="settings-layout">
          <nav ref={nav} className="settings-nav" aria-label="Settings sections">
            {sections.map((each) => (
              <a
                key={each.id}
                href={`/settings/${each.id}`}
                data-command={each.command}
                aria-current={each.id === section ? 'page' : undefined}
                onClick={linkHandler(`/settings/${each.id}`)}
              >
                <Icon name={each.icon} />
                {/* As wide as its bold self, so the phone's tabs keep still (A988). */}
                <span className="bold-steady" data-label={each.label}>
                  {each.label}
                </span>
              </a>
            ))}
          </nav>
          <div className="settings-content">
            {section === 'shortcuts' ? <ShortcutsSettings /> : null}
            {section === 'journal' ? (
              // The Journal notebook's own settings (A827).
              <JournalScope>
                <JournalSettings />
              </JournalScope>
            ) : null}
            {section === 'git-notebooks' ? <GitNotebooksSettings item={item} /> : null}
            {section === 'agents' ? <AgentsSettings item={item} /> : null}
            {section === 'appearance' ? <AppearanceSettings /> : null}
            {section === 'display' ? <DisplaySettings /> : null}
            {section === 'symbols' ? <SymbolsSettings /> : null}
            {/* Send feedback's token, and what waits to be sent from this device (T49, T57). */}
            {section === 'meaning' ? <MeaningSettings /> : null}
            {section === 'updates' ? <UpdatesSettings /> : null}
            {section === 'status' ? <GitHubTokenSettings /> : null}
            {section === 'status' ? <FeedbackStatus /> : null}
          </div>
        </div>
      </div>
    </main>
  );
}

/**
 * Where the settings are kept (Quanta feedback 3, item 9; A1136): the primary notebook, named
 * under the heading on every section, a link to its page. With one notebook it is still named,
 * so the place is never a guess. A sentence of its own under the heading, not a note beside it
 * (PEN-135 item 11).
 */
function SettingsHome() {
  const state = useSourcesState();
  if (!state) return null;
  const path = gitNotebookPath(state.root.id);
  return (
    <p className="settings-home muted" data-testid="settings-home">
      Settings are synced through your primary notebook,{' '}
      <a
        href={path}
        data-ui="item"
        // Named apart from "← Notes" when the notebook is called Notes.
        aria-label={`${state.root.name}, your primary notebook`}
        onClick={linkHandler(path)}
        data-testid="settings-home-link"
      >
        {state.root.name}
      </a>
      .
    </p>
  );
}
