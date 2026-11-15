// The parts of a workflow the checks read (runner-policy.mjs, android-emulator.test.mjs): its
// triggers, default permissions, and each job's runs-on, if: and permissions (A1481).
//
// The workflows are Prettier-formatted YAML, so this reads them line by line (two-space indents)
// rather than adding a YAML parser to the root of the workspace.

/** The `if:` every self-hosted job carries in a workflow that runs on pull requests. */
export const FORK_GUARD =
  "github.event_name != 'pull_request' || github.event.pull_request.head.repo.full_name == github.repository";

/** GitHub's own runner labels. Any other runs-on, an expression included, counts as self-hosted. */
const GITHUB_HOSTED = /^(ubuntu|macos|windows)-[\w.-]+$/;

/**
 * @typedef {{ name: string, runsOn: string, if: string | null, permissions: string | null }} Job
 * @typedef {{ file: string, triggers: string[], permissions: string | null, jobs: Job[] }} Workflow
 */

/**
 * The value of `key:` at `indent` spaces on line `i`, with any block scalar (`>-`, `|`) or list
 * that follows it folded into one line.
 * @param {string[]} lines
 * @param {number} i
 * @param {number} indent
 */
function valueAt(lines, i, indent) {
  const inline = lines[i].slice(lines[i].indexOf(':') + 1).trim();
  const parts = /^[>|][-+]?$/.test(inline) || inline === '' ? [] : [inline];
  for (let j = i + 1; j < lines.length; j++) {
    const line = lines[j];
    if (line.trim() === '' || line.trim().startsWith('#')) continue;
    if (line.length - line.trimStart().length <= indent) break;
    parts.push(line.trim().replace(/^- /, ''));
  }
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

/** Strips a trailing `# comment` that is not inside quotes. @param {string} line */
function stripComment(line) {
  let quote = '';
  for (let k = 0; k < line.length; k++) {
    const c = line[k];
    if (quote) {
      if (c === quote) quote = '';
    } else if (c === "'" || c === '"') {
      quote = c;
    } else if (c === '#' && (k === 0 || /\s/.test(line[k - 1]))) {
      return line.slice(0, k).trimEnd();
    }
  }
  return line;
}

/**
 * Reads the parts of a workflow the fork guard depends on.
 * @param {string} text
 * @param {string} [file]
 * @returns {Workflow}
 */
export function parseWorkflow(text, file = '<workflow>') {
  const lines = text.split('\n').map(stripComment);
  /** @type {Workflow} */
  const workflow = { file, triggers: [], permissions: null, jobs: [] };
  /** @type {'on' | 'jobs' | null} */
  let section = null;
  /** @type {Job | null} */
  let job = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '') continue;
    const top = /^([\w-]+|'on'|"on"):(.*)$/.exec(line);
    if (top) {
      const key = top[1].replace(/['"]/g, '');
      section = key === 'on' ? 'on' : key === 'jobs' ? 'jobs' : null;
      job = null;
      if (key === 'on' && top[2].trim()) {
        workflow.triggers = top[2]
          .replace(/[[\]]/g, '')
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean);
      }
      if (key === 'permissions') workflow.permissions = valueAt(lines, i, 0);
      continue;
    }
    const second = /^ {2}([\w-]+):/.exec(line);
    if (second && section === 'on') workflow.triggers.push(second[1]);
    if (second && section === 'jobs') {
      job = { name: second[1], runsOn: '', if: null, permissions: null };
      workflow.jobs.push(job);
      continue;
    }
    const third = /^ {4}([\w-]+):/.exec(line);
    if (third && job) {
      if (third[1] === 'runs-on') job.runsOn = valueAt(lines, i, 4);
      if (third[1] === 'if') job.if = valueAt(lines, i, 4);
      if (third[1] === 'permissions') job.permissions = valueAt(lines, i, 4);
    }
  }
  return workflow;
}

/** @param {Job} job */
export function isSelfHosted(job) {
  const labels = job.runsOn.replace(/[[\]'"]/g, '').trim();
  if (labels === '') return false;
  if (labels.includes('self-hosted')) return true;
  // One GitHub-hosted label, e.g. `ubuntu-latest`. An expression may name the Mac runners.
  return !GITHUB_HOSTED.test(labels);
}
