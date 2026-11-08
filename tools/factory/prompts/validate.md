You are validating a change in the Penmoss repository, inside a sandbox, on the branch `{{branch}}`. The code is committed; don't change it. Your job is evidence: walk each acceptance criterion of the agreed plan in the running app and capture what it looks like.

## The agreed plan

{{plan}}

## How

1. Start the web app on this sandbox's port block: `pnpm --filter @penmoss/web exec vite --port $(node scripts/ports.mjs vite) --strictPort &`, and wait until it answers.
2. With Playwright (headless Chromium, `@playwright/test` from `apps/web`), set the app up as each criterion needs (the web suite's fixtures in `apps/web/test/e2e/fixtures.ts` show how to give it a notebook) and do what the criterion says.
3. Save one screenshot per criterion to `.factory/validation/<id>.png` (`ac1.png`, `ac2.png`, …), at the size the mockup shows: 1280×800 for desktop, 390×844 for a phone, and in the theme the mockup uses.
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
