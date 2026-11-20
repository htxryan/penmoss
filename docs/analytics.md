# Usage analytics and local logs

How Penmoss records usage, sends it with consent, and keeps scrubbed logs (PEN-137; decisions A1635 to A1646 in [`decisions.md`](decisions.md)). What a person sees is in the user docs: [Usage data](../site/src/content/docs/docs/help/usage-data.md) and [Send feedback](../site/src/content/docs/docs/help/feedback.md).

## The model

- Every client (the Mac app's page and main process, Android, the CLI, the local MCP server) records each interaction **by name** into a store on its device, from the first launch, whatever the person answered.
- The answer only decides whether events leave the device. An event's state is set when it is recorded: `pending` (no answer yet: sent only if the first answer is Yes), `local` (No, or `DO_NOT_TRACK`: never sent), `waiting` (Yes), then `sent` or `refused`.
- Only the Mac app's main process and Android's WorkManager send, to `apps/telemetry` on t.penmoss.app, which writes D1. The CLI and MCP server write the Mac's shared store and the app sends their events.

## Shared code

`packages/core/src/analytics/` (`@penmoss/core/analytics`, runs anywhere):

| File           | Holds                                                                                                                                       |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `events.ts`    | The event and batch format, kinds, buckets, states and their labels                                                                         |
| `catalogue.ts` | Every name an event may carry, by kind                                                                                                      |
| `validate.ts`  | `eventProblem` and `validateBatch`: each prop typed for its kind, or for its name where `NAME_PROP_SPECS` lists one, so no free text passes |
| `limits.ts`    | The adjustable limits, their ranges and `readLimits()`                                                                                      |
| `consent.ts`   | The consent file's shape, `stateFor`, `envOptsOut`                                                                                          |
| `actors.ts`    | `agentClientOf` (an MCP client's name to a fixed list) and `cliActor`                                                                       |
| `scrub.ts`     | The log scrubber (`createScrubber`, `scrubLogLine`)                                                                                         |
| `log-block.ts` | What a bug report attaches and its collapsed block in the issue                                                                             |
| `recorder.ts`  | `Recorder`: stamps session, `seq` and time, checks, hands to a sink                                                                         |
| `copy.ts`      | Every string the analytics screens show, with `{device}`; exported to Android                                                               |

`packages/core/src/analytics/node/` (Node only): the SQLite store (`store.ts`, through `node:sqlite`), the consent file in `~/.penmoss/analytics.json` (`consent-file.ts`) and the sender (`sender.ts`). `PENMOSS_HOME` moves `~/.penmoss` and `PENMOSS_ANALYTICS_URL` the endpoint, for tests.

Android follows the same contracts in `apps/android/contract/`: `analytics-v1.json` (format, catalogue, limits), `analytics-copy-v1.json` (strings) and `scrub-v1.json` (scrubber cases). Core's tests write them with `PENMOSS_WRITE_CONTRACTS=1` and check them otherwise.

## Prop types

A prop is one of: an enum, a boolean, a count bucket, a duration bucket, a normalised key combination, the CLI's flag names, a setting's value, a catalogued screen, or a length (a whole number of CSS px or dp, a multiple of 10, 0 to `MAX_LENGTH`; `lengthOf` rounds one). Props are typed per kind in `PROP_SPECS`, except for the names `NAME_PROP_SPECS` lists, which take only their own: `app window` (window, width, height, fullScreen, maximised) and `app layout` (window, sidebar, sidebarWidth, panel, fullWidth, themeMode, tabs). No other `app` name takes those, so `app launch` with a width is refused (PEN-174).

## Window and layout events

- `app window`: the Mac's main process records it (`apps/desktop/src/window-events.ts`, through `track()` and the capture window) as a window shows, 500 ms after a resize, maximise or zoom settles, and at once on full screen; never on a move. Android records it from each Activity (`WindowEvents.kt`). A record that matches the window's last one is dropped.
- `app layout`: the page records it (`apps/web/src/analytics/layout.ts`): each part comes from the component that owns it through `useLayoutPart`, and one event follows 500 ms after the last change, if the layout differs from the last one recorded. Android's notebook screen does the same (`LayoutEvents.kt`), without tabs or a sidebar width.
- The CLI and MCP server never record either.

## Adding a tracked control

1. Give it a stable id: a `data-command` (counted by its command's run), or `data-event="<area>.<thing>"` on the web, `Modifier.tracked("<area>.<thing>")` on Android. Ids match `^[a-z][a-z0-9-]*(\.[a-z0-9-]+){1,4}$` and are never built from data.
2. Add the id to `CLICK_NAMES` in `catalogue.ts` (a new screen, dialog, setting, CLI command or MCP tool goes in its own list), and write the contract again.
3. Deploy the ingest Worker (`task telemetry:deploy`) before releasing an app that sends the new name: the Worker drops names it doesn't know. The catalogue only grows.

`penmoss/tracked-control` (ESLint), `apps/web/test/unit/analytics-catalogue.test.ts` and Android's `TrackedControlsTest` fail on a control without an id, or an id the catalogue lacks.

## The Mac app

- `apps/desktop/src/analytics.ts`: the consent file (watched, so a CLI change shows in Settings), the stamper for the page's events, the sender (every 60 s, at 25 waiting, and at quit), and the IPC behind `window.penmossDesktop.analytics`. A worker thread owns `~/.penmoss/analytics/events.db`, so no SQLite call runs on the main thread.
- `apps/desktop/src/log-file.ts`: `~/Library/Logs/Penmoss/penmoss.log`, scrubbed as written, rotated by size and count, trimmed by age hourly; a backwards tail reader for bug reports. `PENMOSS_LOG_DIR` moves it for tests.
- The page records through `apps/web/src/analytics/record.ts`; outside the Mac app it fills `window.__penmossAnalytics`, which the web suite reads.

## The Workers

- `apps/telemetry` (t.penmoss.app): `POST /v1/batch`, `POST /v1/forget`. Schema in `migrations/`, named queries in `queries/`, a nightly cron for rollups and pruning.
- `apps/telemetry-dashboard` (stats.penmoss.app): read-only views over the named queries and rollups, behind Cloudflare Access; it verifies the Access JWT on every request.

| Task                               | Does                                                        |
| ---------------------------------- | ----------------------------------------------------------- |
| `task telemetry:query -- <name>`   | Runs a named query against the remote D1 and prints a table |
| `task telemetry:sql -- "<select>"` | Runs any SQL against the remote D1 (from your own terminal) |
| `task telemetry:deploy`            | Applies migrations and deploys the ingest Worker            |
| `task dashboard:deploy`            | Builds and deploys the dashboard                            |

Setting up (Ryan, once): create the D1 database `penmoss-telemetry` and put its id in both `wrangler.jsonc` files; add the custom domains t.penmoss.app and stats.penmoss.app; create a Cloudflare Access application for stats.penmoss.app allowing only your identity, and set its aud tag and team domain as the dashboard's secrets. Deploy the ingest Worker before the first app release that sends.

## Proof and checks

- The canary notebook (`test/fixtures/canary-notebook/`) is full of distinctive names; the canary tests search the local store, the requests, D1 rows, dashboard answers and filed issue bodies for every one of them.
- Performance budgets at the largest limits (800,000 events, 400 MB of logs) are `*.budget.test.ts` files, run with `PENMOSS_BUDGETS=1`.
