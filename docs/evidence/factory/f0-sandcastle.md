# F0.4 spike: Sandcastle with Seatbelt on this Mac

7 Nov 2026. `@ai-hero/sandcastle@0.14.0` on macOS 26.6.2 (Apple Silicon), Node 24.14.0, pnpm 12.15.0, Claude Code 2.1.295, OpenCode v2.1.4. The test bed was a throwaway clone of `main` (c2c36591) in the session's scratch folder, with `origin` pointed at GitHub. Every sandbox was created with `createSandbox({ sandbox: seatbelt(…), branch: "sandcastle-spike/…" })`, and the probes ran through `sandbox.exec()`.

**Status: containment and the full toolchain done, the Android emulator included; the two agent runs wait on tokens (see "Not done yet").**

## Containment

| Probe | Result |
| --- | --- |
| Environment the agent sees | `HOME PATH PWD SHLVL TMPDIR _` only. `HOME` and `TMPDIR` are private folders created per sandbox. |
| Write the worktree | Works |
| Write `~`, `~/src/penmoss`, `/Users/Shared`, `/tmp` | All refused ("Operation not permitted") |
| List `~`, read another repo, `~/.claude`, `~/.config/gh`, `~/.ssh` | All refused |
| `git push --dry-run` to GitHub | Fails: "could not read Username … terminal prompts disabled". Apple's system git config still names `osxkeychain`, but the push got no credential. The factory sets `GIT_CONFIG_NOSYSTEM=1` anyway. |
| `gh auth status` | "You are not logged into any GitHub hosts" |
| `ps`, `kill -0 1` | Both refused |
| Outbound HTTPS | Works (registry.npmjs.org 200) |
| Android SDK in `~/Library/Android/sdk` | Hidden until mounted |

## Toolchain

| Tool | Result | What it needed |
| --- | --- | --- |
| node, corepack, task, claude, opencode, ffmpeg | On `PATH` | Nothing: Sandcastle mounts `PATH` dirs read-only |
| `pnpm install --frozen-lockfile` | Works, 7–17 s with a warm store | pnpm 12 locks in fixed folders `/private/tmp/pnpm-{dir-locks,modules-swaps,store-operation-locks,verify-deps-install-locks}-<uid>`, which the sandbox blocks. Mounting those four folders fixes it. Also pass a store the factory owns (`--store-dir`), not your own. |
| `tsc` (core), vitest (core: 474 tests), ESLint | Pass | Nothing more |
| `task types` (wrangler types) | Works | Nothing more |
| JDK 21 | Works | `/usr/bin/java` is a stub; mount Homebrew's `openjdk@21` read-only and set `JAVA_HOME` |
| Gradle `:engine-bridge:test` | Runs: 227 tests, 12 failed. Outside the sandbox the same clone fails 11, all `GitCrossEngineTest` (they appear to need a built CLI). | Kotlin's daemon and JGit use Java's own temp folder and home, not `$TMPDIR`/`$HOME`: set `JAVA_TOOL_OPTIONS="-Djava.io.tmpdir=$TMPDIR -Duser.home=$HOME"` and `-Pkotlin.compiler.execution.strategy=in-process`. A writable `GRADLE_USER_HOME` the factory owns. |
| The one sandbox-only Gradle failure | `anEd25519KeySignsAsSshEd25519AndGitAndSshKeygenVerifyIt`: `ssh-keygen -Y verify` reports "error in libcrypto" | Not solved. Next step: find which file or service libcrypto is refused. |
| Headless Chromium (Playwright) | Fails out of the box: `bootstrap_check_in org.chromium.Chromium.MachPortRendezvousServer…: Permission denied`. **Works** with one extra profile rule: `(allow mach-register mach-lookup (global-name-prefix "org.chromium.Chromium.MachPortRendezvousServer"))` | Mount `~/Library/Caches/ms-playwright` read-only and set `PLAYWRIGHT_BROWSERS_PATH`. Sandcastle has no option for extra profile rules, so this is a local patch until upstream takes it. |
| `wrangler dev` as e2e starts it (`--local --local-upstream localhost --env-file e2e.env`, after local D1 migrations) | Works: "Ready", `GET /health 200` on port 28787 | Plain `wrangler dev` stops at the remote AI binding, asking for `CLOUDFLARE_API_TOKEN`, as any non-interactive run would |
| `gh`, `wrangler whoami` | Run; not signed in | Tokens (`GH_TOKEN`, `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`) passed in as environment |
| Android emulator (API 37, arm64) | **Works**: boots headless in 19–26 s, `screencap` and `screenrecord` work, Settings opens in 5–7 s | See "The emulator in the sandbox" below |
| Instrumented test (`:app:connectedDebugAndroidTest`, `TypingInstrumentedTest`, 5 tests) | **Passes** on the sandbox's own emulator, recorded with `screenrecord` (48 s MP4) | The same settings as the emulator, plus the Gradle and pnpm settings above |

## The emulator in the sandbox

Each step failed until the change beside it was made:

