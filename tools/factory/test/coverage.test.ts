import { describe, expect, it } from 'vitest';
import { missingCaptures, planCriteria } from '../src/coverage.ts';

const PLAN = `Acceptance criteria
AC1 When the first notebook has been added in the Mac app's first run, the app shall ask.
AC5 When Privacy opens on Android, the app shall show Advanced closed.
AC30 When stats.penmoss.app opens, the Overview shall show three tiles.
ac30 again, and AC-5 again.`;

const captures = (list: object[]) => JSON.stringify({ captures: list });

describe("validation's coverage (A1650)", () => {
  it("lists the plan's criteria once each", () => {
    expect(planCriteria(PLAN)).toEqual(['AC1', 'AC5', 'AC30']);
  });

  it('finds a criterion with no capture, and one not captured on its own app', () => {
    const json = captures([
      {
        criterion: "AC1 When the first notebook has been added in the Mac app's first run",
        platform: 'web',
        screenshot: 'ac1-mac.png',
      },
      {
        criterion: 'AC5 When Privacy opens on Android',
        platform: 'android',
        screenshot: 'ac5-android.png',
      },
    ]);
    expect(missingCaptures(PLAN, json, ['web', 'mac', 'android'])).toEqual([
      'AC1: it is about the Mac app, but no capture is from the Mac walkthrough',
      'AC30: no capture at all',
    ]);
  });

  it("doesn't ask for an app that isn't in scope", () => {
    const json = captures([
      {
        criterion: "AC1 When … the Mac app's first run",
        platform: 'web',
        screenshot: 'ac1-mac.png',
      },
      {
        criterion: 'AC5 When Privacy opens on Android',
        platform: 'web',
        screenshot: 'ac5-android.png',
      },
      { criterion: 'AC30 When stats.penmoss.app opens', platform: 'web', screenshot: 'ac30.png' },
    ]);
    expect(missingCaptures(PLAN, json, ['web'])).toEqual([]);
  });

  it('asks nothing of a plan without ids, or of captures it cannot read', () => {
    expect(missingCaptures('The app shall work.', captures([]), ['web'])).toEqual([]);
    expect(missingCaptures(PLAN, null, ['web'])).toEqual([]);
    expect(missingCaptures(PLAN, 'not json', ['web'])).toEqual([]);
  });
});
