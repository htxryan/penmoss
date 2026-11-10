You are validating a change in the Penmoss repository, inside a sandbox, on the branch `{{branch}}`. The code is committed; don't change it. Your job is evidence: walk each acceptance criterion of the agreed plan in the running app and capture what it looks like.

## The agreed plan

{{plan}}

## The issue's images

{{images}}

They show what Ryan saw or wants (a bug, a mockup, the screen as it was). Open them with the Read tool before you walk the criteria.

## How

1. Start the web app on this sandbox's port block: `pnpm --filter @penmoss/web exec vite --port $(node scripts/ports.mjs vite) --strictPort &`, and wait until it answers.
2. With Playwright (headless Chromium, `@playwright/test` from `apps/web`), set the app up as each criterion needs (the web suite's fixtures in `apps/web/test/e2e/fixtures.ts` show how to give it a notebook) and do what the criterion says.
3. Save one screenshot per criterion to `.factory/validation/<id>.png` (`ac1.png`, `ac2.png`, …), at the size the mockup shows: 1280×800 for desktop, 390×844 for a phone, and in the theme the mockup uses.
   Every screenshot is the web build: there is no Mac or Android walkthrough yet. For a mockup of the Mac app, capture the web build at the mockup's size as its stand-in (the Mac app bundles it) and put `mac` in the screenshot's name (`ac3-mac.png`), so the PR labels it as the web build standing in for the Mac app. Never call a web screenshot the Mac app. A criterion only the Android app can show gets no screenshot; say so in its `steps`.
4. The agreed mockups, if there are any, are HTML files in `.factory/mockups/`. Render each one to `.factory/validation/<id>-mockup.png` at the same size, so the two can be compared.
5. Write `.factory/validation/captures.json`:

```json
{
  "captures": [
    {
      "criterion": "AC1 …the criterion's words…",
      "screenshot": "ac1.png",
      "mockup": "ac1-mockup.png",
      "steps": "What you did to get there"
    }
  ]
}
```

Stop the dev server when you're done. Never push, and don't edit anything outside `.factory/`.
