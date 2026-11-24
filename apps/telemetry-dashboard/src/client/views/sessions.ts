/** The dashboard's Sessions view. */
import {
  ACTOR_LABELS,
  CLIENT_LABELS,
  cutLine,
  eventName,
  fullNumber,
  kindName,
  osName,
  propsInWords,
  sessionLength,
  shortInstall,
  stretches,
  titled,
  windowName,
  type EventName,
} from '../names';
import { node } from '../dom';
import { createTimeline, timesOf, type TimelineEvent } from '../timeline';
import { createPlayer } from '../replay/player';
import { state, listHref, sessionHref, sessionOpen, writeHash } from '../state';
import {
  type Row,
  type Cell,
  setPlayer,
  button,
  card,
  tiles,
  type Answer,
  rowsOf,
  type Rendered,
  stamp,
} from '../cards';

// ---------------------------------------------------------------------------------------------
// Sessions (PEN-173): the recent sessions, and one session's events in order.

/** "20 Nov, 09:14" from ms (UTC, as the range line says). */
function when(ms: number): string {
  return new Date(ms).toLocaleString('en-GB', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'UTC',
  });
}

/** A link styled as a button; with no href it is disabled (aria-disabled), as at a list's end. */
function linkButton(label: string, href: string | null): HTMLAnchorElement {
  const link = node('a', 'btn', label);
  if (href) link.href = href;
  else {
    // Without an href an <a> is no link at all: it keeps the role, disabled.
    link.setAttribute('role', 'link');
    link.setAttribute('aria-disabled', 'true');
  }
  return link;
}

const backLink = () => {
  const link = node('a', 'back', '← All Sessions');
  link.href = listHref();
  return link;
};

const eventsWord = (n: number) => `${fullNumber(n)} ${n === 1 ? 'event' : 'events'}`;
const clientName = (client: unknown) => CLIENT_LABELS[String(client)] ?? titled(String(client));
const screenCell = (name: Row[string] | undefined): Cell =>
  name ? eventName(`screen:${String(name)}`) : 'No Screens';

function sessionsList(answer: Answer): Rendered {
  const rows = rowsOf(answer, 'sessions');
  const total = Number(answer['total'] ?? 0);
  const page = Number(answer['page'] ?? 1);
  const size = Number(answer['pageSize'] ?? 50);
  const days = Number(answer['days'] ?? answer.filters.days);
  // A page past the end came back as page 1: the address and links follow what is shown.
  if (page !== state.page) {
    state.page = page;
    writeHash();
  }
  const capped = days < answer.filters.days;
  let before: HTMLElement | undefined;
  if (total > 0) {
    const from = (page - 1) * size + 1;
    const to = Math.min(page * size, total);
    // The range, then Newer and Older as separate buttons, as in the plan's ac1 and ac2.
    before = node(
      'div',
      'pager',
      node('span', 'pager-range', `${fullNumber(from)}–${fullNumber(to)} of ${fullNumber(total)}`),
      node(
        'span',
        'btn-row',
        linkButton('Newer', page > 1 ? listHref(page - 1) : null),
        linkButton('Older', to < total ? listHref(page + 1) : null),
      ),
    );
    before.setAttribute('aria-label', 'Pages');
  }
  const length = (row: Row) =>
    sessionLength({
      started: Number(row['started']),
      ended: Number(row['ended']),
      events: Number(row['events']),
      took: row['took'] === null ? null : String(row['took'] ?? ''),
    });
  const os = (row: Row) => `${osName(String(row['os']))} ${String(row['os_version'])}`;
  const screenId = (name: Row[string] | undefined) =>
    name ? eventName(`screen:${String(name)}`).id : '';
  return {
    rangeDays: days,
    body: [
      card({
        id: 'recent-sessions',
        title: 'Recent Sessions',
        wide: true,
        tall: true,
        note: `Sessions with an event that matches the filters, newest first${capped ? ', over the last 90 days' : ''}. Choose a start time to read the session.`,
        chart: null,
        ...(before ? { before } : {}),
        table: {
          columns: [
            'Started',
            'Length',
            'Client',
            'Version',
            'OS',
            'Events',
            'First Screen',
            'Last Screen',
          ],
          rows: rows.map((row) => [
            {
              text: when(Number(row['started'])),
              href: sessionHref(String(row['install']), String(row['session'])),
            },
            length(row),
            clientName(row['client']),
            String(row['version']),
            os(row),
            Number(row['events']),
            screenCell(row['first_screen']),
            screenCell(row['last_screen']),
          ]),
        },
        file: `penmoss-sessions-${state.days}d.csv`,
        csv: () => [
          [
            'Started',
            'Length',
            'Client',
            'Version',
            'OS',
            'Events',
            'First Screen',
            'First Screen ID',
            'Last Screen',
            'Last Screen ID',
            'Install',
            'Session',
          ],
          ...rows.map((row) => {
            const first = screenCell(row['first_screen']);
            const last = screenCell(row['last_screen']);
            return [
              new Date(Number(row['started'])).toISOString(),
              Math.round((Number(row['ended']) - Number(row['started'])) / 1000),
              clientName(row['client']),
              String(row['version']),
              os(row),
              Number(row['events']),
              typeof first === 'string' ? first : (first as EventName).title,
              screenId(row['first_screen']),
              typeof last === 'string' ? last : (last as EventName).title,
              screenId(row['last_screen']),
              String(row['install']).slice(0, 8),
              String(row['session']),
            ];
          }),
        ],
        empty: rows.length === 0,
      }),
    ],
  };
}

