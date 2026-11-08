/**
 * An issue as a prompt sees it. Only Ryan's words are instructions (R14): the body of an
 * issue someone else opened, and every comment not by him, are fenced as untrusted data.
 */
import type { Gh } from './github.ts';

export interface IssueComment {
  /** Who wrote it, as the tracker identifies people: a GitHub login or a Linear user ID. */
  readonly author: string;
  /** The name to show, when `author` is an ID. */
  readonly authorName?: string;
  readonly body: string;
  readonly createdAt: string;
}

export interface Issue {
  readonly number: number;
  /** `#36` or `PEN-36`; `#<number>` when absent. */
  readonly key?: string;
  readonly title: string;
  readonly body: string;
  readonly author: string;
  readonly authorName?: string;
  /** The body came from outside whoever filed it, such as the GitHub intake into Linear: fenced. */
  readonly external?: boolean;
  readonly url: string;
  readonly labels: readonly string[];
  readonly comments: readonly IssueComment[];
}

interface RawIssue {
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly url: string;
  readonly author: { readonly login: string } | null;
  readonly labels: readonly { readonly name: string }[];
  readonly comments: readonly {
    readonly author: { readonly login: string } | null;
    readonly body: string;
    readonly createdAt: string;
  }[];
}

export async function readIssue(gh: Gh, repo: string, number: number): Promise<Issue> {
  const raw = await gh.json<RawIssue>([
    'issue',
    'view',
    String(number),
    '--repo',
    repo,
    '--json',
    'number,title,body,url,author,labels,comments',
  ]);
  return {
    number: raw.number,
    key: `#${raw.number}`,
    title: raw.title,
    body: raw.body,
    url: raw.url,
    author: raw.author?.login ?? '',
    labels: raw.labels.map((l) => l.name),
    comments: raw.comments.map((c) => ({
      author: c.author?.login ?? '',
      body: c.body,
      createdAt: c.createdAt,
    })),
  };
}

/** Text from anyone but the owner, fenced so it reads as data. A forged closing tag is defused. */
export function fence(author: string, text: string): string {
  const safe = text.replaceAll(/<\/?untrusted\b[^>]*>/gi, (tag) => tag.replace('<', '&lt;'));
  return `<untrusted author="${author.replaceAll(/[^\w.-]/g, '')}">\n${safe}\n</untrusted>`;
}

/** The issue's words for a prompt: the owner's as they are, everyone else's fenced. */
export function issueText(issue: Issue, owner: string, ownMarker: string): string {
  const trusted = (author: string) => author === owner;
  const parts = [
    `# ${issue.key ?? `#${issue.number}`} ${issue.title}`,
    trusted(issue.author) && !issue.external
      ? issue.body
      : fence(issue.authorName ?? issue.author, issue.body),
  ];
  // The factory's own comments (with its marker) are its status notes, not instructions.
  const comments = issue.comments.filter((c) => !c.body.includes(ownMarker));
  if (comments.length > 0) {
    parts.push('## Comments');
    for (const c of comments) {
      parts.push(
        trusted(c.author)
          ? `**${c.authorName ?? c.author}** (${c.createdAt}):\n${c.body}`
          : fence(c.authorName ?? c.author, c.body),
      );
    }
  }
  return parts.join('\n\n');
}
