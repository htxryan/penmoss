/** The first run's GitHub account switcher, on its repository screens (FirstRunRepos.tsx). */
import { Icon } from '@penmoss/ui/icons';
import { Menu, MenuItem } from '../shell/Menu';
import { accountChoices, type AccountChoice } from './github-choices';
import { useEffect, useState } from 'react';
import type { DesktopGitHubBrowse, GitHubAccountChoice } from '../desktop/bridge';
import { type Hub } from './first-run-flow';
import { hostWords } from './host-words';

/** The account on the switcher's button: its login, else whose sign-in it is. */
const whoOf = (hub: Hub) =>
  hub.login ?? (hub.via === 'git' ? hostWords().foundSignInTitle : 'GitHub Account');

/**
 * Whose repositories these are, as a control (Ryan's pick, option 2, 17 Nov 2026; A1617): the
 * account above Pick Repository and Create New Repo, and a menu of every account (the one in use
 * checked) with Add Another Account, Manage GitHub Accounts and Refresh.
 */
export function AccountSwitcher({
  github,
  hub,
  onPick,
  onAdd,
  onManage,
  onRefresh,
  line = 'Listing this account’s repositories',
}: {
  github: DesktopGitHubBrowse;
  hub: Hub;
  /** What the account is for here, under its name. */
  line?: string;
  onPick: (account: GitHubAccountChoice | undefined) => void;
  onAdd: () => void;
  onManage?: (() => void) | undefined;
  onRefresh: () => void;
}) {
  const [choices, setChoices] = useState<readonly AccountChoice[]>([]);
  useEffect(() => {
    let live = true;
    void accountChoices(github).then((all) => {
      if (live) setChoices(all);
    });
    return () => {
      live = false;
    };
  }, [github]);
  const who = whoOf(hub);
  // The account whose token read these; with none picked, git's, else the first (A1617).
  const current =
    hub.account !== undefined
      ? choices.find((each) => each.key !== 'git' && each.account === hub.account)
      : (choices.find((each) => each.key === 'git') ??
        choices.find((each) => hub.login !== null && each.login === hub.login));
  return (
    <Menu
      data-event="firstrun.account.open"
      label="GitHub Account"
      icon="users"
      className="fr-switcher"
      testId="first-run-account-switcher"
      face={
        <>
          <span className="fr-switcher-initial" aria-hidden="true">
            {(hub.login ?? 'G').slice(0, 1).toUpperCase()}
          </span>
          <span className="fr-switcher-text">
            <strong data-testid="first-run-via">{who}</strong>
            <span>{line}</span>
          </span>
          <Icon name="chevD" size={14} />
        </>
      }
    >
      {choices.map((each) => {
        const checked = each === current;
        return (
          <button
            key={each.key}
            type="button"
            role="menuitemradio"
            aria-checked={checked}
            tabIndex={-1}
            className="menu-item"
            data-ui="item"
            data-testid={`first-run-switch-${each.key === 'git' ? 'git' : (each.login ?? '')}`}
            data-event="firstrun.account"
            onClick={() => {
              if (!checked) onPick(each.account);
            }}
          >
            <span className="menu-check" aria-hidden="true">
              {checked ? <Icon name="check" /> : null}
            </span>
            <span className="menu-label">
              {each.title}
              <span className="fr-switcher-line">{each.line}</span>
            </span>
          </button>
        );
      })}
      {choices.length > 0 ? <div className="menu-sep" role="separator" /> : null}
      <MenuItem
        data-event="firstrun.account.add"
        icon="userPlus"
        data-testid="first-run-switch-add"
        onClick={onAdd}
      >
        Add Another Account…
      </MenuItem>
      {onManage ? (
        <MenuItem
          data-event="firstrun.account.manage"
          icon="settings"
          data-testid="first-run-switch-manage"
          onClick={onManage}
        >
          Manage GitHub Accounts…
        </MenuItem>
      ) : null}
      <MenuItem
        data-event="firstrun.account.refresh"
        icon="refresh"
        data-testid="first-run-refresh"
        onClick={onRefresh}
      >
        Refresh Repositories
      </MenuItem>
    </Menu>
  );
}
