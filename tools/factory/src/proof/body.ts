/**
 * The PR body. Files are referenced relative to the body file (`./web-1.png`), and the host
 * uploads each one to the proof bucket and points the reference at it (A1223): an image renders
 * inline with its alt text, and a video is a link to its MP4, since GitHub plays inline only
 * the videos people attach themselves.
 */
import type { Scope } from '../platforms.ts';

export interface AttachedProof {
  readonly label: string;
  readonly phase: 'before' | 'after';
  readonly source: 'harness' | 'agent';
  /** File names inside the body's folder. */
  readonly image?: string;
  readonly video?: string;
}

export interface PrBodyInput {
  readonly issue: number;
  /** The card's name, `#36` or `PEN-36`; `#<issue>` when absent. */
  readonly key?: string;
  readonly summary: string;
  /** The checked Release note (PEN-105): one note per line, or `none`. */
  readonly releaseNote: string;
  readonly scope: Scope;
  readonly gate: string;
  readonly proof: readonly AttachedProof[];
  readonly decisions: readonly string[];
  readonly risks: readonly string[];
  readonly marker: string;
  /** The fidelity table, rendered (F19). */
  readonly fidelity?: string;
  /** The agreed plan and design artifacts (F16). */
  readonly artifacts?: readonly { readonly label: string; readonly href: string }[];
  /** The earlier run the proof (and validation) was carried over from (carry.ts). */
  readonly carried?: { readonly run: string; readonly validated: boolean };
}

/** The line that says the proof wasn't recorded again, and why. */
export function carriedText(carried: {
  readonly run: string;
  readonly validated: boolean;
}): string {
  const what = carried.validated ? 'proof and validation' : 'proof';
  return `Carried over from run \`${carried.run}\`: the branch's own changes outside \`docs/decisions.md\` are byte for byte the ones that run's ${what} passed on, so the factory didn't record ${carried.validated ? 'or validate them ' : 'them '}again.`;
}

/** Alt text can't hold `]` or a newline. */
const alt = (s: string) => s.replaceAll(/[[\]\n]/g, ' ').trim();

export function renderPrBody(input: PrBodyInput): string {
  const lines = [
    // `Part of`, not `Closes` or `Fixes`: the issue stays open until main is verified (R20), and
    // Linear's GitHub integration links the PR without moving the card (LD6).
    `Part of ${input.key ?? `#${input.issue}`}.`,
    '',
    ...(input.artifacts?.length
      ? [
          `Built from the agreed ${input.artifacts.map((a) => `[${a.label}](${a.href})`).join(' and ')}.`,
          '',
        ]
      : []),
    input.summary,
    '',
    `Scope: ${input.scope.kind}${input.scope.platforms.length ? ` (${input.scope.platforms.join(', ')})` : ''}. Gate: \`${input.gate}\` passed.`,
    '',
    // Read by the Release note check and the release jobs (A1294): the notes, then a blank line.
    '## Release note',
    '',
    input.releaseNote,
  ];
  if (input.proof.length > 0) {
    lines.push(
      '',
      '## Proof',
      '',
      'Recorded by the factory running the committed tests, not supplied by the agent.',
      ...(input.carried ? ['', carriedText(input.carried)] : []),
    );
    for (const phase of ['before', 'after'] as const) {
      const items = input.proof.filter((p) => p.phase === phase && p.source === 'harness');
      if (items.length === 0) continue;
      if (phase === 'before') lines.push('', '### Before (the new test on the base commit)');
      else if (input.proof.some((p) => p.phase === 'before')) lines.push('', '### After');
      for (const p of items) {
        lines.push('', `**${p.label}**`);
        if (p.image) lines.push('', `![${alt(p.label)}](./${p.image})`);
        if (p.video) lines.push('', `[▶ Watch the recording (MP4)](./${p.video})`);
      }
    }
    const extra = input.proof.filter((p) => p.source === 'agent');
    if (extra.length > 0) {
      lines.push(
        '',
        '### Captured by the agent',
        '',
        "Stills the agent took by hand. They don't count as proof.",
      );
      for (const p of extra)
        if (p.image) lines.push('', `![agent-captured: ${alt(p.label)}](./${p.image})`);
    }
  }
  if (input.carried && input.proof.length === 0) lines.push('', carriedText(input.carried));
  if (input.fidelity) lines.push('', input.fidelity);
  if (input.decisions.length)
    lines.push('', '## Decisions', ...input.decisions.map((d) => `- ${d}`));
  if (input.risks.length) lines.push('', '## Risks', ...input.risks.map((r) => `- ${r}`));
  lines.push('', input.marker);
  return lines.join('\n');
}

/** Every proof file the body references, for the upload. */
export function proofFiles(proof: readonly AttachedProof[]): string[] {
  return proof.flatMap((p) => [p.image, p.video].filter((f): f is string => Boolean(f)));
}
