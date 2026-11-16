/**
 * The host's agent sessions (RunDeps' `runAgent`, `continueAgent`, `readResult`): Sandcastle runs
 * the agent in the run's sandbox, in a chat in the Claude app when the factory's login allows it
 * (A1287), and a session stopped by its usage limit gives its output back for the run to wait
 * (R13).
 */
import { appendFileSync, existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentStreamEvent, SandboxRunResult } from '@ai-hero/sandcastle';
import { usageLimitReset } from './limits.ts';
import {
  account,
  clearStaged,
  freshLogin,
  loginDir,
  stageLogin,
  stagingDir,
} from './claude-login.ts';
import { parseAgentResult, RESULT_PATH } from './result.ts';
import {
  AGENT_STREAM,
  agentMissing,
  AgentNotInstalled,
  CHAT_URL,
  chatUrlOf,
  explainCompletion,
  lastErrorEvent,
  lastResultEvent,
} from './agent-stream.ts';
import type { HostContext } from './host-context.ts';
import type { HostDeps } from './host.ts';
import type { RunSandbox } from './run-deps.ts';
import { porcelainPaths } from './agent-round.ts';

/** The agent sessions of the run, and the result each wrote. */
export function agentDeps(
  ctx: HostContext,
): Pick<HostDeps, 'runAgent' | 'canContinue' | 'continueAgent' | 'readResult' | 'uncommitted'> {
  const { config, slot, exec, options, runDir, sandboxes } = ctx;
  // A session with a chat in the Claude app signs in with the factory's own login: the host
  // refreshes it if it must, and stages its access token for this slot until the session ends.
  // Without a login that works, the session runs on the setup token, with no chat (A1287).
  const remoteSession = async () => {
    const dir = loginDir(config);
    if (!options.remoteAgent || !dir) return undefined;
    const staging = stagingDir(config, slot.id);
    clearStaged(staging);
    try {
      const login = await freshLogin(exec, config, dir);
      return { agent: options.remoteAgent, unstage: stageLogin(staging, login, account(dir)) };
    } catch (error) {
      options.log(
        `no chat in the Claude app for this session: ${error instanceof Error ? error.message : String(error)}`,
      );
      return undefined;
    }
  };
  // The sandbox's last session, which `continueAgent` resumes when its agent keeps sessions.
  const lastSessions = new WeakMap<RunSandbox, { resume?: SandboxRunResult['resume'] }>();
  /**
   * One agent session in the sandbox, or with `resume` the sandbox's last one continued
   * (Sandcastle's resume: Claude Code's `--resume`). OpenCode's sessions aren't kept (A1263),
   * so it never resumes.
   */
  const session = async (handle: RunSandbox, prompt: string, resume = false) => {
    const sandbox = sandboxes.get(handle);
    if (!sandbox) throw new Error('not a sandbox this run opened');
    const last = lastSessions.get(handle)?.resume;
    if (resume && !last) throw new Error('no session in this sandbox to continue');
    const logFile = join(runDir, 'agent.log');
    // Sandcastle appends every session of the run to agent.log. Only this session's part is
    // read, or a retry after a usage limit would find the old limit message and wait again.
    const start = existsSync(logFile) ? statSync(logFile).size : 0;
    const tail = () => {
      try {
        return readFileSync(logFile).subarray(start).toString('utf8').slice(-8000);
      } catch {
        return '';
      }
    };
    // agent.log is Sandcastle's rendering; the agent's own stream (Claude Code's stream-json,
    // its init event first, which lists the MCP servers it loaded) is kept beside it, verbatim.
    const streamFile = join(runDir, AGENT_STREAM);
    const streamStart = existsSync(streamFile) ? statSync(streamFile).size : 0;
    // What can say the session hit a usage limit. Claude Code ends a session with a result
    // event, which carries a limit as an error: when there is one, only it counts, so an agent
    // that writes about limits (or works on rate limiting) isn't taken for one that hit its own.
    const limitText = (fallback: string) => {
      const result = lastResultEvent(streamFile, streamStart);
      if (!result) {
        // OpenCode's provider error, which says how long its limit lasts.
        const error = lastErrorEvent(streamFile, streamStart);
        return error ? `${fallback}\n${error}` : fallback;
      }
      return result.is_error === true && typeof result.result === 'string' ? result.result : '';
    };
    // A resumed session keeps its agent; its login is staged again all the same.
    const remote = await remoteSession();
    const agent = remote ? remote.agent : options.agent;
    try {
      const run = {
        idleTimeoutSeconds: config.timeouts.agentMinutes * 60,
        logging: {
          type: 'file' as const,
          path: logFile,
          onAgentStreamEvent: (event: AgentStreamEvent) => {
            if (event.type !== 'raw') return;
            appendFileSync(streamFile, `${event.line}\n`);
            const url = remote ? chatUrlOf(event.line) : undefined;
            if (url) {
              writeFileSync(join(runDir, CHAT_URL), url);
              options.log(`the session's chat in the Claude app: ${url}`);
              options.onChat?.(url);
            }
          },
        },
      };
      const ran =
        resume && last ? await last(prompt, run) : await sandbox.run({ agent, prompt, ...run });
      // Sandcastle offers a resume for any agent with session storage, but only a captured
      // session can be resumed: the factory doesn't capture OpenCode's (A1263).
      lastSessions.set(handle, agent.captureSessions && ran.resume ? { resume: ran.resume } : {});
    } catch (error) {
      // An agent stopped by its usage limit exits non-zero: the run waits for the reset (R13).
      const message = error instanceof Error ? error.message : String(error);
      const output = `${limitText(tail())}\n${message}`;
      if (usageLimitReset(output, new Date())) return { output };
      const missing = agentMissing(message);
      if (missing) throw new AgentNotInstalled(missing, process.env['PATH'] ?? '');
      throw error;
    } finally {
      remote?.unstage();
      rmSync(join(runDir, CHAT_URL), { force: true });
    }
    explainCompletion(logFile);
    return { output: limitText(tail()) };
  };
  return {
    runAgent: (handle, prompt) => session(handle, prompt),
    canContinue: (handle) => lastSessions.get(handle)?.resume !== undefined,
    continueAgent: (handle, message) => session(handle, message, true),
    // In the sandbox, as the gate checks it: the host never runs git in a run's worktree (A1230).
    uncommitted: async (handle) => {
      const status = await handle.exec('git status --porcelain --untracked-files=no');
      return status.exitCode === 0 ? porcelainPaths(status.stdout) : [];
    },
    readResult: (handle) => {
      const path = join(handle.worktreePath, RESULT_PATH);
      if (!existsSync(path))
        return Promise.resolve({
          ok: false,
          error: `the agent wrote no ${RESULT_PATH}`,
          missing: true,
        });
      const text = readFileSync(path, 'utf8');
      const parsed = parseAgentResult(text);
      // A copy the host keeps: a run restarted after this one resumes from it (resumeFrom).
      if (parsed.ok) writeFileSync(join(runDir, 'result.json'), text);
      return Promise.resolve(parsed);
    },
  };
}
