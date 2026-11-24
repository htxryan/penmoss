import { Icon } from '@penmoss/ui/icons';
import { useId, useLayoutEffect, useRef } from 'react';
import type { CommandDefinition } from './definitions';
import { useCommands, useCommandsVersion } from './hooks';
import { Kbd } from './Kbd';
import { useTrackedDialog } from '../analytics/dialog';
import { SPACES_CLASH, symbolKeysMayClash } from '../notes/symbols';
import { DialogClose } from '../shell/DialogClose';
import { ModalOverlay } from '../shell/ModalOverlay';

/** Typing shortcuts that are not commands (markdown and the slash menu), for reference. */
const TYPED: ReadonlyArray<readonly [string, string]> = [
  ['Slash menu', '/'],
  ['Heading 2', '## '],
  ['Bulleted list · checklist', '- · - [ ] '],
  ['Code block', '```'],
];

/** ⌘/ (T20): every command with a shortcut, grouped, with a way to customise them. */
export function Cheatsheet({
  onCustomise,
  onClose,
}: {
  onCustomise: () => void;
  onClose: () => void;
}) {
  const commands = useCommands();
  useCommandsVersion();
  const id = useId();
  const tracked = useTrackedDialog('cheatsheet');
  const close = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => close.current?.focus(), []);

  const groups = new Map<string, CommandDefinition[]>();
  for (const command of commands.definitions.values()) {
    if (commands.keysOf(command.id).length === 0) continue;
    const group = groups.get(command.area) ?? [];
    group.push(command);
    groups.set(command.area, group);
  }

  return (
    <ModalOverlay
      testId="cheatsheet"
      className="cheat-dlg"
      labelledBy={`${id}-title`}
      onClose={onClose}
      onEscape={onClose}
    >
      <div className="dlg-title">
        <h2 id={`${id}-title`}>Keyboard Shortcuts</h2>
        <div className="row">
          <button
            type="button"
            className="btn"
            data-command="app.shortcuts"
            onClick={() => {
              tracked.done();
              onCustomise();
            }}
          >
            <Icon name="keyboard" />
            Customise
          </button>
          <DialogClose ref={close} label="Close" event="cheatsheet.close" onClose={onClose} />
        </div>
      </div>
      {/* It scrolls on a short window: focusable, so the keyboard can scroll it too. */}
      <div className="cheat" role="region" aria-labelledby={`${id}-title`} tabIndex={0}>
        {[...groups].map(([area, list]) => (
          <section key={area}>
            <h3>{area}</h3>
            {area === 'Symbols' && symbolKeysMayClash((id) => commands.keysOf(id)) ? (
              <p className="cheat-note">{SPACES_CLASH}</p>
            ) : null}
            {list.map((command) => (
              <div className="cr" key={command.id}>
                <span>
                  {command.title}
                  {command.pending ? <span className="muted"> (soon)</span> : null}
                </span>
                <Kbd combo={commands.keysOf(command.id)[0]} />
              </div>
            ))}
          </section>
        ))}
        <section>
          <h3>Typing</h3>
          {TYPED.map(([title, keys]) => (
            <div className="cr" key={title}>
              <span>{title}</span>
              <code>{keys}</code>
            </div>
          ))}
        </section>
      </div>
    </ModalOverlay>
  );
}
