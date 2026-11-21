/**
 * Settings → Privacy → Analytics Data (PEN-137, ac36): the record on this Mac, the app's, the
 * CLI's and the MCP server's, whatever the answer. Its own page under Privacy in the nav, with
 * the summary under its title (how long it is kept, the ID, since when it is shared), the counts
 * by state under that, and Copy as JSON beside it: the exact body of the last batch sent, or the events on the page. Filters by
 * state and client; a table of 100 events at a time, newest first, with Earlier and Later, each
 * event's state a tinted chip (waiting amber, sent green, the rest neutral).
 */
import {
  countsLine,
  propsLine,
  STATE_LABELS,
  type ClientFilter,
  type Cursor,
  type Page,
  type StateName,
  type StoredEvent,
} from '@penmoss/core/analytics';
import { Icon } from '@penmoss/ui/icons';
import { useEffect, useId, useState } from 'react';
import { desktop, type DesktopAnalyticsStatus } from '../desktop/bridge';
import { SettingsHeader } from '../pages/SettingsHeader';
import { analyticsBridge, copy, shortId, useAnalyticsStatus } from './status';
import './privacy.css';

const PAGE_SIZE = 100;

/** The states a person filters by: what happened to an event once answered. */
const STATE_FILTERS: ReadonlyArray<StateName | 'all'> = [
  'all',
  'waiting',
  'sent',
  'local',
  'refused',
];

const CLIENT_FILTERS: ReadonlyArray<{ value: ClientFilter; label: string }> = [
  { value: 'all', label: copy('viewer.filter.all.label') },
  { value: 'app', label: copy('viewer.filter.app.label') },
  { value: 'cli', label: copy('viewer.filter.cli.label') },
  { value: 'mcp', label: copy('viewer.filter.mcp.label') },
];

const stateLabel = (state: StateName | 'all') =>
  state === 'all' ? copy('viewer.filter.all.label') : STATE_LABELS[state];

/** Which client recorded an event, as the filter names it. */
function clientLabel(event: StoredEvent): string {
  if (event.client === 'cli') return copy('viewer.filter.cli.label');
  if (event.client === 'mcp') return copy('viewer.filter.mcp.label');
  return copy('viewer.filter.app.label');
}

