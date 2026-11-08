# penmoss.app

penmoss.app is one Astro project (P9, P13; A1200): the brochure pages, written by hand, and the user docs at `/docs`, built with Starlight. Both follow the "Penmoss public release UX" design canvas exactly (A1220): the brochure is light only, and the docs restyle Starlight through the overrides in `src/components/docs/`. It builds to static files in `dist/`, served by Cloudflare Workers static assets with no Worker code, on the `penmoss.app` custom domain.

| Path                      | What it is                                                                       |
| ------------------------- | -------------------------------------------------------------------------------- |
| `src/pages/index.astro`   | The brochure (`/`). No script.                                                   |
| `src/pages/privacy.astro` | The privacy policy (`/privacy`), linked from the Play listing. No script.        |
| `src/pages/404.astro`     | The 404 page. No script.                                                         |
| `src/content/docs/docs/`  | The user docs, Markdown and MDX, served under `/docs/`.                          |
| `src/styles/tokens.css`   | The design canvas's palette, shared by the brochure and the docs (A1220).        |
| `public/_headers`         | The site-wide headers. `build.mjs` adds the docs' own policy to `dist/_headers`. |
| `build.mjs`               | `astro build`, then the CSP hashes of the docs' inline scripts (P14).            |
| `test/site.spec.ts`       | Playwright checks of the built site under `wrangler dev`.                        |
| `demo/`                   | The invented notebook the screenshots are made from (A1210).                     |
| `scripts/`                | `task site:screenshots` and the check of the images in `public/img/`.            |
| `downloads/`              | The downloads.penmoss.app Worker (A1112), separate from the site.                |

## Commands

- `task site:dev`: `astro dev`, with live reload.
- `task site:build`: builds into `dist/`. A broken internal link in the docs fails it (starlight-links-validator).
- `task site:preview`: `wrangler dev` over `dist/` with the real headers, on http://localhost:8788.
- `task site:test`: builds, checks the screenshots (`scripts/images.test.mjs`), then runs `test/site.spec.ts` against `wrangler dev` (headless Chromium). `PENMOSS_SITE_PORT` picks another port. CI's Site job runs it when `site/` changes.
- `task site:screenshots`: regenerates `public/img/` from `demo/` (see Screenshots).
- `task site:social`: redraws the social card, `public/img/social.png`.
- `task site:deploy`: builds, then `wrangler deploy`. CI deploys when a stable release is published (`.github/workflows/site.yml`, docs/ci.md).

## The release on the download cards

`build.mjs` writes the latest stable release's version, date and file sizes into `src/data/release.json` (git-ignored), which the download cards read (T80.12, A1205). `PENMOSS_SITE_RELEASE=<tag>` describes another release, such as a rehearsal; `PENMOSS_SITE_RELEASE=none` skips GitHub's API. If GitHub can't be reached, the cards show their links without a version.

## Screenshots

The images in `public/img/` are made from `demo/`, an invented notebook with no personal content (A1210): a project note with a table, a Mermaid diagram and a checklist, three daily notes, and release notes drafted on the Mac, edited on a Pixel and extended by an agent, so History shows who changed what. `demo/notebook.json` lists each writer's sync and its time; the notes are Markdown beside it.

| File                        | What it shows                                                |
| --------------------------- | ------------------------------------------------------------ |
| `hero-{light,dark}.webp`    | The project note: a table, a Mermaid diagram, a checklist    |
| `editor-{light,dark}.webp`  | A callout, highlighted code and the slash menu               |
| `journal-{light,dark}.webp` | Today's daily note, with the calendar                        |
| `history-{light,dark}.webp` | History on the release notes, with the agent's edit and diff |
| `themes-{light,dark}.webp`  | The project note in Rosé Pine, with Switch Theme open        |

Each is 2880×1800 (1440×900 at 2x) and 200 KB or less.

- `task site:screenshots` regenerates them. It plays `demo/` into a git repository, opens it in the web app as the Mac app's page through the web suite's stand-in for the Mac, in headless Chromium (nothing opens on screen), with the clock fixed at Friday 6 November 2026, 10:24 in Chicago, and writes WebP with Chromium's own encoder. It waits for a heavy-job slot.
- `task site:screenshots -- --check` regenerates them into a temp folder and fails unless each is byte for byte the one in `public/img/`. Run it after changing the app's look or the demo, to see which images changed; then run `task site:screenshots` and look at every image before committing.
- `PENMOSS_SHOTS_PNG=<folder>` keeps the PNGs there too. `PENMOSS_SCREENSHOTS_PORT` picks the Vite port.
- `scripts/images.test.mjs` (in `pnpm --filter @penmoss/site test`, so `task check`, and first in `task site:test`) fails when an image is missing, not WebP, the wrong size or over budget.

### The Android shot

The one Android image is taken by hand on the Pixel, not by the script:

1. Install the release APK, add a notebook made from the demo (push a run's repository, or type the release notes and today's note from `demo/`), and turn on the light theme. Use no personal notebook.
2. Clear the status bar of notifications, set the clock to 10:24 if you can, and open the release notes.
3. With USB debugging on and the Pixel connected: `adb exec-out screencap -p > android-light.png`.
4. Convert it to WebP within 200 KB, e.g. `cwebp -q 85 android-light.png -o public/img/android-light.webp` (Homebrew's `webp`), and check it by eye.
5. Repeat in the dark theme for `android-dark.webp` if the page shows both.

## Content security policy

The brochure pages run no script: the site-wide policy in `public/_headers` is `default-src 'none'` with inline styles and images from this site only. The docs need Starlight's scripts (the theme switch, the menu, search) and Pagefind's WebAssembly, so `/docs`, `/docs/*` and `/pagefind/*` detach the site-wide policy (`! Content-Security-Policy`) and get their own (A1202): scripts from this site and the inline ones by SHA-256 hash, computed by `build.mjs` after each build. Nothing on penmoss.app loads from anywhere else. `test/site.spec.ts` fails on a policy violation, a script on a brochure page, or a request that leaves the site.

## Data flows

When a data flow changes, update `privacy.astro` and its effective date first, and keep the Play Data safety answers in `docs/android.md` in step.
