import { Icon, type IconName } from '@penmoss/ui/icons';
import { deviceStorage } from '../shell/device-pref';
import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ShortcutsSettings } from '../commands/ShortcutsSettings';
import { desktop } from '../desktop/bridge';
import { JournalSettings } from '../journal/JournalSettings';
import { QuickCaptureSettings } from '../journal/QuickCaptureSettings';
import { GitNotebooksSettings } from '../sources/GitNotebooksSettings';
import { useEveryOpenNoteList } from '../sources/lists';
import { AgentActivitySettings } from '../sources/AgentActivitySettings';
import { AgentsSettings } from '../sources/AgentsSettings';
import { JournalScope } from '../sources/JournalScope';
import { NotebookNavEntries } from '../sources/NotebookNavEntries';
import { mainTabs } from '../tabs/controller';
import { lastOpenedNote, readOpened } from '../notes/recent';
import {
  isPlainLeftClick,
  linkHandler,
  navigate,
  notePath,
  settingsPath,
  settingsRedirect,
  type SettingsSection,
} from '../router';
import { SidebarSettings } from '../shell/SidebarSettings';
import { HistoryNav } from '../shell/HistoryNav';
import { NoteSettings } from '../notes/NoteSettings';
import { AiDescriptionsSettings } from '../notes/AiDescriptionsSettings';
import { SymbolsSettings } from '../notes/SymbolsSettings';
import { GitHubSettings } from '../feedback/GitHubSettings';
import { MeaningSettings } from '../search/MeaningSettings';
import { UpdatesSettings } from '../updates/UpdatesSettings';
import { AppearanceSettings } from '../theme/AppearanceSettings';
import { AnalyticsData } from '../analytics/AnalyticsData';
import { PrivacyNavEntry } from '../analytics/PrivacyNavEntry';
import { PrivacySettings } from '../analytics/PrivacySettings';
import { SETTINGS_GROUPS, SETTINGS_PAGES, type SettingEntry } from './settings-index';
import { SettingsHomeProvider } from './SettingsHeader';
import { SettingsSearch, SettingsSearchResults } from './SettingsSearch';
import { revealSetting, useSettingsSearch } from './settings-search';

/** Each section's icon (one per section, the same on the phone, A902) and its command. */
const NAV: Readonly<
  Record<SettingsSection, { readonly icon: IconName; readonly command?: string }>
> = {
  appearance: { icon: 'palette', command: 'app.appearance' },
  // Display became Sidebar (PEN-146); `app.display` opens it.
  sidebar: { icon: 'panelL', command: 'app.display' },
  note: { icon: 'file' },
  // T44 (A743): how notes look, beside Note.
  symbols: { icon: 'star', command: 'app.symbols' },
  journal: { icon: 'journal', command: 'journal.settings' },
  'quick-capture': { icon: 'inbox' },
  shortcuts: { icon: 'keyboard', command: 'app.shortcuts' },
  // PEN-161: a short description of each note, for agents.
  'ai-descriptions': { icon: 'sparkle' },
  // T50 (A856): git notebooks on this Mac.
  'git-notebooks': { icon: 'terminal', command: 'app.gitNotebooks' },
  // The agents that reach them, and the penmoss command (Ryan's feedback, 5 Nov 2026; A1098).
  agents: { icon: 'agentRef' },
  'agent-activity': { icon: 'history' },
  // Search by meaning on this Mac (T78, A1158): the Mac app's.
  meaning: { icon: 'search' },
  // Status became GitHub (PEN-146): the sign-in Send Feedback and Add Notebook use.
  github: { icon: 'key', command: 'app.status' },
  // Auto-Update (T64 item 2, A1112): the Mac app's.
  updates: { icon: 'refresh', command: 'app.checkForUpdates' },
  // Usage analytics and the logs (PEN-137): the Mac app's.
  privacy: { icon: 'shield', command: 'app.privacy' },
};

/**
 * The sections this build shows: git, agents, updates, meaning and privacy need the Mac app's
 * bridges.
 */
function availableSections(): SettingsSection[] {
  const bridge = desktop();
  return SETTINGS_PAGES.map((page) => page.id).filter((id) => {
    if (id === 'git-notebooks' || id === 'agents' || id === 'agent-activity') {
      return Boolean(bridge?.git);
    }
    if (id === 'updates') return Boolean(bridge?.updates);
    if (id === 'meaning') return Boolean(bridge?.meaning);
    if (id === 'github') return Boolean(bridge?.githubToken);
    if (id === 'privacy') return Boolean(bridge?.analytics);
    return true;
  });
}

/**
 * Settings (T20 onwards, T36 layout; PEN-146): a bar with the way back to the notes, Search
 * Settings over the sections, the sections as a side list in five groups (a row of tabs on a
 * narrow window), and one section at a time, which opens with the one header every page has
 * (`SettingsHeader`, A1560: "Settings (i)", where they are kept, then the page's title). While
 * there is a query, its results stand in for the section.
 */
