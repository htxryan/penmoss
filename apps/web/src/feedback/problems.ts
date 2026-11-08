/** What Send feedback's form must have before it is sent (T49). */
import {
  feedbackIssueBody,
  FEEDBACK_LIMITS,
  type FeedbackClient,
  type FeedbackContext,
  type FeedbackPriority,
  type FeedbackType,
} from '@penmoss/core/feedback';

export interface Problems {
  readonly type?: string;
  readonly priority?: string;
  readonly title?: string;
  /** The description too long, or the whole report too long for an issue. */
  readonly description?: string;
}

export function problemsOf(form: {
  type: FeedbackType | null;
  priority: FeedbackPriority | null;
  title: string;
}): Problems {
  const problems: { type?: string; priority?: string; title?: string } = {};
  if (!form.type) problems.type = 'Choose Bug report or Feature request.';
  if (!form.priority) problems.priority = 'Choose a priority.';
  const title = form.title.trim();
  if (!title) problems.title = 'Give it a title.';
  else if (title.length > FEEDBACK_LIMITS.titleMax) {
    problems.title = `Keep the title to ${FEEDBACK_LIMITS.titleMax} characters.`;
  }
  return problems;
}

/** GitHub's limit on an issue body (the Worker refuses a longer one). */
export const ISSUE_BODY_MAX = 65_536;
/** The longest address an attachment gets. */
const LONGEST_ASSET_URL = `https://github.com/user-attachments/assets/${'0'.repeat(36)}`;

/**
 * Why the report is too long to file, or null: a description over the Worker's limit, or an
 * issue body (description, screenshots, context, footer) over GitHub's. Checked before it is
 * queued, so the server never refuses it for its length (a refusal that cannot pass).
 */
export function sizeProblem(report: {
  readonly markdown: string;
  readonly context: FeedbackContext;
  readonly screenshots: number;
  readonly client: FeedbackClient;
  readonly version: string;
  readonly submissionId: string;
}): string | null {
  const max = FEEDBACK_LIMITS.descriptionMax;
  if (report.markdown.length > max) {
    return `Keep the description to ${max.toLocaleString('en-US')} characters of markdown (it has ${report.markdown.length.toLocaleString('en-US')}).`;
  }
  const body = feedbackIssueBody({
    description: report.markdown,
    screenshots: Array.from({ length: report.screenshots }, (_, index) => ({
      name: `screenshot-${index + 1}.jpg`,
      url: LONGEST_ASSET_URL,
    })),
    context: report.context,
    client: report.client,
    version: report.version,
    submissionId: report.submissionId,
  });
  if (body.length > ISSUE_BODY_MAX) {
    return 'The report is longer than a GitHub issue allows: shorten the description or leave out a context group.';
  }
  return null;
}
