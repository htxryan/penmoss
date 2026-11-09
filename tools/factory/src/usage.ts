/**
 * The factory CLI's usage, whole and per command. `factory <command> --help` (or `-h`) prints the
 * command's usage and exits 0 without doing anything: `task factory:doctor -- --help` ran the
 * doctor instead (PEN-70's run, 9 Nov 2026).
 */

interface Command {
  /** The arguments, as the usage line shows them. */
  readonly args: string;
  /** What it does, one or more lines. */
  readonly text: string;
}

export const COMMANDS: Readonly<Record<string, Command>> = {
  next: {
    args: '[--json]',
    text: 'Print the Todo card (Ready on Project 8) it would start next, and why (read-only)',
  },
  install: {
    args: '',
    text: "Clone the factory's own code under the state folder (once) and install\nand start the LaunchAgents that run the daemon and the UI from it",
  },
  update: {
    args: '[--wait]',
    text: 'Move that code to origin/main, reinstall and restart the LaunchAgents;\nrefuses while a run or merge is active (--wait: hold new work and wait)',
  },
  start: {
    args: '',
    text: "Start both LaunchAgents (the daemon and the UI) if they aren't running",
  },
  status: {
    args: '',
    text: 'What the daemon is running (and at which commit), waiting on and\npassing over',
  },
  daemon: {
    args: '',
    text: 'Poll the board, plan cards and run them in free slots (the LaunchAgent runs this)',
  },
  ui: { args: '', text: 'Serve the Factory UI on 127.0.0.1 (its LaunchAgent runs this)' },
  report: {
    args: '[--from d] [--to d]',
    text: 'Throughput, rounds, time to In review and the share Blocked, from the\nrun ledger (default: the last 7 days; --to is exclusive)',
  },
  run: {
    args: '<n> [--slot n]',
    text: 'Implement card n (36 for PEN-36) now, in the foreground: plan:skip or\nan agreed plan',
  },
  chat: {
    args: '<n> [--print]',
    text: "Open card n's planning session in the Claude app (--print: only print\nits links)",
  },
  'decision-number': {
    args: '[--count n]',
    text: 'Reserve the next decision number(s) for a decision you add by hand, from\nthe counter the gate numbers from, so an open run never takes the same one',
  },
  'linear-check': {
    args: '[--me] [--fix]',
    text: "Check Linear's team has the factory's states and labels (--me: print\nRyan's user ID with his key; --fix: create what's missing, as Ryan)",
  },
  doctor: {
    args: '[--slot n] [--full] [--base ref] [--only name]',
    text: "Check a slot's sandbox: toolchain, tokens, and what must stay out",
  },
};

const indent = (text: string, by: string) =>
  text
    .split('\n')
    .map((l) => `${by}${l}`)
    .join('\n');

/** The whole CLI's usage. */
export function usage(): string {
  const lines = Object.entries(COMMANDS).map(([name, c]) => {
    const head = `  ${name}${c.args ? ` ${c.args}` : ''}`;
    const [first = '', ...rest] = c.text.split('\n');
    const at = 28;
    const top =
      head.length < at - 1 ? `${head.padEnd(at)}${first}` : `${head}\n${' '.repeat(at)}${first}`;
    return [top, ...rest.map((l) => `${' '.repeat(at)}${l}`)].join('\n');
  });
  return `Usage: factory <command> [--help]\n\nCommands:\n${lines.join('\n')}`;
}

/** One command's usage, or `undefined` for a command the CLI doesn't have. */
export function commandUsage(name: string): string | undefined {
  const c = Object.hasOwn(COMMANDS, name) ? COMMANDS[name] : undefined;
  if (!c) return undefined;
  return `Usage: factory ${name}${c.args ? ` ${c.args}` : ''}\n\n${indent(c.text.replaceAll('\n', ' '), '  ')}`;
}

/**
 * What to print, if the arguments ask for help: `--help` or `-h` anywhere after a known command,
 * or `help <command>`. Undefined when they don't, and the command should run.
 */
export function helpFor(argv: readonly string[]): string | undefined {
  const [command, ...rest] = argv;
  if (command === 'help' && rest[0]) return commandUsage(rest[0]) ?? usage();
  if (command === 'help' || command === '--help' || command === '-h') return usage();
  if (command === undefined || !Object.hasOwn(COMMANDS, command)) return undefined;
  return rest.includes('--help') || rest.includes('-h') ? commandUsage(command) : undefined;
}