export function SettingsPage({
  section,
  item,
}: {
  section: SettingsSection;
  /** A git notebook's own page (A1098), or the notebook Agents unfolds (A1125). */
  item?: string | undefined;
}) {
  const shown = availableSections();
  // A renamed section's old address (/settings/display, /settings/status) shows the new one's.
  useLayoutEffect(() => {
    const to = settingsRedirect(window.location.pathname);
    if (to) navigate(to, { replace: true });
  }, [section]);
  const search = useSettingsSearch(shown);
  /** The setting a result opened: scrolled to and marked once its page shows it. */
  const [found, setFound] = useState<SettingEntry | null>(null);
  const content = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!found || found.section !== section || search.query) return;
    return revealSetting(content.current, found.id, () => setFound(null));
  }, [found, section, search.query]);
  const open = (entry: SettingEntry) => {
    search.clear();
    setFound(entry);
    navigate(settingsPath(entry.section));
  };

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
  }, [section, item]);
  // In the Mac app, back to the note open before Settings, not the empty home page (B13).
  const last = desktop() ? lastOpenedNote(list, readOpened(deviceStorage())) : null;
  const back = last ? notePath(last) : '/';
  const pages = SETTINGS_PAGES.filter((page) => shown.includes(page.id));
  return (
    <main className="settings-shell" data-testid="app-root">
      <header className="settings-bar">
        {/* Back and Forward, at the start of the window's first row as on every page (A943). */}
        <HistoryNav testIdPrefix="app" />
        <a
          href={back}
          className="back-link"
          data-command={back === '/' ? 'app.home' : undefined}
          onClick={(event) => {
            // With tabs, back to the tab as it was before Settings (PEN-140, A1497).
            const tabs = mainTabs();
            if (tabs && isPlainLeftClick(event) && tabs.leaveSettings()) {
              event.preventDefault();
              return;
            }
            linkHandler(back)(event);
          }}
          data-tip="Back to Your Notes"
        >
          <Icon name="arrowL" />
          Notes
        </a>
      </header>
      <div className="settings-page" data-testid="settings">
        <div className="settings-layout">
          <div className="settings-side">
            <SettingsSearch search={search} onOpen={open} />
            <nav ref={nav} className="settings-nav" aria-label="Settings Sections">
              {SETTINGS_GROUPS.map((group) => {
                const inGroup = pages.filter((page) => page.group === group.id);
                if (inGroup.length === 0) return null;
                const headingId = `settings-group-${group.id}`;
                return (
                  <div
                    key={group.id}
                    role="group"
                    className="settings-nav-group"
                    aria-labelledby={headingId}
                    data-group={group.id}
                  >
                    <p id={headingId} className="settings-nav-heading">
                      {group.label}
                      {group.scope ? (
                        <span className="settings-nav-scope"> · {group.scope}</span>
                      ) : null}
                    </p>
                    {inGroup.map((page) => {
                      const path = settingsPath(page.id);
                      // A notebook's own page is its own entry's, not All Notebooks' (and
                      // Analytics Data is its own, not Privacy's).
                      const current =
                        page.id === section &&
                        !((page.id === 'git-notebooks' || page.id === 'privacy') && item);
                      return (
                        <Fragment key={page.id}>
                          <a
                            href={path}
                            data-command={NAV[page.id].command}
                            aria-current={current ? 'page' : undefined}
                            onClick={linkHandler(path)}
                          >
                            <Icon name={NAV[page.id].icon} />
                            {/* As wide as its bold self, so the phone's tabs keep still (A988). */}
                            <span className="bold-steady" data-label={page.label}>
                              {page.label}
                            </span>
                          </a>
                          {page.id === 'git-notebooks' ? (
                            <NotebookNavEntries
                              current={section === 'git-notebooks' ? item : undefined}
                            />
                          ) : null}
                          {page.id === 'privacy' ? (
                            <PrivacyNavEntry current={section === 'privacy' && item === 'data'} />
                          ) : null}
                        </Fragment>
                      );
                    })}
                  </div>
                );
              })}
            </nav>
          </div>
          <div ref={content} className="settings-content">
            <SettingsHomeProvider>
              {search.query ? (
                <SettingsSearchResults search={search} onOpen={open} />
              ) : (
                <SectionContent section={section} item={item} />
              )}
            </SettingsHomeProvider>
          </div>
        </div>
      </div>
    </main>
  );
}

function SectionContent({
  section,
  item,
}: {
  section: SettingsSection;
  item?: string | undefined;
}) {
  switch (section) {
    case 'appearance':
      return <AppearanceSettings />;
    case 'sidebar':
      return <SidebarSettings />;
    case 'note':
      return <NoteSettings />;
    case 'symbols':
      return <SymbolsSettings />;
    case 'journal':
      return (
        // The Journal notebook's own settings (A827).
        <JournalScope>
          <JournalSettings />
        </JournalScope>
      );
    case 'quick-capture':
      return <QuickCaptureSettings />;
    case 'shortcuts':
      return <ShortcutsSettings />;
    case 'ai-descriptions':
      return <AiDescriptionsSettings />;
    case 'git-notebooks':
      return <GitNotebooksSettings item={item} />;
    case 'agents':
      return <AgentsSettings item={item} />;
    case 'agent-activity':
      return <AgentActivitySettings />;
    case 'meaning':
      return <MeaningSettings />;
    case 'github':
      return <GitHubSettings />;
    case 'updates':
      return <UpdatesSettings />;
    case 'privacy':
      return item === 'data' ? <AnalyticsData /> : <PrivacySettings />;
  }
}
