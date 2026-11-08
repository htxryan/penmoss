import { describe, expect, it } from 'vitest';
import { readBoard, setBlocked, setStatus } from '../src/board.ts';
import type { Exec, ExecOptions } from '../src/exec.ts';
import { createGh, GhError } from '../src/github.ts';
import { testConfig } from './helpers.ts';

interface Call {
  readonly args: readonly string[];
  readonly options: ExecOptions | undefined;
}

function fakeExec(responses: unknown[]): { exec: Exec; calls: Call[] } {
  const calls: Call[] = [];
  const exec: Exec = (_cmd, args, options) => {
    calls.push({ args, options });
    const next = responses.shift();
    if (next instanceof Error)
      return Promise.resolve({ code: 1, stdout: '', stderr: next.message });
    return Promise.resolve({ code: 0, stdout: JSON.stringify(next), stderr: '' });
  };
  return { exec, calls };
}

function vars(call: Call): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < call.args.length; i++) {
    const flag = call.args[i];
    const value = call.args[i + 1];
    if ((flag === '-f' || flag === '-F') && value && !value.startsWith('query=')) {
      const [k, ...v] = value.split('=');
      out[`${flag}${k}`] = v.join('=');
    }
  }
  return out;
}

const fields = {
  nodes: [
    {
      id: 'F_status',
      name: 'Status',
      options: [
        { id: 'o_ready', name: 'Ready' },
        { id: 'o_plan', name: 'Planning' },
      ],
    },
    { id: 'F_blocked', name: 'Blocked', options: [{ id: 'o_blocked', name: 'Blocked' }] },
    {},
  ],
};

function issueNode(
  id: string,
  number: number,
  values: { name: string; field: string }[],
  labels: string[] = [],
) {
  return {
    id,
    content: {
      number,
      title: `T${number}`,
      url: `https://github.com/htxryan/penmoss/issues/${number}`,
      state: 'OPEN',
      repository: { nameWithOwner: 'htxryan/penmoss' },
      author: { login: 'htxryan' },
      labels: { nodes: labels.map((name) => ({ name })) },
    },
    fieldValues: {
      nodes: [{}, ...values.map((v) => ({ name: v.name, field: { name: v.field } }))],
    },
  };
}

function page(nodes: unknown[], hasNextPage: boolean, endCursor: string | null) {
  return {
    data: {
      user: {
        projectV2: { id: 'PVT_1', fields, items: { pageInfo: { hasNextPage, endCursor }, nodes } },
      },
    },
  };
}

describe('readBoard', () => {
  it('reads every page, skips non-issues and keeps board order', async () => {
    const { exec, calls } = fakeExec([
      page(
        [
          issueNode('I1', 5, [{ name: 'Ready', field: 'Status' }], ['P1']),
          { id: 'D1', content: {}, fieldValues: { nodes: [] } },
        ],
        true,
        'c1',
      ),
      page(
        [
          issueNode('I2', 6, [
            { name: 'Planning', field: 'Status' },
            { name: 'Blocked', field: 'Blocked' },
          ]),
        ],
        false,
        null,
      ),
    ]);
    const board = await readBoard(createGh({ exec }), testConfig());
    expect(board.items.map((i) => [i.number, i.status, i.blocked, i.position, i.labels])).toEqual([
      [5, 'Ready', false, 0, ['P1']],
      [6, 'Planning', true, 1, []],
    ]);
    expect(board.status.options).toEqual({ Ready: 'o_ready', Planning: 'o_plan' });
    expect(vars(calls[0]!)).toEqual({ '-fowner': 'htxryan', '-Fnumber': '8' });
    expect(vars(calls[1]!)).toEqual({ '-fowner': 'htxryan', '-Fnumber': '8', '-fcursor': 'c1' });
  });

  it('moves a card and sets Blocked by option ID', async () => {
    const { exec, calls } = fakeExec([
      page([issueNode('I1', 5, [])], false, null),
      { data: {} },
      { data: {} },
    ]);
    const gh = createGh({ exec });
    const board = await readBoard(gh, testConfig());
    const card = board.items[0]!;
    await setStatus(gh, board, card, 'Planning');
    await setBlocked(gh, board, card);
    expect(vars(calls[1]!)).toEqual({
      '-fproject': 'PVT_1',
      '-fitem': 'I1',
      '-ffield': 'F_status',
      '-foption': 'o_plan',
    });
    expect(vars(calls[2]!)).toEqual({
      '-fproject': 'PVT_1',
      '-fitem': 'I1',
      '-ffield': 'F_blocked',
      '-foption': 'o_blocked',
    });
    await expect(setStatus(gh, board, card, 'Nope')).rejects.toThrow(
      'Status "Nope" doesn\'t exist',
    );
  });
});

describe('createGh', () => {
  it('throws GhError on a non-zero exit and on GraphQL errors', async () => {
    const { exec } = fakeExec([new Error('HTTP 401'), { errors: [{ message: 'bad field' }] }]);
    const gh = createGh({ exec });
    await expect(gh.run(['api', 'user'])).rejects.toBeInstanceOf(GhError);
    await expect(gh.graphql('query { x }')).rejects.toThrow('bad field');
  });

  it('passes the given environment to gh', async () => {
    const { exec, calls } = fakeExec([{ ok: 1 }]);
    await createGh({ exec, env: { GH_CONFIG_DIR: '/x' } }).json(['api', 'user']);
    expect(calls[0]?.options?.env).toEqual({ GH_CONFIG_DIR: '/x' });
  });
});
