/**
 * Settings and Preview, the two tabs of Settings → Appearance, Sidebar and Note (A1633, as
 * Android's Appearance has them, A1619). Settings opens first and holds only the controls;
 * Preview holds the page's preview, as large as the page leaves room for: the tab is the larger
 * view, so these pages have no Enlarge button. The tabs span the page under its header and hold
 * still while the page scrolls under them; the one shown has the page's background and the
 * accent under it, the other is darker. ← and → (and Home and End) move between them.
 *
 * Both panels stay mounted, the one not shown `hidden`, so a preview keeps its state (the note it
 * shows, its scale) and the page's settings stay findable by Search Settings.
 */
import { Icon, type IconName } from '@penmoss/ui/icons';
import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';

type Tab = 'settings' | 'preview';

const TABS: ReadonlyArray<{ readonly tab: Tab; readonly label: string; readonly icon: IconName }> =
  [
    { tab: 'settings', label: 'Settings', icon: 'settings' },
    { tab: 'preview', label: 'Preview', icon: 'eye' },
  ];

export function PreviewTabs({
  name,
  testId,
  settings,
  preview,
}: {
  /** The page's name, in Title Case: the tab list's label ("Appearance"). */
  readonly name: string;
  /** The tab list's test id; each tab's is `${testId}-settings` and `${testId}-preview`. */
  readonly testId: string;
  readonly settings: ReactNode;
  readonly preview: ReactNode;
}) {
  const id = useId();
  const [shown, setShown] = useState<Tab>('settings');
  const buttons = useRef(new Map<Tab, HTMLButtonElement>());

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const at = TABS.findIndex((each) => each.tab === shown);
    const last = TABS.length - 1;
    const moves: Readonly<Record<string, number>> = {
      ArrowRight: at === last ? 0 : at + 1,
      ArrowLeft: at === 0 ? last : at - 1,
      Home: 0,
      End: last,
    };
    const to = moves[event.key];
    if (to === undefined) return;
    event.preventDefault();
    const next = TABS[to]!.tab;
    setShown(next);
    buttons.current.get(next)?.focus();
  };

  return (
    <>
      <div
        className="lf-tabs"
        role="tablist"
        aria-label={name}
        data-testid={testId}
        onKeyDown={onKeyDown}
      >
        {TABS.map(({ tab, label, icon }) => (
          <button
            key={tab}
            ref={(element) => {
              if (element) buttons.current.set(tab, element);
              else buttons.current.delete(tab);
            }}
            type="button"
            role="tab"
            className="lf-tab"
            data-ui="option"
            id={`${id}-${tab}-tab`}
            aria-selected={shown === tab}
            aria-controls={`${id}-${tab}`}
            tabIndex={shown === tab ? 0 : -1}
            data-testid={`${testId}-${tab}`}
            onClick={() => setShown(tab)}
          >
            <Icon name={icon} size={16} />
            {label}
          </button>
        ))}
      </div>
      <div
        className="lf-tabpanel"
        role="tabpanel"
        id={`${id}-settings`}
        aria-labelledby={`${id}-settings-tab`}
        hidden={shown !== 'settings'}
        data-testid={`${testId}-settings-panel`}
      >
        <div className="lf-controls">{settings}</div>
      </div>
      <div
        className="lf-tabpanel lf-preview-panel"
        role="tabpanel"
        id={`${id}-preview`}
        aria-labelledby={`${id}-preview-tab`}
        hidden={shown !== 'preview'}
        data-testid={`${testId}-preview-panel`}
      >
        {preview}
      </div>
    </>
  );
}
