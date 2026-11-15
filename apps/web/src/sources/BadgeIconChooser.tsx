import { Icon } from '@penmoss/ui/icons';
import { useRef, useState } from 'react';
import { cellLabel } from '../shell/icon-grid';
import { IconPickerDialog } from '../shell/IconPickerDialog';
import { LUCIDE_PREFIX, LucideSvg, lucideName, useLucideIcon } from '../shell/lucide';
import { appBadgeIcon, badgeIconInLucide } from './badge';

/**
 * A badge's Icon row (A1568): the icon it shows, its name, and Choose Icon…, which opens the icon
 * picker on Lucide's icons with this one marked. An icon from the app's own set (a badge from
 * before Lucide) shows as it is, and the picker marks its Lucide twin.
 */
export function BadgeIconChooser({
  value,
  labelledBy,
  onChoose,
}: {
  /** The badge's icon: `lucide:<name>`, or one of the app's (BADGE_ICONS). */
  readonly value: string;
  readonly labelledBy: string;
  readonly onChoose: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const app = appBadgeIcon(value);
  const lucide = lucideName(value);
  const node = useLucideIcon(lucide);
  const inLucide = badgeIconInLucide(value);
  const name = cellLabel(app ?? lucide ?? value);
  return (
    <span className="badge-icon-chooser" role="group" aria-labelledby={labelledBy}>
      <span className="badge-icon-current" data-testid="badge-icon-current" data-value={value}>
        <span className="badge-icon-cell" aria-hidden="true">
          {app ? (
            <Icon name={app} size={18} />
          ) : node && lucide ? (
            <LucideSvg node={node} name={lucide} size={18} />
          ) : null}
        </span>
        <span className="badge-icon-name">{name}</span>
      </span>
      <button
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
          value={inLucide === null ? null : `${LUCIDE_PREFIX}${inLucide}`}
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
