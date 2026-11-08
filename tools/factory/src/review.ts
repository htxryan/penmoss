/**
 * The review loop's inputs (F11, #275): what Ryan has said on a PR since the factory's last
 * round, and whether it's time to act on it. A round starts when he submits a review, or when
 * he has commented and then added nothing for `review.commentQuietMinutes`. Approval (F9) is
 * read here too. Comments from anyone but him are carried as untrusted data (R14).
 */
import type { Gh } from './github.ts';

export interface ThreadComment {
  readonly id: string;
  readonly author: string;
  readonly body: string;
  readonly createdAt: string;
}

export interface ReviewThread {
  readonly id: string;
  readonly isResolved: boolean;
  readonly path: string | null;
  readonly line: number | null;
  readonly comments: readonly ThreadComment[];
}

export interface Review {
  readonly author: string;
  readonly state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED' | 'PENDING';
  readonly body: string;
  readonly submittedAt: string;
}

export interface PrConversation {
  readonly threads: readonly ReviewThread[];
  readonly reviews: readonly Review[];
  /** General PR comments (the conversation tab). */
  readonly comments: readonly ThreadComment[];
  /** When the factory last finished a round (its last marker comment), or the PR opened. */
  readonly since: string;
}

export interface RoundItem {
  readonly kind: 'thread' | 'comment' | 'review';
  /** A review thread's ID, to reply to and resolve. */
  readonly threadId?: string;
  readonly path?: string;
  readonly line?: number;
  readonly author: string;
  readonly body: string;
  readonly trusted: boolean;
}

export type ReviewState =
  | { readonly kind: 'approved'; readonly at: string }
  | {
      readonly kind: 'round';
      readonly trigger: 'review' | 'quiet';
      readonly items: readonly RoundItem[];
    }
  | { readonly kind: 'waiting'; readonly reason: string };

const after = (a: string, b: string) => Date.parse(a) > Date.parse(b);

export function reviewState(
  c: PrConversation,
  owner: string,
  factory: string,
  now: Date,
  quietMinutes: number,
): ReviewState {
  const items: RoundItem[] = [];
  let latest = c.since;
  const note = (at: string) => {
    if (after(at, latest)) latest = at;
  };
  for (const t of c.threads) {
    if (t.isResolved) continue;
    // A thread needs a round when its last word is someone else's, new since the last round.
    const last = t.comments.at(-1);
    if (!last || last.author === factory || !after(last.createdAt, c.since)) continue;
    const words = t.comments.filter((x) => x.author !== factory && after(x.createdAt, c.since));
    for (const x of words) {
      note(x.createdAt);
      items.push({
        kind: 'thread',
        threadId: t.id,
        ...(t.path ? { path: t.path } : {}),
        ...(t.line ? { line: t.line } : {}),
        author: x.author,
        body: x.body,
        trusted: x.author === owner,
      });
    }
  }
  for (const x of c.comments) {
    if (x.author === factory || !after(x.createdAt, c.since)) continue;
    note(x.createdAt);
    items.push({ kind: 'comment', author: x.author, body: x.body, trusted: x.author === owner });
  }
  const reviews = c.reviews.filter((r) => r.author === owner && after(r.submittedAt, c.since));
  const approval = reviews.filter((r) => r.state === 'APPROVED').at(-1);
  for (const r of reviews)
    if (r.body.trim())
      items.push({ kind: 'review', author: r.author, body: r.body, trusted: true });

  // Approval with nothing left to address merges (F9); anything else Ryan said comes first.
  const ownerItems = items.filter((i) => i.trusted);
  if (approval && ownerItems.every((i) => i.kind === 'review'))
    return { kind: 'approved', at: approval.submittedAt };
  if (ownerItems.length === 0)
    return {
      kind: 'waiting',
      reason: items.length
        ? 'only comments from others, which never start a round'
        : 'nothing new from Ryan',
    };
  if (reviews.some((r) => r.state !== 'PENDING'))
    return { kind: 'round', trigger: 'review', items };
  const quietFor = (now.getTime() - Date.parse(latest)) / 60_000;
  if (quietFor >= quietMinutes) return { kind: 'round', trigger: 'quiet', items };
  return {
    kind: 'waiting',
    reason: `Ryan commented ${quietFor.toFixed(1)} min ago; waiting for ${quietMinutes} quiet minutes`,
  };
}

const CONVERSATION = `
query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      createdAt
      reviewThreads(first: 100) {
        nodes { id isResolved path line comments(first: 50) { nodes { id body createdAt author { login } } } }
      }
      reviews(last: 50) { nodes { state body submittedAt author { login } } }
      comments(last: 100) { nodes { id body createdAt author { login } } }
    }
  }
}`;

interface RawComment {
  readonly id: string;
  readonly body: string;
  readonly createdAt: string;
  readonly author: { readonly login: string } | null;
}

/** The PR's threads, reviews and comments, with `since` = the factory's last marker comment. */
export async function readConversation(
  gh: Gh,
  repo: string,
  number: number,
  marker: string,
): Promise<PrConversation> {
  const [owner = '', name = ''] = repo.split('/');
  const data = await gh.graphql<{
    repository: {
      pullRequest: {
        createdAt: string;
        reviewThreads: {
          nodes: {
            id: string;
            isResolved: boolean;
            path: string | null;
            line: number | null;
            comments: { nodes: RawComment[] };
          }[];
        };
        reviews: {
          nodes: {
            state: Review['state'];
            body: string;
            submittedAt: string | null;
            author: { login: string } | null;
          }[];
        };
        comments: { nodes: RawComment[] };
      };
    };
  }>(CONVERSATION, { owner, repo: name, number });
  const pr = data.repository.pullRequest;
  const plain = (x: RawComment): ThreadComment => ({
    id: x.id,
    author: x.author?.login ?? '',
    body: x.body,
    createdAt: x.createdAt,
  });
  const comments = pr.comments.nodes.map(plain);
  const since = comments.filter((x) => x.body.includes(marker)).at(-1)?.createdAt ?? pr.createdAt;
  return {
    since,
    comments: comments.filter((x) => !x.body.includes(marker)),
    threads: pr.reviewThreads.nodes.map((t) => ({
      id: t.id,
      isResolved: t.isResolved,
      path: t.path,
      line: t.line,
      comments: t.comments.nodes.map(plain),
    })),
    reviews: pr.reviews.nodes
      .filter((r) => r.submittedAt)
      .map((r) => ({
        author: r.author?.login ?? '',
        state: r.state,
        body: r.body,
        submittedAt: r.submittedAt ?? '',
      })),
  };
}

/** The round's items for the review prompt: Ryan's as they are, everyone else's fenced. */
export function roundText(
  items: readonly RoundItem[],
  fence: (author: string, text: string) => string,
): string {
  return items
    .map((i, n) => {
      const where =
        i.kind === 'thread'
          ? `Review thread ${i.threadId}${i.path ? ` on \`${i.path}${i.line ? `:${i.line}` : ''}\`` : ''}`
          : i.kind === 'review'
            ? 'Review summary'
            : 'PR comment';
      return `### ${n + 1}. ${where}\n\n${i.trusted ? i.body : fence(i.author, i.body)}`;
    })
    .join('\n\n');
}
