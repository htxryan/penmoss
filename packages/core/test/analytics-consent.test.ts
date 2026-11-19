/**
 * The answer and who is behind an event (PEN-137, O3, N4, N5): the consent file read robustly,
 * the state an event is recorded in under each answer and opt-out, and the actor and agent
 * client the CLI and the MCP server record.
 */
import { describe, expect, it } from 'vitest';
import { AGENT_CLIENTS, AGENT_ENV_MARKERS, agentClientOf, cliActor } from '../src/analytics/actors';
import {
  answer,
  envOptsOut,
  limitsOf,
  newConsentFile,
  parseConsentFile,
  resetId,
  stateFor,
  type ConsentFile,
} from '../src/analytics/consent';
import { INSTALL_PATTERN, STATES } from '../src/analytics/events';
import { DEFAULT_LIMITS } from '../src/analytics/limits';

const INSTALL = '5c0e8f6a1b2c4d3e8f90a1b2c3d47a96';

describe('parseConsentFile', () => {
  it('reads a file the app wrote', () => {
    const file: ConsentFile = {
      v: 1,
      consent: 'yes',
      install: INSTALL,
      answeredAt: 1000,
      askedVersion: '1.4.0',
      sharingSince: 1000,
      limits: { 'events.days': 30 },
    };
    expect(parseConsentFile(JSON.parse(JSON.stringify(file)))).toEqual(file);
  });

  it('makes anything unreadable a fresh file with no answer and a new id', () => {
    for (const raw of [null, undefined, 'yes', 7, [], true]) {
      const file = parseConsentFile(raw);
      expect(file.consent).toBeNull();
      expect(file.install).toMatch(INSTALL_PATTERN);
      expect(file.limits).toEqual({});
    }
  });

  it('keeps each good field and drops each bad one', () => {
    const file = parseConsentFile({
      v: 9,
      consent: 'maybe',
      install: 'ZEBRACANARY',
      answeredAt: 'yesterday',
      askedVersion: 'x'.repeat(100),
      sharingSince: 5,
      limits: { 'events.days': 0, 'events.max': 10_000, 'report.kb': 16, unknown: 3 },
      extra: 'pangolincanary',
    });
    expect(file.v).toBe(1);
    expect(file.consent).toBeNull();
    expect(file.install).toMatch(INSTALL_PATTERN);
    expect(file.install).not.toBe('ZEBRACANARY');
    expect(file.answeredAt).toBeNull();
    expect(file.askedVersion).toHaveLength(40);
    // Sharing since only means something when the answer is Yes.
    expect(file.sharingSince).toBeNull();
    // Out of range and default values are dropped; only real changes are kept.
    expect(file.limits).toEqual({ 'events.max': 10_000 });
    expect(JSON.stringify(file)).not.toContain('canary');
  });

  it('refuses a number that is not finite', () => {
    const file = parseConsentFile({ consent: 'no', install: INSTALL, answeredAt: Infinity });
    expect(file).toMatchObject({ consent: 'no', install: INSTALL, answeredAt: null });
  });

  it('gives the limits in force', () => {
    expect(limitsOf(newConsentFile())).toEqual(DEFAULT_LIMITS);
    const file = parseConsentFile({ install: INSTALL, limits: { 'report.lines': 50 } });
    expect(limitsOf(file)).toEqual({ ...DEFAULT_LIMITS, 'report.lines': 50 });
  });
});

describe('stateFor', () => {
  it('records pending before the answer, waiting under Yes, local under No', () => {
    expect(stateFor(null)).toBe(STATES.pending);
    expect(stateFor('yes')).toBe(STATES.waiting);
    expect(stateFor('no')).toBe(STATES.local);
  });

  it('records local whatever the answer when the process opts out', () => {
    expect(stateFor(null, true)).toBe(STATES.local);
    expect(stateFor('yes', true)).toBe(STATES.local);
    expect(stateFor('no', true)).toBe(STATES.local);
    expect(stateFor('yes', false)).toBe(STATES.waiting);
  });
});

