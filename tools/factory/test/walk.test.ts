/** Validation's Mac and Android walkthroughs (PEN-94): what the reviewer is told of them. */
import { describe, expect, it } from 'vitest';
import { WALK_SHOT, walkFile, walksText, walkTail } from '../src/walk.ts';

describe("the reviewer's account of the walkthroughs (PEN-94)", () => {
  it('says only the web build is in scope when nothing was walked', () => {
    expect(walksText([])).toBe(
      'Only the web build is in scope: every screenshot is the web build.',
    );
  });

  it("lists each walkthrough's screenshots, and what went wrong", () => {
    expect(
      walksText([
        { platform: 'android', captures: ['ac2-android.png', 'ac4-android.png'] },
        { platform: 'mac', captures: [], problem: "It couldn't run: the VM is gone." },
      ]),
    ).toBe(
      [
        "- **Android: the app on the factory's emulator**: captured `ac2-android.png`, `ac4-android.png`.",
        "- **Mac: the Electron app in the test VM**: captured nothing. It couldn't run: the VM is gone.",
      ].join('\n'),
    );
  });

  it("quotes a failed walkthrough's last lines", () => {
    const text = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n');
    const tail = walkTail(text);
    expect(tail).toContain('line 39');
    expect(tail).not.toContain('line 9\n');
    expect(walkTail('  ')).toBe('It printed nothing.');
  });

  it('names the files the session writes, and takes back only plain PNG names', () => {
    expect(walkFile('mac')).toBe('apps/desktop/test/e2e/factory-walk.spec.ts');
    expect(walkFile('android')).toBe(
      'apps/android/app/src/androidTest/java/app/penmoss/walk/FactoryWalkInstrumentedTest.kt',
    );
    expect(WALK_SHOT.test('ac3-mac.png')).toBe(true);
    for (const bad of ['../x.png', 'a b.png', 'x.txt', '.png/x'])
      expect(WALK_SHOT.test(bad)).toBe(false);
  });
});
