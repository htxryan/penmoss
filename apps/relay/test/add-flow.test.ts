/** The relay's Add Notebook script is the app's screens as apps/web has them now (A1701). */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
// @ts-expect-error: a plain script, without types.
import { generate, OUT } from '../scripts/add-flow.mjs';

describe("the app's Add Notebook screens in the relay", () => {
  it('are as apps/web has them: run node apps/relay/scripts/add-flow.mjs when this fails', async () => {
    expect(readFileSync(OUT as string, 'utf8')).toBe(await (generate as () => Promise<string>)());
  }, 60_000);
});
