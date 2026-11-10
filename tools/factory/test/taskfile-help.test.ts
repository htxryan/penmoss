/**
 * Every `task factory:*` prints its usage on `-- --help` (or `-h`) and does nothing else (A1272):
 * `factory:status` ignored the flag and ran, and `task factory:stop -- --help` stopped the daemon.
 * A task that runs the CLI passes `{{.CLI_ARGS}}` on, so the CLI's own help answers; a shell-only
 * task opens with the guard below, as one script, so its `exit 0` ends the whole task.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { COMMANDS } from '../src/usage.ts';

const TASKFILE = join(import.meta.dirname, '../../../Taskfile.yml');

/** Only `for`, `case`, `echo` of fixed text and `exit 0`, so running it alone is harmless. */
const GUARD =
  /^for a in \{\{\.CLI_ARGS\}\}; do case "\$a" in --help\|-h\) (?:echo '[^']*'; )+exit 0;; esac; done$/;

const CLI = /^node tools\/factory\/src\/cli\.ts ([\w-]+)(.*)$/;

/** Each `factory:*` task's commands, as the Taskfile lists them (a `|` block is one command). */
function factoryTasks(): Map<string, string[]> {
  const lines = readFileSync(TASKFILE, 'utf8').split('\n');
  const tasks = new Map<string, string[]>();
  let current: string[] | undefined;
  let inCmds = false;
  let block: string[] | undefined;
  const endBlock = () => {
    if (block && current) current.push(block.join('\n'));
    block = undefined;
  };
  for (const line of lines) {
    const head = /^ {2}(\S[^:]*(?::[^:\s]+)*):\s*$/.exec(line);
    if (head || /^\S/.test(line)) {
      endBlock();
      inCmds = false;
      current = head?.[1]?.startsWith('factory:') ? [] : undefined;
      if (current && head?.[1]) tasks.set(head[1], current);
      continue;
    }
    if (!current) continue;
    if (/^ {4}\S/.test(line)) {
      endBlock();
      inCmds = /^ {4}cmds:\s*$/.test(line);
      continue;
    }
    if (!inCmds) continue;
    if (block && (line.startsWith('        ') || line.trim() === '')) {
      if (line.trim() !== '') block.push(line.slice(8));
      continue;
    }
    endBlock();
    const item = /^ {6}- (.*)$/.exec(line);
    if (!item?.[1]) continue;
    if (item[1] === '|') block = [];
    else current.push(item[1]);
  }
  endBlock();
  return tasks;
}

describe('the factory tasks’ --help', { timeout: 30_000 }, () => {
  const tasks = factoryTasks();

  it('finds the factory tasks', () => {
    for (const name of ['factory:status', 'factory:stop', 'factory:ui:tailnet', 'factory:doctor'])
      expect(tasks.get(name)?.length, name).toBeGreaterThan(0);
  });

  it('passes the arguments to the CLI, or stops at a help guard first', () => {
    for (const [name, cmds] of tasks) {
      const cli = cmds.map((c) => CLI.exec(c)).filter((m) => m !== null);
      if (cli.length > 0) {
        expect(cmds, `${name}: one command, the CLI`).toHaveLength(1);
        const [, command = '', rest = ''] = cli[0] ?? [];
        expect(Object.keys(COMMANDS), `${name}: the CLI's help covers ${command}`).toContain(
          command,
        );
        expect(rest.trim(), `${name} passes {{.CLI_ARGS}}`).toBe('{{.CLI_ARGS}}');
        continue;
      }
      // A shell task: one script, so the guard's `exit 0` ends the task, not one command of it.
      expect(cmds, `${name}: one script`).toHaveLength(1);
      const [guard = ''] = (cmds[0] ?? '').split('\n');
      expect(guard, `${name} opens with the help guard`).toMatch(GUARD);
    }
  });

  it('prints the usage and exits 0 on --help or -h, and lets anything else through', () => {
    for (const [name, cmds] of tasks) {
      const [guard = ''] = (cmds[0] ?? '').split('\n');
      if (!GUARD.test(guard)) continue;
      const run = (args: string) =>
        spawnSync('/bin/sh', ['-c', `${guard.replace('{{.CLI_ARGS}}', args)}\necho RAN`], {
          encoding: 'utf8',
        });
      for (const args of ['--help', '-h', '--slot 2 --help']) {
        const r = run(args);
        expect(r.status, `${name} ${args}`).toBe(0);
        expect(r.stdout, `${name} ${args}`).toMatch(new RegExp(`^Usage: task ${name}\\n`));
        expect(r.stdout).not.toContain('RAN');
      }
      for (const args of ['', '--wait', "'--help me'"])
        expect(run(args).stdout, `${name} ${args}`).toBe('RAN\n');
    }
  });
});