| Failure | Fix |
| --- | --- |
| "Incompatible processor. This Qt build requires … neon": the CPU-feature sysctls are blocked | Profile rule `(allow sysctl-read (sysctl-name-prefix "hw.") (sysctl-name-prefix "machdep.cpu."))`. `hw.optional.` alone is not enough ("Illegal instruction"). A local patch, like the Chromium rule. |
| Fatal Vulkan ColorBuffer error with `-gpu swiftshader_indirect` | Add `-feature -Vulkan` (SwiftShader through ANGLE for GLES). `-gpu guest` also boots, but renders slowly enough that Pixel Launcher stops responding. `-gpu host` hangs: `screencap` never returns. |
| Crashpad can't check in with launchd | `-crash-report-mode disabled` |
| The emulator writes to the user's temp folder | `ANDROID_TMP=$TMPDIR`; AVDs in a folder the factory owns, mounted read-write (`ANDROID_AVD_HOME`); SDK and JDK mounted read-only |
| The emulator disappears between commands | Sandcastle kills an exec's process group when the exec returns, so boot, test and recording run in one exec. An agent's run is one long exec, so its emulator lives as long as the run. |
| `screenrecord` to `/sdcard` refused by Android | Record to `/data/local/tmp` |
| "System UI isn't responding" in the recording | Build first, then boot: with software rendering, a Gradle build running at the same time starves the emulator. |

Other settings: `-no-window -no-audio -no-boot-anim -no-snapshot -no-metrics`, an explicit `-port` (5570 here), `ANDROID_SERIAL`, and an adb server port of the sandbox's own (`ANDROID_ADB_SERVER_PORT=5039`).

**Gap:** adb inside the sandbox still lists emulators outside it (`emulator-5554`, Ryan's), because emulators listen on localhost and the sandbox's network is open. Naming the serial on every command keeps the run on its own emulator. F17 tries a profile rule that blocks the other emulators' ports.

## The Mac app in the sandbox: no

Tried with `settings.spec.ts`, `mac-window.spec.ts` and `capture.spec.ts` (Playwright for Electron), opening the profile one step at a time:

| Profile | Result |
| --- | --- |
| As shipped (with the emulator and Chromium rules) | Electron aborts in `HIServices _RegisterApplication`: it can't reach the window server or Launch Services |
| Plus every Mach service (`(allow mach-lookup (global-name-prefix ""))`), `iokit-open`, POSIX shared memory, and Electron's own `com.github.Electron.*` registration | It gets past startup, then each renderer and the GPU process fail "sandbox initialization failed: Operation not permitted": Chromium's own sandbox can't start inside Seatbelt, because macOS doesn't nest sandboxes |
| Plus `--no-sandbox --disable-gpu-sandbox` | Still fails: Penmoss calls `app.enableSandbox()` (`apps/desktop/src/main.ts:141`), which overrides both switches |

Getting further would need a test-only switch that turns off the app's own sandbox, which would mean testing a weaker app than the one that ships. Even then, the profile would by then allow the whole GUI session: windows on Ryan's screen taking focus, his clipboard (`app.spec.ts` writes and clears it), and the global capture hotkey (`Control+Alt+Command+N`) fighting his own Penmoss. Without `PENMOSS_USER_DATA`, Electron also went for `/Users/redhale/Library/Application Support/Penmoss` (it finds the real home folder, not `$HOME`). The sandbox refused that. **The Electron suite and Mac proof stay on `ryan-mac-gui`**, where a separate login session gives a GUI the isolation Seatbelt can't.

Found along the way: `task desktop:build` builds the native owner check with `xcrun swiftc`, which fails only in the sandbox: "this SDK is not supported by the compiler" (SDK built with Swift 6.3.2, compiler 6.3.3, both from `/Library/Developer/CommandLineTools`). On the host the same command works, apparently thanks to a warm module cache in `$(getconf DARWIN_USER_CACHE_DIR)clang/ModuleCache`. A copy of that cache through `CLANG_MODULE_CACHE_PATH` then fails on `SwiftShims`. The likely fix is Command Line Tools whose compiler matches the SDK (reinstall them or install Xcode). Until then the build goes on without the owner check, and admin changes are refused. That's an F17 item.

## Not done yet

- **Claude Code run.** Needs a long-lived token from `claude setup-token` passed as `CLAUDE_CODE_OAUTH_TOKEN`; the sandbox hides the keychain login.
- **OpenCode Go run.** `opencode auth list` shows an "OpenCode Go · API key". Inside the sandbox the key has to come in as an environment variable, read by an `opencode.json` that uses `{env:…}` for the `opencode-go` provider. Also to check: Sandcastle's OpenCode provider was written against OpenCode 1.3.x.

Both read from `~/.config/penmoss-factory/factory.env` (FD23), which the harness passes into the sandbox without printing it.

## Verdict so far

**Go on FD22, provisionally, and on FD25: a run can be self-contained.** The sandbox holds: no writes outside the worktree, no reading your logins, no pushing with them, no signalling your processes. The repo's real toolchain runs inside it with the mounts and settings above, the Android emulator and an instrumented test included, which F17 and F8 turn into factory code. The Electron suite and Mac proof still go to `ryan-mac-gui`, for a reason the sandbox can't fix: it doesn't separate windows, so Electron would fight your own Penmoss over the global hotkey, clipboard and focus. Before C0, two things remain: the two agent runs, and the `ssh-keygen` failure, or a decision to leave that one test to the gate outside the sandbox.