describe('envOptsOut', () => {
  it('honours DO_NOT_TRACK set to anything but 0 or false', () => {
    for (const value of ['1', 'true', 'yes', ' 1 ', 'TRUE']) {
      expect(envOptsOut({ DO_NOT_TRACK: value }), value).toBe(true);
    }
    for (const value of ['0', 'false', 'FALSE', '', '  ']) {
      expect(envOptsOut({ DO_NOT_TRACK: value }), JSON.stringify(value)).toBe(false);
    }
  });

  it('honours PENMOSS_ANALYTICS=off and its synonyms', () => {
    for (const value of ['off', 'OFF', '0', 'false', 'no', ' off ']) {
      expect(envOptsOut({ PENMOSS_ANALYTICS: value }), value).toBe(true);
    }
    for (const value of ['on', '1', '', 'yes']) {
      expect(envOptsOut({ PENMOSS_ANALYTICS: value }), value).toBe(false);
    }
  });

  it('is off with neither', () => {
    expect(envOptsOut({})).toBe(false);
    expect(envOptsOut({ HOME: '/Users/x' })).toBe(false);
  });

  it('makes the state local through stateFor', () => {
    expect(stateFor('yes', envOptsOut({ DO_NOT_TRACK: '1' }))).toBe(STATES.local);
    expect(stateFor(null, envOptsOut({ PENMOSS_ANALYTICS: 'off' }))).toBe(STATES.local);
  });
});

describe('answer', () => {
  const fresh: ConsentFile = { ...newConsentFile(), install: INSTALL };

  it('records Yes with when sharing began', () => {
    const yes = answer(fresh, 'yes', 5000, '1.4.0');
    expect(yes).toMatchObject({
      consent: 'yes',
      answeredAt: 5000,
      askedVersion: '1.4.0',
      sharingSince: 5000,
      install: INSTALL,
    });
    // Answering Yes again keeps when sharing began.
    expect(answer(yes, 'yes', 9000, null)).toMatchObject({
      sharingSince: 5000,
      answeredAt: 9000,
      askedVersion: '1.4.0',
    });
  });

  it('records No, which clears sharing since', () => {
    const yes = answer(fresh, 'yes', 5000, '1.4.0');
    expect(answer(yes, 'no', 6000, '1.5.0')).toMatchObject({
      consent: 'no',
      answeredAt: 6000,
      askedVersion: '1.5.0',
      sharingSince: null,
    });
  });

  it('keeps the limits and the id', () => {
    const file = { ...fresh, limits: { 'events.days': 3 } };
    expect(answer(file, 'no', 1, null)).toMatchObject({ install: INSTALL, limits: file.limits });
  });
});

describe('resetId', () => {
  it('makes a new id and keeps the rest', () => {
    const file = answer({ ...newConsentFile(), install: INSTALL }, 'yes', 5, '1.4.0');
    const reset = resetId(file);
    expect(reset.install).toMatch(INSTALL_PATTERN);
    expect(reset.install).not.toBe(INSTALL);
    expect({ ...reset, install: INSTALL }).toEqual(file);
  });
});

describe('agentClientOf', () => {
  it('maps an MCP client’s name to the fixed list, never the name itself', () => {
    const cases: ReadonlyArray<readonly [unknown, string]> = [
      ['claude-code', 'claude-code'],
      ['Claude Code', 'claude-code'],
      ['claude-ai', 'claude-desktop'],
      ['Claude Desktop', 'claude-desktop'],
      ['codex-mcp-client', 'codex'],
      ['cursor-vscode', 'cursor'],
      ['Visual Studio Code', 'vscode'],
      ['GitHub Copilot', 'vscode'],
      ['Windsurf', 'windsurf'],
      ['codeium', 'windsurf'],
      ['Zed', 'zed'],
      ['zed-editor', 'zed'],
      ['gemini-cli-mcp-client', 'gemini'],
      ['goose', 'goose'],
      ['Cline', 'cline'],
      ['continue', 'continue'],
      ['penmoss-test', 'penmoss'],
      ['Zebracanary Agent', 'other'],
      ['', 'other'],
      [undefined, 'other'],
      [42, 'other'],
      [{ name: 'claude' }, 'other'],
    ];
    for (const [name, client] of cases) expect(agentClientOf(name), String(name)).toBe(client);
  });

  it('only ever answers from the list', () => {
    for (const name of ['x', 'Amazed', 'lemurcanary', 'claude'.repeat(50)]) {
      expect(AGENT_CLIENTS).toContain(agentClientOf(name));
    }
  });
});

describe('cliActor', () => {
  it('is an agent when a known agent’s marker is set', () => {
    for (const key of AGENT_ENV_MARKERS) {
      expect(cliActor({ [key]: '1' }, true), key).toBe('agent');
      expect(cliActor({ [key]: '1' }, false), key).toBe('agent');
    }
  });

  it('ignores an empty marker', () => {
    expect(cliActor({ CLAUDECODE: '' }, true)).toBe('person');
  });

  it('is a person on a terminal and a script otherwise', () => {
    expect(cliActor({}, true)).toBe('person');
    expect(cliActor({}, false)).toBe('script');
    expect(cliActor({ TERM: 'xterm' }, false)).toBe('script');
  });
});
