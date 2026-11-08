#!/usr/bin/env node
// GitHub intake into Linear (D66, W14): a new issue on htxryan/penmoss becomes an issue in the
// Penmoss team's Triage, with a link back. One way only: nothing in Linear writes to GitHub.
// Linear's own GitHub issue sync is two-way, and would copy the private roadmap into the
// public repository, so it stays off.
//
// Run by .github/workflows/linear-intake.yml on `issues: opened`. Reads the event from
// GITHUB_EVENT_PATH and the key from LINEAR_API_KEY. The issue's title and body come from
// anyone and are only ever passed to Linear's API as GraphQL variables.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const LINEAR_API = 'https://api.linear.app/graphql';

/** The Penmoss team (PEN) in the Redhale workspace, and its ids this needs. */
export const PEN = {
  teamId: '9e5383e9-4e25-4247-a76e-11a575f64d2c',
  triageStateId: '86dd4eaa-d3a2-44ce-9b46-eff88cdcb575',
  /** GitHub label (lower case) → Linear label id. */
  labels: {
    bug: 'dbbc2b47-1aee-4397-81d1-1c1f79920c41',
    'feature request': '44dddf21-4ab6-4f0c-94e2-4eefbb6d4602',
    feature: '44dddf21-4ab6-4f0c-94e2-4eefbb6d4602',
    'in-app feedback': '6012f953-59ec-4f03-8d7a-e0e7af781db1',
  },
};

/** Send feedback's P1–P4 (docs/feedback.md) → Linear's priority (1 Urgent … 4 Low). */
const PRIORITY = /** @type {Record<string, number>} */ ({ p1: 1, p2: 2, p3: 3, p4: 4 });

const MAX_TITLE = 250;
const MAX_BODY = 60_000;

/**
 * @typedef {{ number: number; title: string; body?: string | null; html_url: string;
 *   user?: { login?: string } | null; labels?: ({ name?: string } | string)[] }} GitHubIssue
 */

/**
 * The `issueCreate` input for a GitHub issue. Pure, so it is tested without the network.
 * @param {GitHubIssue} issue
 * @param {string} repo `owner/name`
 */
export function issueInput(issue, repo) {
  const names = (issue.labels ?? [])
    .map((l) => (typeof l === 'string' ? l : (l.name ?? '')).trim().toLowerCase())
    .filter(Boolean);
  const labelIds = [
    ...new Set(
      names.map((n) => PEN.labels[/** @type {keyof typeof PEN.labels} */ (n)]).filter(Boolean),
    ),
  ];
  const priorities = names.map((n) => PRIORITY[n]).filter((p) => p !== undefined);
  const title = issue.title.trim() || `GitHub issue #${issue.number}`;
  let body = (issue.body ?? '').trim();
  if (body.length > MAX_BODY) body = `${body.slice(0, MAX_BODY)}\n\n…(cut; the rest is on GitHub)`;
  const by = issue.user?.login ? ` by \`${issue.user.login}\`` : '';
  const header = `From GitHub: [${repo}#${issue.number}](${issue.html_url})${by}. Reply there; this copy doesn't sync.`;
  return {
    teamId: PEN.teamId,
    stateId: PEN.triageStateId,
    title: title.length > MAX_TITLE ? `${title.slice(0, MAX_TITLE - 1)}…` : title,
    description: body ? `${header}\n\n---\n\n${body}` : header,
    labelIds,
    ...(priorities.length ? { priority: Math.min(...priorities) } : {}),
  };
}

/**
 * One GraphQL call to Linear.
 * @param {string} key
 * @param {string} query
 * @param {Record<string, unknown>} variables
 * @param {typeof fetch} [fetcher]
 */
export async function linear(key, query, variables, fetcher = fetch) {
  const res = await fetcher(LINEAR_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: key },
    body: JSON.stringify({ query, variables }),
  });
  /** @type {{ data?: any; errors?: { message: string }[] }} */
  const json = /** @type {any} */ (await res.json().catch(() => ({})));
  if (!res.ok || json.errors?.length) {
    const why = json.errors?.map((e) => e.message).join('; ') || `HTTP ${res.status}`;
    throw new Error(`Linear API: ${why}`);
  }
  return json.data;
}

const FIND = `query Find($url: String!) {
  attachmentsForURL(url: $url) { nodes { issue { identifier } } }
}`;
const CREATE = `mutation Create($input: IssueCreateInput!) {
  issueCreate(input: $input) { success issue { id identifier url } }
}`;
const LINK = `mutation Link($input: AttachmentCreateInput!) {
  attachmentCreate(input: $input) { success }
}`;

/**
 * Files the issue in PEN Triage unless a PEN issue already links to it (a re-run).
 * @param {{ issue: GitHubIssue; repo: string; key: string; fetcher?: typeof fetch }} args
 * @returns {Promise<{ identifier: string; created: boolean }>}
 */
export async function intake({ issue, repo, key, fetcher = fetch }) {
  const found = await linear(key, FIND, { url: issue.html_url }, fetcher);
  const existing = found?.attachmentsForURL?.nodes?.find(
    (/** @type {any} */ n) => n?.issue?.identifier,
  );
  if (existing) return { identifier: existing.issue.identifier, created: false };

  const made = await linear(key, CREATE, { input: issueInput(issue, repo) }, fetcher);
  const created = made?.issueCreate?.issue;
  if (!made?.issueCreate?.success || !created) throw new Error('Linear API: issueCreate failed');
  await linear(
    key,
    LINK,
    {
      input: {
        issueId: created.id,
        url: issue.html_url,
        title: `GitHub ${repo}#${issue.number}`,
      },
    },
    fetcher,
  );
  return { identifier: created.identifier, created: true };
}

async function main() {
  const key = process.env.LINEAR_API_KEY;
  const eventPath = process.env.GITHUB_EVENT_PATH;
  const repo = process.env.GITHUB_REPOSITORY ?? 'htxryan/penmoss';
  if (!key) throw new Error('LINEAR_API_KEY is not set');
  if (!eventPath) throw new Error('GITHUB_EVENT_PATH is not set');
  const event = JSON.parse(readFileSync(eventPath, 'utf8'));
  if (!event.issue || event.issue.pull_request) {
    console.log('Not an issue; nothing to do.');
    return;
  }
  const { identifier, created } = await intake({ issue: event.issue, repo, key });
  console.log(
    created
      ? `Filed ${repo}#${event.issue.number} as ${identifier} in Triage.`
      : `${repo}#${event.issue.number} is already ${identifier}.`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
