import { describe, expect, it } from 'vitest';
import { buildView } from '../src/ui/model.ts';
import { base, input, view, card, minutesAgo } from './ui-fixture.ts';

describe("the daemon's health (A1233)", () => {
  it('is running while the pid is alive and polls are fresh', () => {
    expect(view.health).toMatchObject({
      state: 'running',
      fresh: true,
      pid: 4242,
      ageSeconds: 14,
      slots: { total: 2, busy: 2 },
    });
  });

  it('says the status is stale when the daemon stopped polling', () => {
    const late = { ...base.status, updatedAt: minutesAgo(13) };
    const v = buildView(input({ status: late }));
    expect(v.health).toMatchObject({
      state: 'stale',
      fresh: false,
      headline: 'Daemon not polling',
    });
    expect(v.health.detail).toContain('13 min ago');
  });

  it('says the daemon is dead when its pid is, and shows nothing as live', () => {
    const v = buildView(input({ alive: (pid) => pid !== 4242 }));
    expect(v.health).toMatchObject({ state: 'dead', fresh: false, headline: 'Daemon not running' });
    expect(v.health.detail).toContain('pid 4242 has exited');
    expect(v.health.fix).toBe('task factory:start');
    expect(v.slots.every((s) => s.issue === null)).toBe(true);
    expect(card(v, 'PEN-79').step).toBe('Stopped mid-run; the daemon restarts it on its branch');
  });

  it('says so when there is no status at all', () => {
    expect(buildView(input({ status: null })).health).toMatchObject({
      state: 'missing',
      fresh: false,
    });
  });

  it('names a wrong checkout and a failing doctor check', () => {
    const v = buildView(
      input({
        codeDir: '/elsewhere/code',
        doctor: [{ slot: 1, at: minutesAgo(60), failed: ['pnpm install'] }],
      }),
    );
    expect(v.health.problems.map((p) => p.fix)).toEqual([
      'task factory:install',
      'task factory:doctor -- --slot 1',
    ]);
    // A few words each, for the header's one pill.
    expect(v.health.problems.map((p) => p.label)).toEqual([
      'wrong checkout',
      'doctor failing on slot 1',
    ]);
    expect(v.health.doctor).toBe('doctor failing');
  });

  it("passes the doctor, and says so, when an agent's plan is at its usage limit (A1376)", () => {
    const v = buildView(
      input({ doctor: [{ slot: 1, at: minutesAgo(60), failed: [], limited: ['opencode'] }] }),
    );
    expect(v.health.problems).toEqual([]);
    expect(v.health.doctor).toMatch(/^doctor passed .*; OpenCode at its usage limit$/);
  });
});
