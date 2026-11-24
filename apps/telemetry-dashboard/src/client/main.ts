/**
 * The dashboard's page (PEN-137): a filter bar, eight views, and for each chart a legend (two
 * series or more), a Table toggle and Download CSV. Everything comes from /api/<view>. Nothing is
 * per install outside Sessions (PEN-173, A1661), which lists sessions and shows one session's
 * events and its install's sessions, the install shown only by its first 8 hex characters.
 */
import { hideTip, shortDay } from './charts';
import {
  FILTER_KEYS,
  VIEW_NAMES,
  type ViewName,
  INSTALL_ID,
  SESSION_ID,
  stateOf,
  state,
  sameState,
  hrefOf,
  sessionOpen,
  writeHash,
  requestPath,
  load,
  onRedraw,
  setState,
} from './state';
import { daysOf, clearView, stamp, type Answer, type Rendered } from './cards';
import { overview } from './views/overview';
import { commands } from './views/commands';
import { firstRun } from './views/first-run';
import { paths } from './views/paths';
import { platforms } from './views/platforms';
import { agents } from './views/agents';
import { health } from './views/health';
import { notASessionLink, sessions } from './views/sessions';

/** How fresh the view is: when the answer was made, the newest event, and the rollup's day. */
function freshnessLine(answer: Answer): HTMLElement {
  const line = document.createElement('p');
  line.className = 'freshness';
  line.dataset['testid'] = 'freshness';
  const parts = [
    `Data as of ${stamp(answer.asOf ?? Date.now())}`,
    answer.receivedAt ? `newest event ${stamp(answer.receivedAt)}` : 'no events yet',
    answer.rolledUpThrough
      ? `rollups through ${shortDay(answer.rolledUpThrough)}`
      : 'no rollups yet',
  ];
  line.textContent = `${parts.join(' · ')}. Answers are kept up to 5 minutes.`;
  return line;
}

const RENDERERS: Record<ViewName, (answer: Answer) => HTMLElement[] | Rendered> = {
  overview,
  commands,
  firstrun: firstRun,
  paths,
  sessions,
  platforms,
  agents,
  health,
};

// ---------------------------------------------------------------------------------------------
// The page.

const main = document.querySelector<HTMLElement>('#view')!;
const status = document.querySelector<HTMLElement>('#status')!;
const strip = document.querySelector<HTMLElement>('nav.views')!;
let rendering = 0;

/**
 * The tab strip: the current tab marked and scrolled into the strip (by its scrollLeft, never
 * scrollIntoView, which would move the window too), and every tab's link carrying the filters (and
 * Paths' its Start From), so a tab click keeps them.
 */
function updateTabs(): void {
  for (const link of strip.querySelectorAll<HTMLAnchorElement>('a[data-view]')) {
    const view = link.dataset['view'] as ViewName;
    link.setAttribute('href', hrefOf({ view, page: 1, install: '', session: '' }));
    if (view !== state.view) {
      link.removeAttribute('aria-current');
      continue;
    }
    link.setAttribute('aria-current', 'page');
    const box = strip.getBoundingClientRect();
    const tab = link.getBoundingClientRect();
    if (tab.left < box.left) strip.scrollLeft += tab.left - box.left;
    else if (tab.right > box.right) strip.scrollLeft += tab.right - box.right;
  }
}

