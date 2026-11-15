/**
 * The factory's health on the page's header (A1233): the daemon alive and polling, paused for an
 * update, or not, and what else is wrong with the setup.
 */
import type { Health, ViewInput } from './view.ts';
import { time } from './fields.ts';

export function health(input: ViewInput): Health {
  const { config, status, now } = input;
  const total = config.slots.length;
  const busy = status?.running.length ?? 0;
  const problems: { label: string; text: string; fix: string | null }[] = [];
  if (status?.code && input.codeDir && status.code.dir !== input.codeDir)
    problems.push({
      label: 'wrong checkout',
      text: `The daemon runs from ${status.code.dir}, not the factory's own clone`,
      fix: 'task factory:install',
    });
  const doctor = input.doctor ?? [];
  for (const d of doctor)
    if (d.failed.length)
      problems.push({
        label: `doctor failing on slot ${d.slot}`,
        text: `Doctor on slot ${d.slot} (${time(d.at)}) failed: ${d.failed.join('; ')}`,
        fix: `task factory:doctor -- --slot ${d.slot}`,
      });
  // An agent at its usage limit isn't a broken setup, but its cards wait, so the line says so.
  const limited = [...new Set(doctor.flatMap((d) => d.limited ?? []))].map(
    (a) => `${a === 'claude' ? 'Claude Code' : 'OpenCode'} at its usage limit`,
  );
  const doctorLine = doctor.length
    ? doctor.every((d) => d.failed.length === 0)
      ? `doctor passed ${time(
          doctor
            .map((d) => d.at)
            .sort()
            .at(-1)!,
        )}${limited.length ? `; ${limited.join(', ')}` : ''}`
      : 'doctor failing'
    : null;
  const base = {
    pollSeconds: config.pollSeconds,
    slots: { total, busy },
    problems,
    doctor: doctorLine,
  };
  if (!status)
    return {
      ...base,
      state: 'missing',
      fresh: false,
      headline: 'No daemon status',
      detail: "The daemon hasn't written status.json: it has never run, or can't start.",
      fix: 'task factory:start',
      pid: null,
      updatedAt: null,
      ageSeconds: null,
      commit: null,
    };
  const age = Math.max(0, Math.round((now.getTime() - Date.parse(status.updatedAt)) / 1000));
  const known = {
    ...base,
    pid: status.pid,
    updatedAt: status.updatedAt,
    ageSeconds: age,
    commit: status.code?.commit ?? null,
  };
  const ago = minutes(age);
  if (!input.alive(status.pid))
    return {
      ...known,
      state: 'dead',
      fresh: false,
      headline: 'Daemon not running',
      detail: `pid ${status.pid} has exited. What follows is as of its last poll, ${ago} ago.`,
      fix: 'task factory:start',
    };
  if (age > config.pollSeconds * 3)
    return {
      ...known,
      state: 'stale',
      fresh: false,
      headline: 'Daemon not polling',
      detail: `pid ${status.pid} is alive but last polled ${ago} ago (every ${config.pollSeconds} s). What follows is as of then.`,
      fix: 'task factory:logs',
    };
  if (status.paused)
    return {
      ...known,
      state: 'paused',
      fresh: true,
      headline: 'Paused for an update',
      detail: 'task factory:update is waiting for the active runs to finish; nothing new starts.',
      fix: null,
    };
  return {
    ...known,
    state: 'running',
    fresh: true,
    headline: 'Running',
    detail: `pid ${status.pid} alive`,
    fix: null,
  };
}

function minutes(seconds: number): string {
  if (seconds < 90) return `${seconds} s`;
  const m = Math.round(seconds / 60);
  return m < 90 ? `${m} min` : `${Math.round(m / 60)} h`;
}
