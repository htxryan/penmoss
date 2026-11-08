import {
  BROWSER_RESERVED,
  bindingProblem,
  comboFromEvent,
  formatCombo,
  isApplePlatform,
  normaliseCombo,
} from '@penmoss/editor/keys';
import { Icon } from '@penmoss/ui/icons';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { CaptureHotkeySetting } from '../desktop/CaptureHotkeySetting';
import type { CommandDefinition } from './definitions';
import { useWorkspace } from '../workspace/hooks';
import { useCommands, useCommandsVersion } from './hooks';
import { Kbd } from './Kbd';

type Notice =
  | {
      readonly kind: 'conflict';
      readonly id: string;
      readonly combo: string;
      readonly others: string[];
    }
  | { readonly kind: 'error'; readonly id: string; readonly text: string }
  | { readonly kind: 'done'; readonly id: string; readonly text: string };

/**
 * Settings → Keyboard Shortcuts (T20): every command, its keys, and an editor
 * that records a new combination. A combination another command uses (in an
 * overlapping scope) is a conflict: the editor says which command has it and
 * offers to move it. Changes are the user's synced settings, so they apply at
 * once here and on their other devices.
 */
export function ShortcutsSettings() {
  const commands = useCommands();
  useCommandsVersion();
  // Until the user's bindings are read the rows show the defaults (A627); they come from this
  // device's copy of the notebook (D49). Tests wait on it before reading or resetting a row.
  const workspace = useWorkspace();
  const bindingsState = () => (workspace.getState().loaded ? 'local' : 'loading');
  // Only this flag: not every folder or registry change re-renders the table.
  const bindings = useSyncExternalStore(workspace.subscribe, bindingsState, bindingsState);
  const [filter, setFilter] = useState('');
  const [capturing, setCapturing] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const editButtons = useRef(new Map<string, HTMLButtonElement>());

  const title = (id: string) => commands.definitions.get(id)?.title ?? id;

  const assign = (id: string, combo: string, replace: boolean) => {
    try {
      if (replace) {
        for (const other of commands.conflicts(id, combo)) {
          commands.rebind(
            other.id,
            commands.keysOf(other.id).filter((key) => normaliseCombo(key) !== combo),
          );
        }
      }
      commands.rebind(id, [combo]);
      setNotice({ kind: 'done', id, text: `${title(id)} is now ${formatCombo(combo)}.` });
    } catch (error) {
      setNotice({
        kind: 'error',
        id,
        text: error instanceof Error ? error.message : 'Could not save the shortcut',
      });
    }
  };

  // Records the next combination while a row is listening (the dispatcher stands aside).
  useEffect(() => {
    if (!capturing) return;
    const resume = commands.suspend();
    const onKeyDown = (event: KeyboardEvent) => {
      const combo = comboFromEvent(event);
      if (!combo) return; // A lone modifier: keep listening.
      event.preventDefault();
      event.stopPropagation();
      const id = capturing;
      setCapturing(null);
      editButtons.current.get(id)?.focus();
      if (combo === 'Escape') return;
      // A command's own default is always fine (Undo keeps ⌘Z); otherwise the rules of A90.
      const problem = commands.definitions.get(id)?.keys.includes(combo)
        ? null
        : bindingProblem(combo);
      if (problem) {
        const shown = formatCombo(combo);
        const text = {
          types: `${shown} would type a character: add ${isApplePlatform() ? '⌘ or ⌃' : 'Ctrl or Alt'}.`,
          altgr: `${shown} is AltGr on many keyboards, which types a character: use Ctrl+Shift or Alt without Ctrl.`,
          reserved: `${shown} is kept for copying, pasting, finding and editing text.`,
        }[problem];
        setNotice({ kind: 'error', id, text });
        return;
      }
      if (BROWSER_RESERVED.has(combo)) {
        setNotice({ kind: 'error', id, text: `${formatCombo(combo)} is kept by the browser.` });
        return;
      }
      const others = commands.conflicts(id, combo).map((other) => other.id);
      if (others.length > 0) {
        setNotice({ kind: 'conflict', id, combo, others });
        return;
      }
      assign(id, combo, false);
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      resume();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- assign reads the latest bindings when called.
  }, [capturing, commands]);

  const query = filter.trim().toLowerCase();
  const rows = [...commands.definitions.values()].filter(
    (command) =>
      !query ||
      command.title.toLowerCase().includes(query) ||
      command.area.toLowerCase().includes(query) ||
      commands.keysOf(command.id).some((combo) => formatCombo(combo).toLowerCase().includes(query)),
  );
  const clashes = commands.allConflicts();

  const row = (command: CommandDefinition) => {
    const keys = commands.keysOf(command.id);
    const listening = capturing === command.id;
    const rowNotice = notice?.id === command.id ? notice : null;
    return (
      <tr key={command.id} data-command-row={command.id} className={listening ? 'capturing' : ''}>
        <th scope="row">
          {command.title}
          {command.pending ? (
            <span className="muted"> · arrives with {command.pending}</span>
          ) : null}
          {rowNotice?.kind === 'conflict' ? (
            <div className="kb-conflict" role="alert" data-testid="shortcut-conflict">
              <Kbd combo={rowNotice.combo} /> is used by{' '}
              {rowNotice.others.map((id) => `“${title(id)}”`).join(' and ')}.
              <button
                type="button"
                className="btn"
                data-ui="submit"
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
                onClick={() => setNotice(null)}
              >
                Cancel
              </button>
            </div>
          ) : rowNotice ? (
            <div
              className={rowNotice.kind === 'error' ? 'kb-error' : 'kb-done'}
              role={rowNotice.kind === 'error' ? 'alert' : 'status'}
            >
              {rowNotice.text}
            </div>
          ) : null}
        </th>
        <td className="area">{command.area}</td>
        <td className="kb-keys" data-testid={`keys-${command.id}`}>
          {listening ? (
            <span className="chip" role="status">
              Press keys… Esc cancels
            </span>
          ) : keys.length > 0 ? (
            keys.map((combo) => <Kbd key={combo} combo={combo} />)
          ) : (
            <span className="muted">—</span>
          )}
        </td>
        <td className="act">
          <div className="kb-actions">
            <button
              type="button"
              className="icon-btn"
              data-ui="item"
              ref={(element) => {
                if (element) editButtons.current.set(command.id, element);
                else editButtons.current.delete(command.id);
              }}
              aria-label={`Change the Shortcut for ${command.title}`}
              aria-pressed={listening}
              data-tip={listening ? 'Listening: press the new keys' : 'Change'}
              onClick={() => {
                setNotice(null);
                setCapturing(listening ? null : command.id);
              }}
            >
              <Icon name={listening ? 'keyboard' : 'pencil'} />
            </button>
            {keys.length > 0 ? (
              <button
                type="button"
                className="icon-btn danger"
                data-ui="item"
                aria-label={`Remove the Shortcut for ${command.title}`}
                data-tip="Remove"
                onClick={() => {
                  setNotice(null);
                  commands.rebind(command.id, []);
                }}
              >
                <Icon name="close" />
              </button>
            ) : null}
            {commands.isCustom(command.id) ? (
              <button
                type="button"
                className="icon-btn"
                data-ui="item"
                aria-label={`Reset the Shortcut for ${command.title}`}
                data-tip="Reset to the Default"
                onClick={() => {
                  setNotice(null);
                  commands.reset(command.id);
                }}
              >
                <Icon name="undo" />
              </button>
            ) : null}
          </div>
        </td>
      </tr>
    );
  };

  return (
    <section
      className="settings-section"
      aria-labelledby="shortcuts-title"
      data-testid="shortcuts-settings"
      data-bindings={bindings}
    >
      <h2 id="shortcuts-title">Keyboard Shortcuts</h2>
      <p className="muted">
        Changes sync to your other devices. Shortcuts need ⌘, Ctrl or Alt so typing never runs a
        command.
      </p>
      <CaptureHotkeySetting />
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
      <input
        className="input"
        type="search"
        placeholder={`Search ${commands.definitions.size} commands`}
        aria-label="Search shortcuts"
        value={filter}
        onChange={(event) => setFilter(event.target.value)}
      />
      <table className="kb-table">
        <thead>
          <tr>
            <th scope="col">Command</th>
            <th scope="col">Area</th>
            <th scope="col">Shortcut</th>
            <th scope="col">
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>{rows.map(row)}</tbody>
      </table>
    </section>
  );
}
