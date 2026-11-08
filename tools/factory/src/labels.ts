/**
 * An issue's labels as a run specification (the Labels table in the factory
 * plan): which agent and model run it, whether it skips planning, which
 * platforms it is narrowed to, and its pickup priority. Conflicting labels are
 * an error the dispatcher reports on the issue, never a guess.
 */
import { PLATFORMS, type AgentName, type FactoryConfig, type Platform } from './config.ts';

export type Priority = 1 | 2 | 3 | 4;

export interface IssueSpec {
  readonly agent: AgentName;
  /** The model alias from `factory.config.json` (`opus`, `sonnet`, `go`). */
  readonly modelAlias: string;
  /** The model the agent CLI is given. */
  readonly model: string;
  readonly planSkip: boolean;
  /** Platforms named by `platform:*` labels; `null` means the path classifier decides. */
  readonly platforms: readonly Platform[] | null;
  readonly priority: Priority;
}

export type IssueSpecResult =
  { readonly ok: true; readonly spec: IssueSpec } | { readonly ok: false; readonly error: string };

/** Unlabelled issues are picked up as P3. */
export const DEFAULT_PRIORITY: Priority = 3;

const AGENTS: readonly AgentName[] = ['claude', 'opencode'];

function suffixes(labels: readonly string[], prefix: string): string[] {
  return labels.filter((l) => l.startsWith(prefix)).map((l) => l.slice(prefix.length));
}

/** The highest priority among the issue's P1–P4 labels, or P3 when it has none. */
export function priorityOf(labels: readonly string[]): Priority {
  const found = labels
    .map((l) => /^P([1-4])$/.exec(l)?.[1])
    .filter((p): p is string => p !== undefined)
    .map((p) => Number(p) as Priority);
  return found.length === 0 ? DEFAULT_PRIORITY : (Math.min(...found) as Priority);
}

export function parseIssueSpec(labels: readonly string[], config: FactoryConfig): IssueSpecResult {
  const agentLabels = suffixes(labels, 'agent:');
  const modelLabels = suffixes(labels, 'model:');
  const platformLabels = suffixes(labels, 'platform:');

  const unknownAgent = agentLabels.find((a) => !AGENTS.includes(a as AgentName));
  if (unknownAgent !== undefined)
    return { ok: false, error: `unknown agent label agent:${unknownAgent}` };
  if (agentLabels.length > 1) {
    return {
      ok: false,
      error: `conflicting labels ${agentLabels.map((a) => `agent:${a}`).join(' and ')}`,
    };
  }
  if (modelLabels.length > 1) {
    return {
      ok: false,
      error: `conflicting labels ${modelLabels.map((m) => `model:${m}`).join(' and ')}`,
    };
  }
  const unknownPlatform = platformLabels.find((p) => !PLATFORMS.includes(p as Platform));
  if (unknownPlatform !== undefined) {
    return { ok: false, error: `unknown platform label platform:${unknownPlatform}` };
  }

  const [modelLabel] = modelLabels;
  const modelTarget = modelLabel === undefined ? undefined : config.models[modelLabel];
  if (modelLabel !== undefined && !modelTarget) {
    const known = Object.keys(config.models)
      .map((m) => `model:${m}`)
      .join(', ');
    return { ok: false, error: `unknown model label model:${modelLabel} (known: ${known})` };
  }
  // With no agent label, a model label picks its own agent; otherwise Claude Code is the default.
  const agent = (agentLabels[0] as AgentName | undefined) ?? modelTarget?.agent ?? 'claude';
  if (modelTarget && modelTarget.agent !== agent) {
    return {
      ok: false,
      error: `model:${modelLabel} runs on ${modelTarget.agent}, not agent:${agent}`,
    };
  }
  const modelAlias = modelLabel ?? config.agents[agent].defaultModel;
  const target = config.models[modelAlias];
  if (!target)
    return {
      ok: false,
      error: `the default model alias "${modelAlias}" is missing from config.models`,
    };

  const platforms = PLATFORMS.filter((p) => platformLabels.includes(p));
  return {
    ok: true,
    spec: {
      agent,
      modelAlias,
      model: target.model,
      planSkip: labels.includes(config.planning.skipLabel),
      platforms: platforms.length === 0 ? null : platforms,
      priority: priorityOf(labels),
    },
  };
}