/** A session address that names no session: shown without asking the API. */
export function notASessionLink(): HTMLElement[] {
  const heading = node('h1', 'view-title', 'Not a Session Link');
  return [
    backLink(),
    heading,
    node('p', 'gone', "This address doesn't name a session."),
    linkButton('All Sessions', listHref()),
  ];
}

/** Copy Link: the address to the clipboard, or, when the browser refuses, a field to copy from. */
function copyLink(status: HTMLElement, head: HTMLElement): HTMLButtonElement {
  let shown = 0;
  const copy = button('Copy Link', () => {
    const href = location.href;
    const refused = () => {
      head.parentElement?.querySelector('.copy-fallback')?.remove();
      const field = document.createElement('input');
      field.id = 'session-link';
      field.readOnly = true;
      field.value = href;
      const label = node('label', '', 'Session Link');
      label.htmlFor = field.id;
      const fallback = node(
        'div',
        'copy-fallback',
        label,
        field,
        node('p', '', 'Select the link and copy it.'),
      );
      head.after(fallback);
      field.focus();
      field.select();
    };
    if (!navigator.clipboard) {
      refused();
      return;
    }
    navigator.clipboard.writeText(href).then(() => {
      const mine = ++shown;
      status.textContent = 'Link Copied';
      setTimeout(() => {
        if (mine === shown) status.textContent = '';
      }, 3000);
    }, refused);
  });
  copy.className = 'btn';
  return copy;
}

