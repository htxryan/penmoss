import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { LAST_PROOF, stageLastProof } from '../src/host-proof.ts';

describe("the last proof's screenshots, for the agent's next round (A1291)", () => {
  it("copies each platform's screenshot into the worktree, and nothing else", () => {
    const raw = mkdtempSync(join(tmpdir(), 'factory-raw-'));
    const worktree = mkdtempSync(join(tmpdir(), 'factory-wt-'));
    for (const f of ['mac-1-screenshot.png', 'web-1-screenshot.png', 'mac-1-video.mp4', 'x.png'])
      writeFileSync(join(raw, f), f);
    expect(stageLastProof(raw, worktree).sort()).toEqual([
      'mac-1-screenshot.png',
      'web-1-screenshot.png',
    ]);
    expect(readFileSync(join(worktree, LAST_PROOF, 'mac-1-screenshot.png'), 'utf8')).toBe(
      'mac-1-screenshot.png',
    );
    expect(existsSync(join(worktree, LAST_PROOF, 'mac-1-video.mp4'))).toBe(false);
    expect(stageLastProof(join(raw, 'none'), worktree)).toEqual([]);
  });
});
