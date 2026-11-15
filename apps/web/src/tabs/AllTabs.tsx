import { isApplePlatform } from '@penmoss/editor/keys';
import { Icon } from '@penmoss/ui/icons';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { PickerField, PickerListbox } from '../shell/picker';
import { usePickerList } from '../shell/picker-list';
import { facePath, type TabFace } from './describe';
import { useTabs } from './hooks';
import { TabMark } from './TabStrip';

/**
 * All Tabs (AC12): every open tab in a list that filters as you type, each with its ⌘ number;
 * ↑ and ↓ move, ↩ switches, Escape closes, as in every picker (`usePickerList`). Shown from the
 * strip's All Tabs button once the tabs no longer fit.
 */
export function AllTabs({
  faces,
  anchor,
  onClose,
}: {
  readonly faces: readonly TabFace[];
  readonly anchor: RefObject<HTMLElement | null>;
  readonly onClose: () => void;
}) {
  const tabs = useTabs();
  const [query, setQuery] = useState('');
  const [at, setAt] = useState(0);
  const panel = useRef<HTMLDivElement>(null);
  const apple = isApplePlatform();
  useLayoutEffect(() => {
    // Under its button, its right edge on the button's.
    const rect = anchor.current?.getBoundingClientRect();
    const element = panel.current;
    if (rect && element) {
      element.style.top = `${rect.bottom + 4}px`;
      element.style.right = `${Math.max(8, window.innerWidth - rect.right)}px`;
      element.style.visibility = 'visible';
    }
  }, [anchor]);
  const latestClose = useRef(onClose);
  useLayoutEffect(() => {
    latestClose.current = onClose;
  });
  useEffect(() => {
    const onDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (anchor.current?.contains(target) || panel.current?.contains(target)) return;
      latestClose.current();
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
  }, [anchor]);

  const shown = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return faces;
    return faces.filter((face) =>
      `${face.title} ${facePath(face)}`.toLocaleLowerCase().includes(needle),
    );
  }, [faces, query]);
  const choose = (face: TabFace | undefined) => {
    if (!face) return;
    tabs?.activate(face.id);
    onClose();
  };
  const picker = usePickerList({
    items: shown,
    active: at,
    setActive: setAt,
    onChoose: (index) => choose(shown[index]),
    onClose,
    optionName: 'tab',
  });

  return (
    <div
      ref={panel}
      className="all-tabs menu"
      role="dialog"
      aria-label="All Tabs"
      data-testid="all-tabs"
      style={{ visibility: 'hidden' }}
    >
      <PickerField
        picker={picker}
        className="all-tabs-filter"
        placeholder="Filter Tabs"
        aria-label="Filter Tabs"
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setAt(0);
        }}
        data-testid="all-tabs-filter"
      />
      <PickerListbox picker={picker} className="all-tabs-list" label="Open Tabs">
        {shown.map((face, index) => (
          <div
            key={face.id}
            {...picker.optionProps(index)}
            data-active={face.active ? '' : undefined}
            data-pinned={face.pinned ? '' : undefined}
            // A rule under the pinned group, as the strip keeps them apart (ac12).
            data-group-end={
              face.pinned && shown[index + 1] !== undefined && !shown[index + 1]!.pinned
                ? ''
                : undefined
            }
            className="all-tabs-item"
            data-testid="all-tabs-item"
            onClick={() => choose(face)}
          >
            <span className="all-tabs-pin" aria-hidden="true">
              {face.pinned ? (
                <span data-testid="all-tabs-pinned">
                  <Icon name="pin" size={12} />
                </span>
              ) : null}
            </span>
            <span className="tab-mark" aria-hidden="true">
              <TabMark face={face} />
            </span>
            <span className="all-tabs-title">
              <bdi>{face.title}</bdi>
              {facePath(face) ? <span className="all-tabs-path">{facePath(face)}</span> : null}
              {face.pinned ? <span className="sr-only">Pinned</span> : null}
            </span>
            {face.number !== null ? (
              <kbd className="all-tabs-key">{`${apple ? '⌘' : 'Ctrl+'}${face.number}`}</kbd>
            ) : null}
          </div>
        ))}
        {shown.length === 0 ? (
          <div className="all-tabs-none" role="option" aria-selected={false} aria-disabled="true">
            No Tabs Match
          </div>
        ) : null}
      </PickerListbox>
    </div>
  );
}
