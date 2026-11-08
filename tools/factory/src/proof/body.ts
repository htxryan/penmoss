/**
 * The PR body. Files are referenced relative to the body file, and `gh pr create --attach`
 * swaps each reference for the uploaded asset: an image renders inline with its alt text, and a
 * video on a line of its own renders as a player (checked on #256).
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
  readonly summary: string;
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
}

/** Alt text can't hold `]` or a newline. */
const alt = (s: string) => s.replaceAll(/[[\]\n]/g, ' ').trim();

export function renderPrBody(input: PrBodyInput): string {
  const lines = [
    // `Part of`, not `Closes`: the issue stays open until main is verified (R20).
    `Part of #${input.issue}.`,
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
  ];
  if (input.proof.length > 0) {
    lines.push(
      '',
      '## Proof',
      '',
      'Recorded by the factory running the committed tests, not supplied by the agent.',
    );
    for (const phase of ['before', 'after'] as const) {
      const items = input.proof.filter((p) => p.phase === phase && p.source === 'harness');
      if (items.length === 0) continue;
      if (phase === 'before') lines.push('', '### Before (the new test on the base commit)');
      else if (input.proof.some((p) => p.phase === 'before')) lines.push('', '### After');
      for (const p of items) {
        lines.push('', `**${p.label}**`);
        if (p.image) lines.push('', `![${alt(p.label)}](./${p.image})`);
        if (p.video) lines.push('', `![](./${p.video})`);
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
  if (input.fidelity) lines.push('', input.fidelity);
  if (input.decisions.length)
    lines.push('', '## Decisions', ...input.decisions.map((d) => `- ${d}`));
  if (input.risks.length) lines.push('', '## Risks', ...input.risks.map((r) => `- ${r}`));
  lines.push('', input.marker);
  return lines.join('\n');
}

/** `--attach` arguments for every file the body references. */
export function attachArgs(proof: readonly AttachedProof[], dir: string): string[] {
  return proof.flatMap((p) =>
    [p.image, p.video]
      .filter((f): f is string => Boolean(f))
      .flatMap((f) => ['--attach', `${dir}/${f}`]),
  );
}
