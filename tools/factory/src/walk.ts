/**
 * The Mac and Android walkthroughs of validation (F19, PEN-94). The validating session can't
 * run either app: the Mac app runs only in the test VM, which only the host starts (W10), and the
 * slot's emulator is the host's to start and stop (F8). So the session writes a walkthrough, a
 * Playwright-for-Electron spec or an instrumented test that saves one screenshot per criterion,
 * and the host runs it after the session: the Mac one in the VM, holding its lock, the Android
 * one on the slot's own emulator. The screenshots land beside the web captures in
 * `.factory/validation/`, for the independent reviewer (A1280).
 */
import type { Platform } from './config.ts';

export type WalkPlatform = Exclude<Platform, 'web'>;

/** The Mac walkthrough, in `apps/desktop`, where the VM runs Playwright. */
export const MAC_WALK_SPEC = 'test/e2e/factory-walk.spec.ts';
/** Where the Mac walkthrough saves its screenshots, relative to `apps/desktop`. */
export const MAC_WALK_SHOTS = 'test-results/walk';
/** The Android walkthrough's class and file. */
export const ANDROID_WALK_CLASS = 'app.penmoss.walk.FactoryWalkInstrumentedTest';
export const ANDROID_WALK_FILE =
  'apps/android/app/src/androidTest/java/app/penmoss/walk/FactoryWalkInstrumentedTest.kt';

/** A walkthrough's file, from the worktree's root. */
export function walkFile(platform: WalkPlatform): string {
  return platform === 'mac' ? `apps/desktop/${MAC_WALK_SPEC}` : ANDROID_WALK_FILE;
}

/** A screenshot a walkthrough may hand back: a plain PNG name, as the fidelity table allows. */
export const WALK_SHOT = /^[\w.-]+\.png$/;

/** What a walkthrough gave the reviewer: its screenshots, and what went wrong, if anything. */
export interface WalkOutcome {
  readonly platform: WalkPlatform;
  readonly captures: readonly string[];
  /** Why it didn't run, or didn't finish: the reviewer's reason for a deviation. */
  readonly problem?: string;
}

const NAMES: Record<WalkPlatform, string> = {
  mac: 'Mac: the Electron app in the test VM',
  android: "Android: the app on the factory's emulator",
};

/** The reviewer's account of each walkthrough, for `review.md`'s `{{walks}}`. */
export function walksText(walks: readonly WalkOutcome[]): string {
  if (walks.length === 0)
    return 'Only the web build is in scope: every screenshot is the web build.';
  return walks
    .map((w) => {
      const shots = w.captures.length
        ? `captured ${w.captures.map((c) => `\`${c}\``).join(', ')}`
        : 'captured nothing';
      return `- **${NAMES[w.platform]}**: ${shots}.${w.problem ? ` ${w.problem}` : ''}`;
    })
    .join('\n');
}

/** The last lines of a walkthrough's output, to say why it failed. */
export function walkTail(text: string, lines = 30): string {
  const tail = text.trim().split('\n').slice(-lines).join('\n');
  return tail ? `Its last lines:\n\n\`\`\`\n${tail}\n\`\`\`` : 'It printed nothing.';
}
