import { Icon } from '@penmoss/ui/icons';
import { useMemo, useState } from 'react';
import { DialogClose } from '../shell/DialogClose';
import { PickerField, PickerListbox, PickerOverlay } from '../shell/picker';
import { usePickerList } from '../shell/picker-list';
import { deviceTimeZone, timeZones, utcOffset, zoneName } from './time-zones';

/** What a query matches a zone by: its name, with spaces for underscores, and its offset. */
const fold = (text: string) =>
  text
    .toLowerCase()
    .replace(/[_\s]+/g, ' ')
    .replace(/−/g, '-');

interface ZoneChoice {
  readonly zone: string;
  readonly offset: string;
  /** "Use This Mac’s Zone": the device's own, first in the list. */
  readonly device?: boolean;
}

/**
 * Settings → Daily Notes → Time Zone's picker (PEN-146): about 420 zones found by typing part of
 * a name or an offset ("chicago", "utc+5:30"), with this device's own zone first, as Android's
 * picker has. The pickers' list and keys (`picker-list.ts`): ↑ ↓, Return chooses, Escape closes.
 */
export function TimeZonePicker({
  current,
  deviceLabel,
  onChoose,
  onClose,
}: {
  readonly current: string;
  /** "This Mac’s" in the Mac app, else "This Device’s". */
  readonly deviceLabel: string;
  readonly onChoose: (zone: string) => void;
  readonly onClose: () => void;
}) {
  const [query, setQuery] = useState('');
  const all = useMemo<ZoneChoice[]>(() => {
    const now = new Date();
    return timeZones().map((zone) => ({ zone, offset: utcOffset(zone, now) }));
  }, []);
  const device = useMemo(() => deviceTimeZone(), []);
  const items = useMemo<ZoneChoice[]>(() => {
    const q = fold(query.trim());
    if (!q) {
      // A device on UTC (or another alias) is not in the browser's list of zones: offer it anyway.
      const own = device
        ? (all.find((each) => each.zone === device) ?? {
            zone: device,
            offset: utcOffset(device, new Date()),
          })
        : undefined;
      return own ? [{ ...own, device: true }, ...all] : all;
    }
    const found = all.filter((each) => fold(each.zone).includes(q) || fold(each.offset) === q);
    // The zone named exactly first, then a city that starts with the query, then the rest.
    const rank = (each: ZoneChoice) => {
      const name = fold(each.zone);
      if (name === q) return 0;
      const city = name.slice(name.lastIndexOf('/') + 1);
      return city.startsWith(q) ? 1 : 2;
    };
    return found.sort((a, b) => rank(a) - rank(b));
  }, [all, device, query]);
  const [active, setActive] = useState(() =>
    Math.max(
      0,
      items.findIndex((each) => each.zone === current && !each.device),
    ),
  );
  const choose = (choice: ZoneChoice | undefined) => {
    if (choice) onChoose(choice.zone);
  };
  const picker = usePickerList({
    items,
    active,
    setActive,
    onChoose: (index) => choose(items[index]),
    onClose,
  });
  return (
    <PickerOverlay
      testId="time-zone-picker"
      className="palette zone-picker"
      label="Choose a Time Zone"
      onClose={onClose}
    >
      <div className="dlg-search">
        <PickerField
          picker={picker}
          aria-label="Time Zone"
          placeholder="Search time zones, such as Chicago or UTC+1"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
          }}
        />
        <DialogClose label="Close the Time Zone Picker" onClose={onClose} />
      </div>
      <PickerListbox picker={picker} label="Time Zones">
        {items.length === 0 ? (
          <p className="dlg-empty" role="status">
            No time zone matches “{query}”
          </p>
        ) : (
          items.map((choice, index) => (
            <div
              key={choice.device ? `device:${choice.zone}` : choice.zone}
              {...picker.optionProps(index)}
              className="opt"
              data-zone={choice.zone}
              aria-current={choice.zone === current && !choice.device ? 'true' : undefined}
              onClick={() => choose(choice)}
            >
              <span className="oic" aria-hidden="true">
                <Icon name={choice.device ? 'laptop' : 'globe'} size={14} />
              </span>
              <span className="ot">
                {choice.device
                  ? `Use ${deviceLabel} Zone: ${zoneName(choice.zone)}`
                  : zoneName(choice.zone)}
              </span>
              <span className="os">
                <span className="zone-offset">{choice.offset}</span>
                {choice.zone === current && !choice.device ? (
                  <>
                    <span className="sr-only">Chosen</span>
                    <Icon name="check" size={14} />
                  </>
                ) : null}
              </span>
            </div>
          ))
        )}
      </PickerListbox>
      <div className="dlg-foot" aria-hidden="true">
        <span className="keys">
          <kbd>↑</kbd>
          <kbd>↓</kbd>
        </span>
        Choose
        <span className="keys">
          <kbd>↵</kbd>
        </span>
        Use This Zone
        <span className="grow" />
        <span className="keys">
          <kbd>Esc</kbd>
        </span>
        Cancel
      </div>
    </PickerOverlay>
  );
}
