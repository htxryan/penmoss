import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { chatUrlOf, keepFiles } from '../src/agent-stream.ts';

describe("validation's files in the run folder (A1256)", () => {
  it('keeps the review, captures and image pairs, never a link or a folder', () => {
    const root = mkdtempSync(join(tmpdir(), 'factory-keep-'));
    const from = join(root, 'worktree', '.factory', 'validation');
    mkdirSync(join(from, 'sub'), { recursive: true });
    writeFileSync(join(from, 'review.json'), '{"rows":[]}');
    writeFileSync(join(from, 'ac1.png'), 'png');
    writeFileSync(join(from, 'ac1-mockup.png'), 'png');
    writeFileSync(join(root, 'outside.txt'), "not the agent's");
    symlinkSync(join(root, 'outside.txt'), join(from, 'link.png'));
    const to = join(root, 'runs', 'r1', 'validation', '1');
    expect(keepFiles(from, to).sort()).toEqual(['ac1-mockup.png', 'ac1.png', 'review.json']);
    expect(readdirSync(to).sort()).toEqual(['ac1-mockup.png', 'ac1.png', 'review.json']);
    expect(readFileSync(join(to, 'review.json'), 'utf8')).toBe('{"rows":[]}');
    // Nothing to keep: no folder made.
    expect(keepFiles(join(root, 'none'), join(root, 'empty'))).toEqual([]);
    expect(existsSync(join(root, 'empty'))).toBe(false);
  });
});

describe("a session's chat link, from the runner's stream (A1287)", () => {
  it("takes only the runner's own line, with a claude.ai session link", () => {
    const line = (o: object) => JSON.stringify(o);
    expect(
      chatUrlOf(
        line({ type: 'system', subtype: 'factory_chat', url: 'https://claude.ai/code/session_A1' }),
      ),
    ).toBe('https://claude.ai/code/session_A1');
    // The agent's own words can't post a link: only a system line of the runner's.
    expect(
      chatUrlOf(
        line({
          type: 'assistant',
          subtype: 'factory_chat',
          url: 'https://claude.ai/code/session_A1',
        }),
      ),
    ).toBeUndefined();
    expect(
      chatUrlOf(line({ type: 'system', subtype: 'factory_chat', url: 'https://evil.example/x' })),
    ).toBeUndefined();
    expect(chatUrlOf('{"type":"system","subtype":"factory_chat"')).toBeUndefined();
  });
});

describe("a session's chat link (A1287)", () => {
  it("takes the runner's link, and only a claude.ai one", () => {
    const line = (url: string) => JSON.stringify({ type: 'system', subtype: 'factory_chat', url });
    expect(chatUrlOf(line('https://claude.ai/code/session_01Ab'))).toBe(
      'https://claude.ai/code/session_01Ab',
    );
    expect(chatUrlOf(line('https://evil.example/code/session_01Ab'))).toBeUndefined();
    // The agent's own words that mention it are an assistant message, not the runner's line.
    expect(
      chatUrlOf(JSON.stringify({ type: 'assistant', subtype: 'factory_chat', url: 'x' })),
    ).toBeUndefined();
    expect(chatUrlOf('{"factory_chat"')).toBeUndefined();
  });
});
