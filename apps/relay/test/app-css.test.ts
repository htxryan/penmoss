/** The relay's copy of the app's stylesheets is the app's (PEN-193, R12). */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
// @ts-expect-error: a plain script, without types.
import { generate, OUT } from '../scripts/app-css.mjs';

describe("the app's stylesheets in the relay", () => {
  it('are as apps/web has them: run node apps/relay/scripts/app-css.mjs when this fails', () => {
    expect(readFileSync(OUT as string, 'utf8')).toBe((generate as () => string)());
  });
});
