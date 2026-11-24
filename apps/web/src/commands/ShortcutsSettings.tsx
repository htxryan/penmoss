import {
  BROWSER_RESERVED,
  bindingProblem,
  formatCombo,
  isApplePlatform,
  normaliseCombo,
} from '@penmoss/editor/keys';
import { Icon } from '@penmoss/ui/icons';
import { useId, useRef, useState, useSyncExternalStore } from 'react';
import { desktop } from '../desktop/bridge';
import { GroupHead, ScopeMarker } from '../theme/look-rows';
import '../journal/writing.css';
import { settingId } from '../pages/settings-index';
import { linkHandler, settingsPath } from '../router';
import { ConfirmBlock } from '../shell/ConfirmBlock';
import { ConfirmDialog } from '../shell/ConfirmDialog';
import { useWorkspace } from '../workspace/hooks';
import type { CommandArea, CommandDefinition } from './definitions';
import { useCommands, useCommandsVersion } from './hooks';
import { Kbd } from './Kbd';
import { searchesByKeys, useKeyRecorder } from './recorder';
import { SettingsHeader } from '../pages/SettingsHeader';

type Notice =
  | {
      readonly kind: 'conflict';
      readonly id: string;
      readonly combo: string;
      readonly others: string[];
    }
  | { readonly kind: 'error'; readonly id: string; readonly text: string }
  | { readonly kind: 'done'; readonly id: string; readonly text: string };

type Show = 'all' | 'changed' | 'none';

/** The areas in the order their groups show, each as its subhead says it (Title Case). */
const AREAS: ReadonlyArray<readonly [CommandArea, string]> = [
  ['General', 'General'],
  ['Navigation', 'Navigation'],
  ['Daily notes', 'Daily Notes'],
  ['Note', 'Note'],
  ['Editor', 'Editor'],
  ['Insert', 'Insert'],
  ['Symbols', 'Symbols'],
  ['Folders', 'Folders'],
  ['Tags', 'Tags'],
  ['Appearance', 'Appearance'],
  ['Sync', 'Sync'],
];

const keysText = (combos: readonly string[]) =>
  combos.length === 0 ? 'no shortcut' : combos.map((combo) => formatCombo(combo)).join(' or ');

/**
 * Settings → Keyboard Shortcuts (T20; PEN-146 option B): every command, grouped by area under a
 * subhead, with its keys. Clicking the keys records new ones; a combination another command
 * uses (in an overlapping scope) is a conflict, named, with the offer to move it. A search field
 * finds commands by name, area or keys, and takes a combination pressed while it has the focus
 * ("what is ⌥⌘M?"). A filter shows All, only the Changed ones (with their count, as Android's
 * summary has) or the ones with None Set. A changed row says what it replaced and has Reset;
 * Reset to Defaults…, at the top of the page and at the end of the list, asks first. Changes
 * are the user's synced settings, so they apply at once here and on their other devices. The Mac app's capture hotkey is on Quick Capture.
 */