function sessionPage(answer: Answer): Rendered {
  const install = String(answer['install']);
  const session = String(answer['session']);
  const events = (answer['events'] as TimelineEvent[] | undefined) ?? [];
  const others = rowsOf(answer, 'others');
  const othersTotal = Number(answer['othersTotal'] ?? others.length);
  if (events.length === 0) {
    return {
      rangeDays: 90,
      title: 'Session Not Found',
      head: [backLink(), node('h1', 'view-title', 'Session Not Found')],
      body: [
        node(
          'p',
          'gone',
          "Nothing from this session in the last 90 days. It may be older, which this tab doesn't read, or its install deleted its shared data.",
        ),
        linkButton('All Sessions', listHref()),
      ],
    };
  }
  const at = events.map((e) => e.at);
  const index = others.findIndex((row) => row['session'] === session);
  const own = others[index];
  const first = events[0]!;
  const started = own ? Number(own['started']) : Math.min(...at);
  const length = sessionLength({
    started,
    ended: own ? Number(own['ended']) : Math.max(...at),
    events: own ? Number(own['events']) : events.length,
    took: own
      ? (own['took'] as string | null)
      : typeof first.props['took'] === 'string'
        ? first.props['took']
        : null,
  });
  const title = `Session on ${stamp(started)}`;

  // The header row: the h1, then Copy Link, Previous Session and Next Session.
  const copied = node('span', 'copied');
  copied.setAttribute('role', 'status');
  const head = node('div', 'session-head');
  const neighbour = (row: Row | undefined) =>
    row ? sessionHref(install, String(row['session'])) : null;
  const actions = node(
    'div',
    'session-actions',
    copied,
    copyLink(copied, head),
    linkButton('Previous Session', index > 0 ? neighbour(others[index - 1]) : null),
    linkButton('Next Session', index >= 0 ? neighbour(others[index + 1]) : null),
  );
  head.append(node('h1', 'view-title', title), actions);

  // The ids alone in the monospace face, as .cell-id shows them; the words in the body font.
  const size = windowName(first.size_class);
  const ids = node(
    'p',
    'ids',
    'Install ',
    node('code', 'ids-id', shortInstall(install)),
    ' · Session ',
    node('code', 'ids-id', session),
    ...(size ? [` · ${size}`] : []),
  );
  const actors = [...new Set(events.map((e) => e.actor))].map((a) => ACTOR_LABELS[a] ?? titled(a));

  // The timeline: one list of events, one current index (timeline.ts).
  const timeline = createTimeline(events);
  const parts = stretches(events);
  const screenOf = (i: number): Cell => {
    const part = parts.find((p) => i >= p.first && i < p.end);
    return part ? { title: part.title, id: part.id } : '';
  };
  const times = timesOf(events);
  const timelineCard = card({
    id: 'timeline',
    title: 'Timeline',
    note: `Every event in order, divided where the screen changes.${answer['more'] ? ' Showing the first 5,000 events.' : ''}`,
    chart: null,
    custom: timeline.element,
    flush: true,
    table: {
      columns: ['Seq', 'Since Start', 'Gap', 'Kind', 'Event', 'Screen', 'Details'],
      rows: events.map((event, i) => [
        event.seq,
        times[i]!.since,
        times[i]!.gap,
        kindName(`${event.kind}:${event.name}`),
        eventName(`${event.kind}:${event.name}`),
        screenOf(i),
        propsInWords(event.kind, event.props, event.name)
          .map((prop) => `${prop.label} ${prop.value}`)
          .join(' · '),
      ]),
    },
    file: `penmoss-session-${session}.csv`,
  });

  // This Install's Sessions: the 500 nearest, oldest first, the open one marked.
  const list = node('ol', 'ss');
  list.setAttribute('aria-label', "This Install's Sessions");
  for (const row of others) {
    const open = row['session'] === session;
    // Two lines: its start, its client at the right; then its length and events, muted.
    const meta = [
      sessionLength({
        started: Number(row['started']),
        ended: Number(row['ended']),
        events: Number(row['events']),
        took: row['took'] as string | null,
      }),
      eventsWord(Number(row['events'])),
      ...(open ? ['This Session'] : []),
    ].join(' · ');
    const link = node(
      'a',
      'ss-item',
      node('span', 'ss-when', when(Number(row['started']))),
      node('span', 'ss-client', clientName(row['client'])),
      node('span', 'ss-meta', meta),
    );
    link.href = sessionHref(install, String(row['session']));
    if (open) link.setAttribute('aria-current', 'page');
    list.append(node('li', '', link));
  }
  const cut = cutLine(othersTotal, Math.max(0, index), Math.max(0, others.length - index - 1));
  const sideCard = card({
    id: 'install-sessions',
    title: "This Install's Sessions",
    count: othersTotal,
    note: 'Every session of this install in the last 90 days, oldest first, whatever the filters.',
    ...(cut ? { before: node('p', 'cut', cut) } : {}),
    chart: null,
    custom: list,
    table: {
      columns: ['Started', 'Client', 'Length', 'Events'],
      rows: others.map((row) => [
        when(Number(row['started'])),
        clientName(row['client']),
        sessionLength({
          started: Number(row['started']),
          ended: Number(row['ended']),
          events: Number(row['events']),
          took: row['took'] as string | null,
        }),
        Number(row['events']),
      ]),
    },
    file: `penmoss-install-sessions-${session}.csv`,
  });
  sideCard.classList.add('side');

  // Playback (PEN-178): only an app's session has a window to draw. The card and the timeline
  // share one box, in which the card sticks while it plays.
  const play = node('div', 'session-play');
  if (first.client === 'mac' || first.client === 'android') {
    const player = createPlayer(
      events,
      timeline,
      play,
      {
        button,
        card: (body, controls, note) =>
          card({
            id: 'playback',
            title: 'Playback',
            note,
            chart: null,
            custom: body,
            controls,
            wide: true,
          }),
      },
      Boolean(answer['more']),
    );
    setPlayer(player);
    play.append(player.element);
  }
  play.append(node('div', 'session-cols', timelineCard, sideCard));

  return {
    rangeDays: 90,
    title,
    head: [backLink(), head],
    body: [
      ids,
      sessionTiles([
        { label: 'Length', value: length },
        { label: 'Events', value: own ? Number(own['events']) : events.length },
        { label: 'Client', value: clientName(first.client) },
        { label: 'Actor', value: actors.join(', ') },
        { label: 'Version', value: first.version },
        { label: 'Channel', value: titled(first.channel) },
        { label: 'OS', value: `${osName(first.os)} ${first.os_version}` },
      ]),
      play,
    ],
    after: () => {
      // The open session in the middle of its list's box; the window doesn't move.
      const item = list.querySelector('[aria-current]')?.parentElement;
      if (item) list.scrollTop = item.offsetTop - list.clientHeight / 2 + item.offsetHeight / 2;
    },
  };
}

/** A session's tiles: words as well as figures, two to a row on a phone. */
function sessionTiles(items: readonly { label: string; value: number | string }[]): HTMLElement {
  const list = tiles(items);
  list.classList.add('session-tiles');
  return list;
}

/** Sessions: the list, or one session when the address names one. */
export function sessions(answer: Answer): Rendered {
  return sessionOpen() ? sessionPage(answer) : sessionsList(answer);
}
