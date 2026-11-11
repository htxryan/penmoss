/**
 * One evening of the factory on Linear, for the Factory UI's tests: the unit tests build the view
 * from it, and the page check (e2e/ui.spec.ts) writes it into a fake state folder. PEN-75's run is
 * the real ledger of 9 Nov 2026 (its first run, which failed before the agent started).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Board, BoardItem } from '../src/board.ts';
import type { FactoryConfig } from '../src/config.ts';
import type { DaemonStatus } from '../src/status.ts';
import type { PlanInfo } from '../src/ui/model.ts';
import { item, linearConfig } from './helpers.ts';

export const NOW = new Date('2026-11-09T02:30:00Z');
const ago = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000).toISOString();
const PR = (n: number) => `https://github.com/htxryan/penmoss/pull/${n}`;

export const pen = (n: number, o: Partial<BoardItem> = {}): BoardItem =>
  item(n, {
    itemId: `uuid-${n}`,
    key: `PEN-${n}`,
    title: `Card ${n}`,
    url: `https://linear.app/penmoss/issue/PEN-${n}/card-${n}`,
    status: 'Todo',
    ...o,
  });

/** A ledger line as `host.ts` writes it. */
export const line = (run: string, event: string, at: string, extra: object = {}, slot = 1) =>
  JSON.stringify({ at, run, slot, event, ...extra });

