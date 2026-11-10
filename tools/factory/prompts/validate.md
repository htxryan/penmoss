You are validating a change in the Penmoss repository, inside a sandbox, on the branch `{{branch}}`. The code is committed; don't change it. Your job is evidence: walk each acceptance criterion of the agreed plan in the running app, on each platform the change affects, and capture what it looks like.

## The agreed plan

{{plan}}

## The issue's images

{{images}}

They show what Ryan saw or wants (a bug, a mockup, the screen as it was). Open them with the Read tool before you walk the criteria.

## Platforms in scope

In scope: **{{platforms}}**. Capture each criterion on the app it is about: a Mac mockup or a Mac-only behaviour on the Mac app, an Android one on the Android app, the rest on the web build. Do only the sections below for the platforms in scope.

### Web

1. Start the web app on this sandbox's port block: `pnpm --filter @penmoss/web exec vite --port $(node scripts/ports.mjs vite) --strictPort &`, and wait until it answers.
2. With Playwright (headless Chromium, `@playwright/test` from `apps/web`), set the app up as each criterion needs (the web suite's fixtures in `apps/web/test/e2e/fixtures.ts` show how to give it a notebook) and do what the criterion says.
3. Save one screenshot per criterion to `.factory/validation/<id>.png` (`ac1.png`, `ac2.png`, …), at the size the mockup shows: 1280×800 for desktop, 390×844 for a phone, and in the theme the mockup uses.

### Mac

The Mac app runs only in the test VM, which the factory starts after your session; you can't run it here. Write the walkthrough instead, as a Playwright-for-Electron spec at `apps/desktop/test/e2e/factory-walk.spec.ts`:

- Start the app with `launch` and the helpers in `apps/desktop/test/e2e/support.ts`, the way `mac-window.spec.ts` does, and close what you open.
- One `test` per criterion the Mac app shows. Set the app up, do what the criterion says, and end with `await page.screenshot({ path: 'test-results/walk/<id>-mac.png' })` (`ac3-mac.png`), the window as it is.
- Don't run it and don't commit it. The factory runs it in the VM and puts its screenshots in `.factory/validation/`. A test that fails still keeps the screenshots taken before it failed.

### Android

The slot's emulator is the factory's to start, after your session. Write the walkthrough as an instrumented test at `apps/android/app/src/androidTest/java/app/penmoss/walk/FactoryWalkInstrumentedTest.kt`, class `app.penmoss.walk.FactoryWalkInstrumentedTest`:

- Start the screen each criterion needs the way the instrumented tests in `apps/android/app/src/androidTest` do (`TooltipDelayInstrumentedTest` reads the screen through Compose's semantics tree; the Compose test rule doesn't start on the API 37 emulator).
- One `@Test` per criterion the Android app shows. Do what the criterion says, wait until the screen shows it, and end with `ProofShot.capture("<id>-android")` (`app.penmoss.proof.ProofShot`; it saves `ac3-android.png`).
- Don't run it and don't commit it. The factory runs it on this slot's emulator and puts its screenshots in `.factory/validation/`.

## Mockups and captures

1. The agreed mockups, if there are any, are HTML files in `.factory/mockups/`. Render each one to `.factory/validation/<id>-mockup.png` at the same size as its screenshot, so the two can be compared.
2. Write `.factory/validation/captures.json`, one entry per criterion. Name the screenshot the walkthrough will save for a Mac or Android criterion; it isn't there yet.

```json
{
  "captures": [
    {
      "criterion": "AC1 …the criterion's words…",
      "platform": "web",
      "screenshot": "ac1.png",
      "mockup": "ac1-mockup.png",
      "steps": "What you did to get there"
    },
    {
      "criterion": "AC3 …",
      "platform": "mac",
      "screenshot": "ac3-mac.png",
      "mockup": "ac3-mockup.png",
      "steps": "What the walkthrough's test does"
    }
  ]
}
```

A criterion for a platform that isn't in scope is captured on the web build, with the platform's name in the screenshot's name (`ac3-mac.png`) and `"platform": "web"`, so the PR labels it as the web build standing in for that app. Never call a web screenshot the Mac or Android app.

Stop the dev server when you're done. Never push or commit. Edit nothing outside `.factory/` but the two walkthrough files.
