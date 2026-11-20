import { useRef, useState } from 'react';
import { cellLabel } from '../shell/icon-grid';
import { IconPickerDialog } from '../shell/IconPickerDialog';
import { LUCIDE_PREFIX, LucideSvg, useLucideIcon } from '../shell/lucide';
import { badgeIconInLucide } from './badge';

/**
 * A badge's Icon row (A1568): the icon it shows, its name, and Choose Icon…, which opens the icon
 * picker on Lucide's icons with this one marked. An icon from before Lucide shows as its Lucide
 * twin, by the twin's name, and the picker marks the twin.
 */
export function BadgeIconChooser({
  value,
  labelledBy,
  onChoose,
}: {
  /** The badge's icon: `lucide:<name>`, or one from before Lucide (BADGE_ICONS). */
  readonly value: string;
  readonly labelledBy: string;
  readonly onChoose: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const lucide = badgeIconInLucide(value);
  const node = useLucideIcon(lucide);
  const name = cellLabel(lucide ?? value);
  return (
    <span className="badge-icon-chooser" role="group" aria-labelledby={labelledBy}>
      <span className="badge-icon-current" data-testid="badge-icon-current" data-value={value}>
        <span className="badge-icon-cell" aria-hidden="true">
          {node && lucide ? <LucideSvg node={node} name={lucide} size={18} /> : null}
        </span>
        <span className="badge-icon-name">{name}</span>
      </span>
      <button
        data-event="settings.git-notebooks.badge.choose-icon"
        ref={button}
        type="button"
        className="btn"
        data-ui="menu"
        aria-haspopup="dialog"
        aria-expanded={open}
        data-testid="badge-icon-choose"
        onClick={() => setOpen(true)}
      >
        Choose Icon…
      </button>
      {open ? (
        <IconPickerDialog
          title="Choose an Icon"
          tabs={['icons']}
          value={lucide === null ? null : `${LUCIDE_PREFIX}${lucide}`}
          testId="icon-picker"
          onPick={(picked) => onChoose(picked)}
          onClose={() => {
            setOpen(false);
            button.current?.focus();
          }}
        />
      ) : null}
    </span>
  );
}
