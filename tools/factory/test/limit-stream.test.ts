import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { lastErrorEvent } from '../src/host.ts';
import { usageLimitReset } from '../src/limits.ts';

// PEN-117's second session, as OpenCode wrote it: refused at once by OpenCode Go's 5-hour limit.
const STREAM = [
  '{"type":"step_start","timestamp":1794452807670,"sessionID":"ses_1","part":{"type":"step-start"}}',
  '{"type":"error","timestamp":1794452807695,"sessionID":"ses_1","error":{"type":"provider.quota","message":"OpenCode Go usage limit reached","status":429,"response":{"body":"{\\"type\\":\\"error\\",\\"error\\":{\\"type\\":\\"GoUsageLimitError\\",\\"message\\":\\"OpenCode Go usage limit reached\\"},\\"metadata\\":{\\"limitName\\":\\"5 hour\\"}}"},"retryAfterMs":11504000}}',
  '',
].join('\n');

describe("OpenCode's limit error in its stream (PEN-117)", () => {
  it('reads the last error event from where this session began', () => {
    const dir = mkdtempSync(join(tmpdir(), 'factory-limit-'));
    const file = join(dir, 'agent.stream.jsonl');
    const old = '{"type":"error","error":{"message":"an earlier session\'s error"}}\n';
    writeFileSync(file, old + STREAM);
    const error = lastErrorEvent(file, old.length);
    expect(error).toContain('"retryAfterMs":11504000');
    expect(error).not.toContain('earlier');
    expect(lastErrorEvent(file, old.length + STREAM.length)).toBeNull();
    expect(lastErrorEvent(join(dir, 'missing.jsonl'), 0)).toBeNull();
  });

  it('gives the limit check the wait, which agent.log alone lacks', () => {
    const dir = mkdtempSync(join(tmpdir(), 'factory-limit-'));
    const file = join(dir, 'agent.stream.jsonl');
    writeFileSync(file, STREAM);
    const now = new Date('2026-11-12T03:06:47Z');
    const log = 'Agent started\nusage limit reached\n';
    expect(usageLimitReset(log, now)?.getTime()).toBe(now.getTime() + 30 * 60_000);
    const output = `${log}\n${lastErrorEvent(file, 0)}`;
    expect(usageLimitReset(output, now)?.getTime()).toBe(now.getTime() + 11_504_000);
  });
});