/** When, to the second, in this Mac's time. */
function timeOf(at: number): string {
  return new Date(at).toLocaleString('en-GB', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

/**
 * An event's props as one line, `source: key, keys: Mod+K`, a list over 12 items cut to its first
 * 12 and `… +N` (core's propsLine, PEN-177); Copy as JSON keeps every item.
 */
function propsOf(event: StoredEvent): string {
  return propsLine(event.props);
}

/** The summary under the title: where, how long, the ID, and whether it is shared. */
function summary(status: DesktopAnalyticsStatus): string {
  const sharing =
    status.consent === 'yes'
      ? copy('viewer.sharing.on', {
          date: new Date(status.sharingSince ?? Date.now()).toLocaleDateString('en-GB', {
            day: 'numeric',
            month: 'long',
            year: 'numeric',
          }),
        })
      : status.consent === 'no'
        ? copy('viewer.sharing.off')
        : copy('viewer.sharing.unanswered');
  return copy('viewer.summary', {
    days: status.limits['events.days'],
    id: shortId(status.install),
    sharing,
  });
}

export function AnalyticsData() {
  const analytics = analyticsBridge();
  const status = useAnalyticsStatus();
  const id = useId();
  const [state, setState] = useState<StateName | 'all'>('all');
  const [client, setClient] = useState<ClientFilter>('all');
  /** Where the page is: the newest, or before or after an event. */
  const [at, setAt] = useState<{ before?: Cursor; after?: Cursor }>({});
  const [page, setPage] = useState<Page | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!analytics) return;
    let live = true;
    void analytics
      .page({ state, client, limit: PAGE_SIZE, ...at })
      .then((next) => {
        if (live) setPage(next);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [analytics, state, client, at]);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);
  if (!analytics) return null;

  const copyJson = async () => {
    const text = status?.lastBatch ?? JSON.stringify(page?.events ?? [], null, 2);
    const clipboard = desktop()?.clipboard;
    const done = clipboard
      ? await clipboard.write({ text }).catch(() => false)
      : await navigator.clipboard.writeText(text).then(
          () => true,
          () => false,
        );
    if (done) setCopied(true);
  };
  const events = page?.events ?? [];
  const from = page && events.length > 0 ? page.newer + 1 : 0;
  const to = page ? page.newer + events.length : 0;
  const first = events[0];
  const last = events.at(-1);
  return (
    <section
      className="settings-section privacy-data"
      aria-labelledby={`${id}-h`}
      data-testid="analytics-data"
    >
      <SettingsHeader
        id={`${id}-h`}
        title={copy('viewer.title')}
        intro={status ? summary(status) : undefined}
        actions={
          <button
            type="button"
            className="btn"
            data-ui="item"
            data-event="privacy.data.copy-json"
            data-testid="analytics-data-copy"
            disabled={!status}
            onClick={() => void copyJson()}
          >
            <Icon name={copied ? 'check' : 'copy'} size={14} />
            {copy('viewer.copyJson.button')}
          </button>
        }
      />
      {status ? (
        <p className="privacy-data-counts" data-testid="analytics-data-counts">
          {countsLine(status.counts)}
        </p>
      ) : null}
      <div className="privacy-filters">
        <Filter
          label={copy('viewer.col.state.label')}
          name={`${id}-state`}
          event="privacy.data.filter-state"
          testId="analytics-data-state"
          value={state}
          options={STATE_FILTERS.map((value) => ({ value, label: stateLabel(value) }))}
          onChange={(value) => {
            setState(value);
            setAt({});
          }}
        />
        <Filter
          label={copy('viewer.col.client.label')}
          name={`${id}-client`}
          event="privacy.data.filter-client"
          testId="analytics-data-client"
          value={client}
          options={CLIENT_FILTERS}
          onChange={(value) => {
            setClient(value);
            setAt({});
          }}
        />
      </div>
      {page && page.total === 0 ? (
        <p className="privacy-data-empty" data-testid="analytics-data-empty">
          {copy('viewer.empty.title')}
        </p>
      ) : (
        <div className="privacy-table-wrap">
          <table className="privacy-table" data-testid="analytics-data-table">
            <thead>
              <tr>
                <th scope="col">{copy('viewer.col.time.label')}</th>
                <th scope="col">{copy('viewer.col.client.label')}</th>
                <th scope="col">{copy('viewer.col.kind.label')}</th>
                <th scope="col">{copy('viewer.col.name.label')}</th>
                <th scope="col">{copy('viewer.col.props.label')}</th>
                <th scope="col">{copy('viewer.col.state.label')}</th>
              </tr>
            </thead>
            <tbody>
              {events.map((event) => (
                <tr key={event.id} data-testid="analytics-data-row" data-state={event.state}>
                  <td className="privacy-table-time">{timeOf(event.at)}</td>
                  <td>{clientLabel(event)}</td>
                  <td>{event.kind}</td>
                  <td className="privacy-table-name">{event.name}</td>
                  <td className="privacy-table-props">{propsOf(event)}</td>
                  <td>
                    <span className="chip privacy-state" data-state={event.state}>
                      {STATE_LABELS[event.state]}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {page && page.total > 0 ? (
        <div className="privacy-pager">
          <span className="privacy-pager-count" data-testid="analytics-data-showing">
            {copy('viewer.showing', { from, to, total: page.total })}
          </span>
          <span className="privacy-pager-buttons">
            <button
              type="button"
              className="btn"
              data-ui="item"
              data-event="privacy.data.later"
              data-testid="analytics-data-later"
              disabled={page.newer === 0 || !first}
              onClick={() => first && setAt({ after: { at: first.at, id: first.id } })}
            >
              <Icon name="chevL" size={14} />
              {copy('viewer.later.button')}
            </button>
            <button
              type="button"
              className="btn"
              data-ui="item"
              data-event="privacy.data.earlier"
              data-testid="analytics-data-earlier"
              disabled={to >= page.total || !last}
              onClick={() => last && setAt({ before: { at: last.at, id: last.id } })}
            >
              {copy('viewer.earlier.button')}
              <Icon name="chevR" size={14} />
            </button>
          </span>
        </div>
      ) : null}
    </section>
  );
}

/** One filter: a row of choices, one picked. */
function Filter<T extends string>({
  label,
  name,
  event,
  testId,
  value,
  options,
  onChange,
}: {
  readonly label: string;
  readonly name: string;
  readonly event: 'privacy.data.filter-state' | 'privacy.data.filter-client';
  readonly testId: string;
  readonly value: T;
  readonly options: ReadonlyArray<{ readonly value: T; readonly label: string }>;
  readonly onChange: (value: T) => void;
}) {
  const id = useId();
  return (
    <fieldset className="seg-field privacy-filter" aria-labelledby={`${id}-label`}>
      <span className="privacy-filter-label" id={`${id}-label`}>
        {label}
      </span>
      <div className="seg" data-testid={testId}>
        {options.map((option) => (
          <label key={option.value} className="seg-option">
            <input
              type="radio"
              name={name}
              value={option.value}
              checked={value === option.value}
              data-event={event}
              onChange={() => onChange(option.value)}
            />
            <span className="bold-steady" data-label={option.label}>
              {option.label}
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
