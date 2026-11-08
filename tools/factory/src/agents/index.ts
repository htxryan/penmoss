/** The agent for an issue's spec: Claude Code or OpenCode, by its labels (F12). */
import type { AgentProvider } from '@ai-hero/sandcastle';
import type { FactoryConfig } from '../config.ts';
import type { IssueSpec } from '../labels.ts';
import { claudeAgent } from './claude.ts';
import { opencodeAgent } from './opencode.ts';

export function agentFor(config: FactoryConfig, spec: IssueSpec): Promise<AgentProvider> {
  const model = config.models[spec.modelAlias]?.model ?? spec.model;
  return spec.agent === 'opencode' ? opencodeAgent(model) : claudeAgent(model);
}