export function ShortcutsSettings() {
  const commands = useCommands();
  useCommandsVersion();
  // Until the user's bindings are read the rows show the defaults (A627); they come from this
  // device's copy of the notebook (D49). Tests wait on it before reading or resetting a row.
  const workspace = useWorkspace();
  const bindingsState = () => (workspace.getState().loaded ? 'local' : 'loading');
  // Only this flag: not every folder or registry change re-renders the list.
  const bindings = useSyncExternalStore(workspace.subscribe, bindingsState, bindingsState);
  const id = useId();
  const [filter, setFilter] = useState('');
  /** A combination pressed in the search field: the commands that have it. */
  const [keyFilter, setKeyFilter] = useState<string | null>(null);
  const [show, setShow] = useState<Show>('all');
  const [searchFocused, setSearchFocused] = useState(false);
  const [capturing, setCapturing] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const editButtons = useRef(new Map<string, HTMLButtonElement>());
  const search = useRef<HTMLInputElement>(null);

  const title = (commandId: string) => commands.definitions.get(commandId)?.title ?? commandId;

  const assign = (commandId: string, combo: string, replace: boolean) => {
    try {
      if (replace) {
        for (const other of commands.conflicts(commandId, combo)) {
          commands.rebind(
            other.id,
            commands.keysOf(other.id).filter((key) => normaliseCombo(key) !== combo),
          );
        }
      }
      commands.rebind(commandId, [combo]);
      setNotice({
        kind: 'done',
        id: commandId,
        text: `${title(commandId)} is now ${formatCombo(combo)}.`,
      });
    } catch (error) {
      setNotice({
        kind: 'error',
        id: commandId,
        text: error instanceof Error ? error.message : 'Could not save the shortcut',
      });
    }
  };

  // Records the next combination while a row is listening (the dispatcher stands aside).
  useKeyRecorder(capturing !== null, (combo) => {
    const commandId = capturing!;
    setCapturing(null);
    editButtons.current.get(commandId)?.focus();
    if (combo === 'Escape') return;
    // A command's own default is always fine (Undo keeps ⌘Z); otherwise the rules of A90.
    const problem = commands.definitions.get(commandId)?.keys.includes(combo)
      ? null
      : bindingProblem(combo);
    if (problem) {
      const shown = formatCombo(combo);
      const text = {
        types: `${shown} would type a character: add ${isApplePlatform() ? '⌘ or ⌃' : 'Ctrl or Alt'}.`,
        altgr: `${shown} is AltGr on many keyboards, which types a character: use Ctrl+Shift or Alt without Ctrl.`,
        reserved: `${shown} is kept for copying, pasting, finding and editing text.`,
      }[problem];
      setNotice({ kind: 'error', id: commandId, text });
      return;
    }
    if (BROWSER_RESERVED.has(combo)) {
      setNotice({
        kind: 'error',
        id: commandId,
        text: `${formatCombo(combo)} is kept by the browser.`,
      });
      return;
    }
    const others = commands.conflicts(commandId, combo).map((other) => other.id);
    if (others.length > 0) {
      setNotice({ kind: 'conflict', id: commandId, combo, others });
      return;
    }
    assign(commandId, combo, false);
  });

  // While the search field has the focus, a combination a command could have searches for it;
  // typing, editing and moving in the field go on as usual. It stands aside while a row records.
  useKeyRecorder(searchFocused && capturing === null, (combo) => {
    if (!searchesByKeys(combo)) return false;
    setKeyFilter(normaliseCombo(combo));
    setFilter('');
    return true;
  });

  const all = [...commands.definitions.values()];
  const changed = all.filter((command) => commands.isCustom(command.id));
  const query = filter.trim().toLowerCase();
  const rows = all.filter((command) => {
    const keys = commands.keysOf(command.id);
    if (show === 'changed' && !commands.isCustom(command.id)) return false;
    if (show === 'none' && keys.length > 0) return false;
    if (keyFilter && !keys.some((combo) => normaliseCombo(combo) === keyFilter)) return false;
    return (
      !query ||
      command.title.toLowerCase().includes(query) ||
      command.area.toLowerCase().includes(query) ||
      keys.some((combo) => formatCombo(combo).toLowerCase().includes(query))
    );
  });
  const known = new Set(AREAS.map(([area]) => area));
  const groups = [
    ...AREAS,
    ...[...new Set(all.map((command) => command.area))]
      .filter((area) => !known.has(area))
      .map((area) => [area, area] as const),
  ]
    .map(([area, label]) => ({
      area,
      label,
      rows: rows.filter((command) => command.area === area),
    }))
    .filter((group) => group.rows.length > 0);
  const clashes = commands.allConflicts();

  const row = (command: CommandDefinition) => {
    const keys = commands.keysOf(command.id);
    const custom = commands.isCustom(command.id);
    const listening = capturing === command.id;
    const rowNotice = notice?.id === command.id ? notice : null;
    const help = custom
      ? `Changed from ${keysText(command.keys)}`
      : keys.length === 0
        ? 'No Shortcut'
        : undefined;
    return (
      <div
        key={command.id}
        className={`lf-row kb-row${listening ? ' capturing' : ''}${custom ? ' changed' : ''}`}
        data-command-row={command.id}
        data-setting={settingId(command.title)}
      >
        <div className="lf-row-text">
          <span className="lf-row-label">
            {command.title}
            {command.pending ? (
              <span className="muted"> · arrives with {command.pending}</span>
            ) : null}
          </span>
          {help ? <span className="lf-row-help">{help}</span> : null}
          {rowNotice?.kind === 'conflict' ? (
            <ConfirmBlock
              className="kb-conflict"
              title="Replace This Shortcut?"
              testId="shortcut-conflict"
            >
              <span>
                <Kbd combo={rowNotice.combo} /> is used by{' '}
                {rowNotice.others.map((other) => `“${title(other)}”`).join(' and ')}.
              </span>
              <button
                type="button"
                className="btn"
                data-ui="submit"
                data-event="settings.shortcuts.conflict.replace"
                onClick={() => {
                  setNotice(null);
                  assign(command.id, rowNotice.combo, true);
                }}
              >
                Use It Here Instead
              </button>
              <button
                type="button"
                className="btn quiet"
                data-ui="dismiss"
                data-event="settings.shortcuts.conflict.cancel"
                onClick={() => setNotice(null)}
              >
                Cancel
              </button>
            </ConfirmBlock>
          ) : rowNotice ? (
            <div
              className={rowNotice.kind === 'error' ? 'kb-error' : 'kb-done'}
              role={rowNotice.kind === 'error' ? 'alert' : 'status'}
            >
              {rowNotice.text}
            </div>
          ) : null}
        </div>
        <div className="lf-row-control">
          {keys.length > 0 && !listening ? (
            <button
              type="button"
              className="btn quiet kb-remove"
              data-ui="item"
              data-event="settings.shortcuts.row.remove"
              aria-label={`Remove the Shortcut for ${command.title}`}
              onClick={() => {
                setNotice(null);
                commands.rebind(command.id, []);
              }}
            >
              Remove
            </button>
          ) : null}
          {custom ? (
            <button
              type="button"
              className="btn quiet"
              data-ui="item"
              data-event="settings.shortcuts.row.reset"
              aria-label={`Reset the Shortcut for ${command.title}`}
              onClick={() => {
                setNotice(null);
                commands.reset(command.id);
              }}
            >
              Reset
            </button>
          ) : null}
          <span className="kb-row-keys" data-testid={`keys-${command.id}`}>
            <button
              type="button"
              className={keys.length > 0 || listening ? 'kb-key-btn' : 'btn quiet'}
              data-ui="item"
              data-event="settings.shortcuts.row.edit"
              ref={(element) => {
                if (element) editButtons.current.set(command.id, element);
                else editButtons.current.delete(command.id);
              }}
              aria-label={
                keys.length > 0
                  ? `Change the Shortcut for ${command.title}, ${keysText(keys)}`
                  : `Add Shortcut for ${command.title}`
              }
              aria-pressed={listening}
              onClick={() => {
                setNotice(null);
                setCapturing(listening ? null : command.id);
              }}
            >
              {listening ? (
                <span className="chip" role="status">
                  Press Keys… Esc Cancels
                </span>
              ) : keys.length > 0 ? (
                keys.map((combo) => <Kbd key={combo} combo={combo} />)
              ) : (
                'Add Shortcut'
              )}
            </button>
          </span>
        </div>
      </div>
    );
  };

  const counted: ReadonlyArray<readonly [Show, string]> = [
    ['all', 'All'],
    ['changed', `Changed · ${changed.length}`],
    ['none', 'None Set'],
  ];
  /**
   * Reset to Defaults… (Ryan's review, 15 Nov 2026): at the top of the page and at the end of the
   * list, the same button and the same question, off while nothing has changed.
   */
  const resetToDefaults = (where: 'top' | 'foot') => (
    <button
      type="button"
      className="btn"
      data-ui="item"
      data-event="settings.shortcuts.reset-all"
      data-testid={`shortcuts-reset-${where}`}
      disabled={changed.length === 0}
      onClick={() => setConfirmReset(true)}
    >
      <Icon name="undo" size={14} />
      Reset to Defaults…
    </button>
  );
  return (
    <section
      className="settings-section"
      aria-labelledby={`${id}-title`}
      data-testid="shortcuts-settings"
      data-bindings={bindings}
    >
      <SettingsHeader
        id={`${id}-title`}
        title="Keyboard Shortcuts"
        // Kept for the Macs, apart from the phones (PEN-156, A1605).
        beside={<ScopeMarker many kind="platform" />}
        actions={resetToDefaults('top')}
      />
      {clashes.length > 0 ? (
        <p className="kb-error" role="alert" data-testid="shortcut-clashes">
          {clashes
            .map(
              ({ combo, ids }) =>
                `${formatCombo(combo)} is bound to both “${title(ids[0])}” and “${title(ids[1])}”`,
            )
            .join('; ')}
          .
        </p>
      ) : null}
      <div className="kb-tools" data-setting="keyboard-shortcuts">
        <div className="kb-search">
          {keyFilter ? (
            <span className="kb-key-filter" data-testid="shortcut-key-filter">
              <Kbd combo={keyFilter} />
              <button
                type="button"
                className="icon-btn"
                data-ui="dismiss"
                data-event="settings.shortcuts.clear-keys"
                aria-label="Clear the Keys"
                data-tip="Clear the Keys"
                onClick={() => {
                  setKeyFilter(null);
                  search.current?.focus();
                }}
              >
                <Icon name="close" size={12} />
              </button>
            </span>
          ) : null}
          <input
            ref={search}
            className="input"
            type="search"
            placeholder={`Search ${commands.definitions.size} commands, or press keys`}
            aria-label="Search Shortcuts"
            aria-describedby={`${id}-found`}
            value={filter}
            onFocus={() => setSearchFocused(true)}
            onBlur={() => setSearchFocused(false)}
            onChange={(event) => setFilter(event.target.value)}
            onKeyDown={(event) => {
              // Escape clears the keys first, then the words (the field's own Escape).
              if (event.key === 'Escape' && keyFilter) {
                event.preventDefault();
                setKeyFilter(null);
              } else if (event.key === 'Backspace' && keyFilter && !filter) {
                setKeyFilter(null);
              }
            }}
          />
        </div>
        <div className="seg" role="radiogroup" aria-label="Show" data-testid="shortcut-filter">
          {counted.map(([value, label]) => (
            <label key={value} className="seg-option">
              <input
                type="radio"
                data-event="settings.shortcuts.show"
                name={`${id}-show`}
                value={value}
                checked={show === value}
                onChange={() => setShow(value)}
              />
              <span className="bold-steady" data-label={label}>
                {label}
              </span>
            </label>
          ))}
        </div>
      </div>
      <p className="kb-found" id={`${id}-found`} role="status">
        {rows.length === 0
          ? keyFilter
            ? `No command uses ${formatCombo(keyFilter)}.`
            : show === 'changed' && changed.length === 0
              ? 'You haven’t changed any shortcuts.'
              : 'No command matches.'
          : keyFilter
            ? `${rows.length === 1 ? 'One command uses' : `${rows.length} commands use`} ${formatCombo(keyFilter)}.`
            : null}
      </p>
      {groups.map((group) => (
        <div key={group.area} data-area={group.area}>
          <GroupHead id={`${id}-${settingId(group.label)}`}>{group.label}</GroupHead>
          <div
            className="lf-group"
            role="group"
            aria-labelledby={`${id}-${settingId(group.label)}`}
          >
            {group.rows.map(row)}
          </div>
        </div>
      ))}
      <div className="kb-foot">
        {resetToDefaults('foot')}
        {desktop() ? (
          <span className="muted">
            The capture shortcut from any app is on{' '}
            <a
              data-ui="item"
              data-event="settings.shortcuts.quick-capture-link"
              href={settingsPath('quick-capture')}
              onClick={linkHandler(settingsPath('quick-capture'))}
            >
              Quick Capture
            </a>
            .
          </span>
        ) : null}
      </div>
      {confirmReset ? (
        <ConfirmDialog
          title={`Reset ${changed.length === 1 ? 'One Shortcut' : `${changed.length} Shortcuts`}?`}
          testId="shortcuts-reset-all"
          onCancel={() => setConfirmReset(false)}
          onSubmit={() => {
            for (const command of changed) commands.reset(command.id);
            setNotice(null);
            setConfirmReset(false);
          }}
        >
          <p>
            {changed.length === 1
              ? 'The shortcut you changed goes'
              : 'The shortcuts you changed go'}{' '}
            back to the default, here and on your other devices.
          </p>
          <div className="confirm-actions">
            <button
              type="button"
              className="btn"
              data-ui="dismiss"
              data-event="settings.shortcuts.reset-all.cancel"
              onClick={() => setConfirmReset(false)}
              autoFocus
            >
              Cancel
            </button>
            <button
              type="submit"
              className="btn danger-fill"
              data-ui="submit"
              data-event="settings.shortcuts.reset-all.confirm"
            >
              Reset to Defaults
            </button>
          </div>
        </ConfirmDialog>
      ) : null}
    </section>
  );
}