/** Draws the view the state names. True when it is still the current render once drawn. */
async function render(): Promise<boolean> {
  const ticket = ++rendering;
  writeHash();
  hideTip();
  updateTabs();
  document.title = `${VIEW_NAMES[state.view]} · Penmoss Usage`;
  if (sessionOpen() && !(INSTALL_ID.test(state.install) && SESSION_ID.test(state.session))) {
    // An address that names no session: nothing to ask the API.
    clearView();
    main.replaceChildren(...notASessionLink());
    main.removeAttribute('aria-busy');
    status.textContent = '';
    document.title = 'Not a Session Link · Penmoss Usage';
    return true;
  }
  // The last view stays, dimmed, until the next one is ready.
  main.setAttribute('aria-busy', 'true');
  try {
    const answer = await load<Answer>(requestPath());
    if (ticket !== rendering) return false;
    clearView();
    const drawn = RENDERERS[state.view](answer);
    const page: Rendered = Array.isArray(drawn) ? { body: drawn } : drawn;
    const heading = document.createElement('h1');
    heading.className = 'view-title';
    heading.textContent = VIEW_NAMES[state.view];
    const range = document.createElement('p');
    range.className = 'range';
    const first = daysOf(answer.today, page.rangeDays ?? answer.filters.days)[0] ?? answer.today;
    range.textContent = `${shortDay(first)} to ${shortDay(answer.today)} (UTC)`;
    main.replaceChildren(...(page.head ?? [heading]), range, freshnessLine(answer), ...page.body);
    document.title = `${page.title ?? VIEW_NAMES[state.view]} · Penmoss Usage`;
    status.textContent = '';
    page.after?.();
    return true;
  } catch (error) {
    if (ticket !== rendering) return false;
    status.textContent = `Couldn't load this view: ${error instanceof Error ? error.message : String(error)}`;
    return true;
  } finally {
    if (ticket === rendering) main.removeAttribute('aria-busy');
  }
}

/** The filter bar's selects, set to the state. */
function showFilters(): void {
  for (const key of ['days', ...FILTER_KEYS] as const) {
    document.querySelector<HTMLSelectElement>(`#filter-${key}`)!.value = state[key];
  }
}

function setUpFilters(): void {
  for (const key of ['days', ...FILTER_KEYS] as const) {
    const select = document.querySelector<HTMLSelectElement>(`#filter-${key}`)!;
    select.value = state[key];
    select.addEventListener('change', () => {
      // A filter replaces the address, as it always has; on Sessions it goes back to the list's
      // first page, so Back from there skips an open session.
      setState({ ...state, [key]: select.value, page: 1, install: '', session: '' });
      void render();
    });
  }
  void load<{ versions: string[] }>('/api/versions?days=395').then(({ versions }) => {
    const select = document.querySelector<HTMLSelectElement>('#filter-version')!;
    for (const version of versions) {
      const option = document.createElement('option');
      option.value = version;
      option.textContent = version;
      select.append(option);
    }
    select.value = state.version;
  });
}

// Moving around (PEN-173): links push history entries, so Back returns to each step, its
// filters and where it was scrolled. The page restores the scroll itself, after the view is
// drawn, rather than the browser before the answer arrives.
history.scrollRestoration = 'manual';
/** Where each address was scrolled when it was left. */
const positions = new Map<string, number>();
/** Whether the address is changing because a link here was clicked (then it opens at the top). */
let navigating = false;

document.addEventListener('click', (event) => {
  // A plain left click only: Cmd, Ctrl, Shift or Alt (or a middle click) opens a new tab or window.
  if (event.defaultPrevented || event.button !== 0) return;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  const link = (event.target as Element | null)?.closest?.<HTMLAnchorElement>('a[href^="#"]');
  if (!link) return;
  event.preventDefault();
  const target = link.getAttribute('href')!;
  // The address already showing: no hashchange comes, and nothing changes.
  if (target === location.hash) return;
  navigating = true;
  location.hash = target;
});

window.addEventListener('hashchange', (event) => {
  positions.set(new URL(event.oldURL).hash, window.scrollY);
  const clicked = navigating;
  navigating = false;
  const bare = !location.hash.includes('?') || location.hash.endsWith('?');
  const next = stateOf(location.hash, state);
  if (!bare && sameState(next, state)) return;
  setState(next);
  showFilters();
  void render().then((current) => {
    if (!current) return;
    // After the cards' own chart redraws, which are queued the same way, so the page is at its
    // full height.
    requestAnimationFrame(() => {
      window.scrollTo(0, clicked ? 0 : (positions.get(location.hash) ?? 0));
    });
  });
});

onRedraw(() => void render());
setUpFilters();
void render();
