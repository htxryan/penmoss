import { Icon, type IconName } from '@penmoss/ui/icons';
import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from 'react';

const ITEMS = '[role="menuitem"]:not([disabled]), [role="menuitemcheckbox"]:not([disabled])';

/**
 * A menu button with a WAI-ARIA menu (T15, T36): arrows move between items,
 * Home and End jump, Escape and Tab close it and give focus back to the
 * button. Choosing an item closes it. On a phone it opens as a sheet from the
 * bottom of the screen (styles.css, `.menu[data-sheet]`), over a scrim.
 *
 * Items are the caller's own buttons, `role="menuitem"` (or
 * `menuitemcheckbox`), each running its command through the registry.
 */
export function Menu({
  label,
  icon,
  text,
  title,
  testId,
  className = 'icon-btn',
  iconSize = 16,
  sheet = false,
  children,
}: {
  /** The button's accessible name and the menu's. */
  readonly label: string;
  readonly icon: IconName;
  /** Visible text beside the icon (absent: an icon button). */
  readonly text?: string;
  /** Tooltip (data-tip, shell/Tooltip.tsx); the label by default. */
  readonly title?: string;
  readonly testId?: string;
  readonly className?: string;
  readonly iconSize?: number;
  /** Opens as a bottom sheet on a phone. */
  readonly sheet?: boolean;
  readonly children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const id = useId();

  useEffect(() => {
    if (!open) return;
    menuRef.current?.querySelector<HTMLElement>(ITEMS)?.focus();
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!menuRef.current?.contains(target) && !buttonRef.current?.contains(target)) {
        setOpen(false);
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  const close = () => {
    setOpen(false);
    buttonRef.current?.focus();
  };

  const onMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const items = [...(menuRef.current?.querySelectorAll<HTMLElement>(ITEMS) ?? [])];
    const at = items.indexOf(document.activeElement as HTMLElement);
    const move = (index: number) => {
      event.preventDefault();
      items[(index + items.length) % items.length]?.focus();
    };
    if (event.key === 'ArrowDown') move(at + 1);
    else if (event.key === 'ArrowUp') move(at - 1);
    else if (event.key === 'Home') move(0);
    else if (event.key === 'End') move(items.length - 1);
    else if (event.key === 'Escape' || event.key === 'Tab') {
      event.preventDefault();
      close();
    }
  };

  // An item ran (its own click handler first, inside the user's gesture): close the menu.
  const onMenuClick = (event: MouseEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest('[role^="menuitem"]')) close();
  };

  return (
    <div className="menu-anchor">
      <button
        ref={buttonRef}
        type="button"
        className={className}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-label={text ? undefined : label}
        data-tip={text ? title : (title ?? label)}
        data-ui="menu"
        data-testid={testId}
        onClick={() => setOpen((value) => !value)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown') {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        <Icon name={icon} size={iconSize} />
        {text ? (
          <>
            <span>{text}</span>
            <Icon name="chevD" size={12} className="xs" />
          </>
        ) : null}
      </button>
      {open ? (
        <>
          {sheet ? <div className="menu-scrim" aria-hidden="true" /> : null}
          <div
            ref={menuRef}
            id={id}
            className="menu"
            role="menu"
            aria-label={label}
            data-sheet={sheet ? '' : undefined}
            onKeyDown={onMenuKeyDown}
            onClick={onMenuClick}
          >
            {children}
          </div>
        </>
      ) : null}
    </div>
  );
}
