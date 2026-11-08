import { ariaKeyShortcuts } from '@penmoss/editor/keys';
import { Icon, type IconName } from '@penmoss/ui/icons';
import { useCommands, useKeys } from '../commands/hooks';
import { Kbd } from '../commands/Kbd';
import { Menu } from '../shell/Menu';

/** One item: the command it runs, and its checked state for a toggle. */
function Item({
  command,
  icon,
  label,
  testId,
  checked,
  danger = false,
}: {
  readonly command: string;
  readonly icon: IconName;
  readonly label: string;
  readonly testId?: string | undefined;
  /** A toggle's state (a `menuitemcheckbox`); absent for a plain item. */
  readonly checked?: boolean;
  readonly danger?: boolean;
}) {
  const commands = useCommands();
  const keys = useKeys(command);
  return (
    <button
      type="button"
      role={checked === undefined ? 'menuitem' : 'menuitemcheckbox'}
      aria-checked={checked}
      aria-keyshortcuts={ariaKeyShortcuts(keys) || undefined}
      tabIndex={-1}
      className={danger ? 'menu-item danger' : 'menu-item'}
      data-command={command}
      data-testid={testId}
      // In the click: copying needs the user's gesture.
      onClick={() => commands.run(command)}
    >
      <Icon name={icon} />
      <span className="menu-label">{label}</span>
      {/* Named by aria-keyshortcuts: the keycaps stay out of the item's name. */}
      <span className="menu-keys" aria-hidden="true">
        <Kbd combo={keys[0]} />
      </span>
    </button>
  );
}

/** What the note's side panel shows (T51, A936), or null while it is closed. */
export type NotePanelTab = 'info' | 'comments' | 'history' | 'graph';

/**
 * Every action on the open note, in one menu. On a phone it is the app bar's
 * ⋮, opening as a sheet from the bottom (T36). On wider screens it is the ⋯
 * at the end of the note's top bar (T42, A575). Three groups (T51, A937): what
 * the note shows (on a phone its side panel's four tabs; the Markdown source),
 * copying it, then what happens to it (Quick Access, a window of its own,
 * another folder, Trash). Add a Tag (the Metadata tab has it) and Send Feedback (the
 * sidebar has it) left the menu; their commands stay in the palette. Each item
 * runs the same command as the palette and its shortcut, shown beside it.
 */
export function NoteActions({
  source,
  tab,
  pinned = false,
  fullWidth,
  variant = 'sheet',
}: {
  readonly source: boolean;
  /** The side panel's tab while it shows (T51, A936), or null. */
  readonly tab: NotePanelTab | null;
  /** Whether the note is pinned to Quick Access (T51, A946). */
  readonly pinned?: boolean;
  /** Whether notes show full width; the bar's ⋯ has Full Width, as the bar may (A1134). */
  readonly fullWidth?: boolean;
  /** `sheet`: the phone's app bar; `bar`: the note's top bar. */
  readonly variant?: 'sheet' | 'bar';
}) {
  const bar = variant === 'bar';
  return (
    <Menu
      label="Note Actions"
      icon={bar ? 'more' : 'moreV'}
      iconSize={bar ? 18 : 16}
      testId={bar ? 'note-menu' : 'note-actions'}
      sheet={!bar}
    >
      {/* The panel's tabs and Add Note Comment: on a phone only. Wider, the tab strip down the
          note's right edge and the Comments tab always show them (A991). */}
      {bar ? null : (
        <>
          <Item
            command="note.backlinks"
            icon="info"
            label="View Metadata"
            checked={tab === 'info'}
          />
          {/* T48: the note's comment threads, a tab of the side panel (T51). */}
          <Item
            command="note.comments"
            icon="comment"
            label="Comments"
            checked={tab === 'comments'}
          />
          {/* T52 item 5: a thread on the note as a whole, in the Comments tab. */}
          <Item command="note.addNoteComment" icon="plus" label="Add Note Comment" />
          <Item
            command="note.history"
            icon="history"
            label="Version History"
            checked={tab === 'history'}
          />
          <Item
            command="note.localGraph"
            icon="graph"
            label="Local Graph"
            checked={tab === 'graph'}
          />
        </>
      )}
      {bar ? (
        <Item
          command="note.fullWidth"
          icon="widthFull"
          label="Full Width"
          checked={fullWidth ?? false}
          testId="full-width-menu"
        />
      ) : null}
      <Item
        command="note.toggleSource"
        icon="md"
        label="Markdown Source"
        checked={source}
        testId={bar ? 'toggle-markdown' : undefined}
      />
      <div className="menu-sep" role="separator" />
      <Item command="note.copyMarkdown" icon="md" label="Copy Note as Markdown" />
      <Item command="note.copyRich" icon="copy" label="Copy Note as Rich Text" />
      {/* T52 item 4: what an agent needs to find the note through the Penmoss MCP server. */}
      <Item
        command="note.copyAgentReference"
        icon="agentRef"
        label="Copy Agent Reference"
        testId={bar ? 'copy-agent-reference-menu' : undefined}
      />
      <div className="menu-sep" role="separator" />
      <Item
        command="note.pinQuickAccess"
        icon="pin"
        label={pinned ? 'Unpin from Quick Access' : 'Pin to Quick Access'}
        testId={bar ? 'pin-quick-access' : undefined}
      />
      <Item
        command="note.openInNewWindow"
        icon="windowNew"
        label="Open in New Window"
        testId={bar ? 'open-in-window' : undefined}
      />
      <Item command="note.move" icon="folder" label="Move to Folder…" />
      <Item
        command="note.delete"
        icon="trash"
        label="Move to Trash"
        danger
        testId={bar ? 'delete-note' : undefined}
      />
    </Menu>
  );
}