export function evening(stateDir = '~/nonexistent-factory-state') {
  const config: FactoryConfig = { ...linearConfig(), stateDir };
  const board: Board = {
    items: [
      // The factory blocked it: its run failed before the agent started.
      pen(75, {
        title: 'Brochure site: link Ryan Henderson in the footer',
        status: 'In Progress',
        labels: ['Blocked'],
        blocked: true,
        blockedSet: true,
      }),
      // In Progress, but never given to the factory (PEN-30's tasks): counted, not listed.
      pen(36, {
        title: 'A task of PEN-30',
        status: 'In Progress',
        blocked: true,
        blockedBy: ['PEN-35'],
        blockedSet: false,
      }),
      pen(37, {
        title: 'Another task of PEN-30',
        status: 'In Progress',
        labels: ['Blocked'],
        blocked: true,
        blockedSet: true,
      }),
      // CI stayed red after two repairs: the factory blocked it.
      pen(73, {
        title: 'Android: share sheet opens the note picker',
        status: 'In Progress',
        labels: ['Blocked'],
        blocked: true,
        blockedSet: true,
      }),
      pen(74, { title: 'Site: footer year updates itself', status: 'In Review' }),
      pen(78, {
        title: 'Export all notes as a zip',
        status: 'Planning',
        labels: ['Blocked'],
        blocked: true,
        blockedSet: true,
      }),
      pen(84, {
        title: 'Android: widget for today’s note',
        status: 'Todo',
        labels: ['agent:claude', 'agent:opencode', 'Blocked'],
        blocked: true,
        blockedSet: true,
      }),
      // Live on slot 2, waiting for the test VM.
      pen(77, { title: 'Web: ⌘\\ toggles the sidebar', status: 'In Progress' }),
      // Live on slot 1, the agent working.
      pen(79, { title: 'Relay: answer 429 with Retry-After', status: 'In Progress' }),
      pen(76, { title: 'Web: remember the last open folder', status: 'Planning' }),
      pen(80, { title: 'Docs: keyboard shortcuts page', status: 'Todo', priority: 2 }),
      pen(82, {
        title: 'Mac: menu bar quick capture',
        status: 'Todo',
        blocked: true,
        blockedBy: ['PEN-77'],
        blockedSet: false,
      }),
      pen(72, { title: 'Site: Privacy page typo', status: 'Done', state: 'CLOSED' }),
      // Backlog: not the factory's.
      pen(90, { status: 'Backlog' }),
    ],
  };
  const ledger = [
    line('75-mw8i1uya-7565', 'claimed', ago(140), { issue: 75 }),
    line('75-mw8i1uya-7565', 'agent-started', ago(139.75), {
      branch: 'factory/75-brochure-site-link-ryan-henderson-in',
      round: 0,
    }),
    line('75-mw8i1uya-7565', 'failed', ago(139.7), {
      error: 'claude-code exited with code 127:\n/bin/sh: claude: command not found\n',
    }),
    // Four minutes later on the same slot, PEN-84's run failed in seconds too, so on the timeline
    // its key would clash with PEN-75's (PEN-99).
    line('84-f', 'claimed', ago(136), { issue: 84 }),
    line('84-f', 'failed', ago(135.9), { error: 'gh: HTTP 502 while fetching the branch\n' }),
    line('73-a', 'claimed', ago(320), { issue: 73 }, 2),
    line('73-a', 'agent-started', ago(319), { round: 0 }, 2),
    line('73-a', 'agent-finished', ago(290), { status: 'done' }, 2),
    line('73-a', 'gate-passed', ago(280), { command: 'task check' }, 2),
    line('73-a', 'pr-opened', ago(270), { pr: PR(64) }, 2),
    line('73-a', 'ci-red', ago(250), { failed: ['android-emulator'], repairs: 1 }, 2),
    line('73-a', 'ci-red', ago(200), { failed: ['android-emulator'], repairs: 2 }, 2),
    line('73-a', 'blocked', ago(195), { reason: 'ci-red' }, 2),
    line('74-b', 'claimed', ago(120), { issue: 74 }, 2),
    line('74-b', 'pr-opened', ago(60), { pr: PR(65) }, 2),
    line('74-b', 'in-review', ago(44), { pr: PR(65) }, 2),
    line('77-c', 'claimed', ago(43), { issue: 77 }, 2),
    line('77-c', 'gate-passed', ago(20), { command: 'task check' }, 2),
    line(
      '77-c',
      'proof-waiting',
      ago(15),
      {
        platform: 'mac',
        reason: "the VM penmoss-test isn't made",
      },
      2,
    ),
    line('79-d', 'claimed', ago(8), { issue: 79 }),
    line('79-d', 'agent-started', ago(7), { round: 0 }),
    line('72-e', 'claimed', ago(600), { issue: 72 }),
    line('72-e', 'in-review', ago(560), { pr: PR(63) }),
    '{"torn',
  ].join('\n');
  const plans: Record<number, PlanInfo> = {
    76: {
      meta: { sessionId: 'S76abcdef01', messagedAt: ago(4) },
      state: null,
    },
    78: {
      meta: {
        sessionId: 'S78',
        chatUrl: 'https://claude.ai/code/session_S78',
        messagedAt: ago(30),
        askedAt: ago(17),
      },
      state: {
        status: 'waiting',
        planUrl: 'https://claude.ai/artifact/p78',
        designUrl: null,
        // As the planner writes them: every point in `open`, the same ones with options in
        // `questions`, in the same order (prompts/planning.md).
        open: [
          'Proposed: attachments go in the zip beside their notes. OK?',
          'Proposed: one zip for the whole library, with its folders kept. OK?',
        ],
        questions: [
          { text: 'Include attachments?', options: ['Yes, beside their notes (proposed)', 'No'] },
          {
            text: 'One zip or one per folder?',
            options: ['One zip, folders kept (proposed)', 'One zip per folder'],
          },
        ],
        versions: null,
        agreed: null,
      },
    },
  };
  const status: DaemonStatus = {
    updatedAt: new Date(NOW.getTime() - 14_000).toISOString(),
    pid: 4242,
    running: [
      { issue: 79, slot: 1, startedAt: ago(8), why: 'picked' },
      {
        issue: 77,
        slot: 2,
        startedAt: ago(43),
        why: 'picked',
        waitingFor: { reason: "the VM penmoss-test isn't made", since: ago(15) },
      },
    ],
    merging: [],
    waiting: [80],
    skipped: [],
    paused: false,
    code: {
      dir: join(stateDir, 'code'),
      commit: { sha: 'e47b20a0000000000000000000000000000000000', subject: 'Factory: fixes' },
    },
  };
  return { config, board, ledger, plans, status, now: NOW };
}

/** Writes the evening into a state folder, as the daemon and the planning host leave it. */
export function writeEvening(stateDir: string, e = evening(stateDir)): void {
  mkdirSync(join(stateDir, 'runs', '79-d'), { recursive: true });
  writeFileSync(join(stateDir, 'runs.jsonl'), `${e.ledger}\n`);
  writeFileSync(join(stateDir, 'status.json'), JSON.stringify(e.status, null, 2));
  writeFileSync(
    join(stateDir, 'runs', '79-d', 'agent.log'),
    '\u001b[32mReading the relay handler\u001b[0m\nAdding Retry-After to the 429 path\n',
  );
  for (const [n, plan] of Object.entries(e.plans)) {
    const root = join(stateDir, 'plans', n);
    mkdirSync(join(root, 'out'), { recursive: true });
    writeFileSync(join(root, 'meta.json'), JSON.stringify(plan.meta));
    if (plan.state) writeFileSync(join(root, 'out', 'state.json'), JSON.stringify(plan.state));
  }
  mkdirSync(join(stateDir, 'doctor'), { recursive: true });
  writeFileSync(
    join(stateDir, 'doctor', 'summary-slot1.json'),
    JSON.stringify({ at: new Date(NOW.getTime() - 3 * 3_600_000).toISOString(), failed: [] }),
  );
}
