/**
 * `.factory/result.json`, the one thing an agent hands back (Agent contract in the factory
 * plan). Parsed strictly: a run whose result is missing or malformed fails, never guesses.
 */
import { PLATFORMS, type Platform } from './config.ts';

export interface PlatformResult {
  readonly inScope: boolean;
  readonly proofSpecs: readonly string[];
}

export interface AgentResult {
  readonly status: 'done' | 'needs-info' | 'failed';
  readonly summary: string;
  readonly questions: readonly string[];
  readonly platforms: Readonly<Partial<Record<Platform, PlatformResult>>>;
  readonly tests: readonly { readonly cmd: string; readonly result: string }[];
  readonly decisions: readonly string[];
  readonly risks: readonly string[];
  /** In a review round: what to reply on each review thread, by thread ID. */
  readonly replies: Readonly<Record<string, string>>;
}

export const RESULT_PATH = '.factory/result.json';

/**
 * A proof spec is a path (`apps/web/test/e2e/x.spec.ts`, `test/e2e/x.spec.ts:12`) or a test
 * class (`app.penmoss.editor.TypingInstrumentedTest#method`), never a flag or shell text: the
 * Mac's specs go into the command the test VM runs (`scripts/vm/desktop-test.sh`).
 */
const PLAIN_SPEC = /^[A-Za-z0-9_.][A-Za-z0-9_./#:@-]*$/;

export type AgentResultParse =
  | { readonly ok: true; readonly result: AgentResult }
  | { readonly ok: false; readonly error: string };

const strings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((v) => typeof v === 'string');

export function parseAgentResult(text: string): AgentResultParse {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: `${RESULT_PATH} is not JSON` };
  }
  if (typeof raw !== 'object' || raw === null)
    return { ok: false, error: `${RESULT_PATH} must be an object` };
  const r = raw as Record<string, unknown>;
  if (r['status'] !== 'done' && r['status'] !== 'needs-info' && r['status'] !== 'failed') {
    return { ok: false, error: 'status must be done, needs-info or failed' };
  }
  if (typeof r['summary'] !== 'string' || r['summary'].trim() === '') {
    return { ok: false, error: 'summary must be a non-empty string' };
  }
  const questions = r['questions'] ?? [];
  if (!strings(questions)) return { ok: false, error: 'questions must be a list of strings' };
  if (r['status'] === 'needs-info' && questions.length === 0) {
    return { ok: false, error: 'needs-info needs at least one question' };
  }
  const platforms: Partial<Record<Platform, PlatformResult>> = {};
  const rawPlatforms = r['platforms'] ?? {};
  if (typeof rawPlatforms !== 'object' || rawPlatforms === null)
    return { ok: false, error: 'platforms must be an object' };
  for (const [name, value] of Object.entries(rawPlatforms)) {
    if (!PLATFORMS.includes(name as Platform))
      return { ok: false, error: `unknown platform "${name}"` };
    const p = value as Record<string, unknown>;
    if (typeof p['inScope'] !== 'boolean')
      return { ok: false, error: `platforms.${name}.inScope must be true or false` };
    const specs = p['proofSpecs'] ?? [];
    if (!strings(specs))
      return { ok: false, error: `platforms.${name}.proofSpecs must be a list of strings` };
    const unsafe = specs.find((spec) => !PLAIN_SPEC.test(spec));
    if (unsafe !== undefined)
      return {
        ok: false,
        error: `platforms.${name}.proofSpecs: "${unsafe}" is not a plain spec path or test class`,
      };
    platforms[name as Platform] = { inScope: p['inScope'], proofSpecs: specs };
  }
  const tests = r['tests'] ?? [];
  if (
    !Array.isArray(tests) ||
    !tests.every((t) => typeof (t as { cmd?: unknown }).cmd === 'string')
  ) {
    return { ok: false, error: 'tests must be a list of { cmd, result }' };
  }
  const decisions = r['decisions'] ?? [];
  const risks = r['risks'] ?? [];
  if (!strings(decisions) || !strings(risks))
    return { ok: false, error: 'decisions and risks must be lists of strings' };
  const replies = r['replies'] ?? {};
  if (
    typeof replies !== 'object' ||
    replies === null ||
    Array.isArray(replies) ||
    !Object.values(replies).every((v) => typeof v === 'string')
  ) {
    return { ok: false, error: 'replies must map thread IDs to text' };
  }
  return {
    ok: true,
    result: {
      status: r['status'],
      summary: r['summary'].trim(),
      questions,
      platforms,
      tests: tests.map((t) => {
        const { cmd, result } = t as { cmd: string; result?: unknown };
        return { cmd, result: typeof result === 'string' ? result : '' };
      }),
      decisions,
      risks,
      replies: replies as Record<string, string>,
    },
  };
}
