import { describe, expect, it } from 'vitest';
import { branchName, prTitle, shortenTitle, TITLE_MAX } from '../src/pr-title.ts';
import { item } from './helpers.ts';
import { config } from './run-fake.ts';

describe('branchName', () => {
  it('names the branch from the issue', () => {
    expect(
      branchName(config, item(7, { title: '  Ünïcode & "quotes": the Settings → Status page!' })),
    ).toBe('factory/7-n-code-quotes-the-settings-status');
    expect(branchName(config, item(8, { title: '!!!' }))).toBe('factory/8-issue');
  });
});

describe('prTitle', () => {
  // PEN-75's PR title was the agent's whole 150-character summary.
  const summary =
    'Linked "Ryan Henderson" in the brochure footer to https://ryanhenderson.dev, styled the footer link to inherit its colour with the accent on hover, and covered it with a site Playwright test';

  it('is the commit subject, with the card named nowhere in it', () => {
    for (const subject of [
      'Site: link Ryan Henderson in the footer to ryanhenderson.dev (PEN-75)',
      'PEN-75: Site: link Ryan Henderson in the footer to ryanhenderson.dev',
      'Site: link Ryan Henderson in the footer to ryanhenderson.dev [pen-75]',
    ])
      expect(prTitle({ subject, summary, key: 'PEN-75' })).toBe(
        'Site: link Ryan Henderson in the footer to ryanhenderson.dev',
      );
  });

  it("falls back to the summary's first sentence, cut at a word to 72 characters", () => {
    const title = prTitle({ summary, key: 'PEN-75' });
    expect(title.length).toBeLessThanOrEqual(TITLE_MAX);
    // No ellipsis, and no dangling "to".
    expect(title).toBe('Linked "Ryan Henderson" in the brochure footer');
    expect(prTitle({ summary: 'Fix the typo. Also tidied PEN-9.', key: 'PEN-9' })).toBe(
      'Fix the typo',
    );
    // The numbering commit is the host's, never the change's title.
    expect(
      prTitle({ subject: 'Number the new decisions: A1236 is A1240', summary, key: 'PEN-75' }),
    ).toBe(title);
  });

  it('cuts a long subject too, and leaves an unrelated id alone', () => {
    const long = `Desktop: ${'make the sidebar remember its width '.repeat(3)}`;
    const title = prTitle({ subject: long, summary, key: 'PEN-1' });
    expect(title.length).toBeLessThanOrEqual(TITLE_MAX);
    expect(title).toBe('Desktop: make the sidebar remember its width make the sidebar remember');
    expect(prTitle({ subject: 'Fix #12 and SPEC-3', summary, key: '#12' })).toBe(
      'Fix #12 and SPEC-3',
    );
  });

  it('cuts a long title before a clause, never mid-phrase with an ellipsis', () => {
    // PEN-121's PR was "Mac: agents' MCP servers run from Penmoss CLI.app, so opening Penmoss…".
    expect(
      prTitle({
        subject:
          "Mac: agents' MCP servers run from Penmoss CLI.app, so opening Penmoss no longer steals focus",
        summary,
        key: 'PEN-121',
      }),
    ).toBe("Mac: agents' MCP servers run from Penmoss CLI.app");
    const cuts: [string, string][] = [
      [
        'Factory: the updater ignores tests and docs; only runtime changes restart the daemon now',
        'Factory: the updater ignores tests and docs',
      ],
      [
        'Web: the search box keeps its query when you switch notebooks: it was cleared every time',
        'Web: the search box keeps its query when you switch notebooks',
      ],
      [
        'Android: the editor keeps the cursor at the line end after pasting, the toolbar too',
        'Android: the editor keeps the cursor at the line end after pasting',
      ],
    ];
    for (const [long, cut] of cuts) {
      const title = shortenTitle(long);
      expect(title).toBe(cut);
      expect(title.length).toBeLessThanOrEqual(TITLE_MAX);
    }
    // The area prefix's colon is never the cut.
    expect(shortenTitle(`Mac: ${'x'.repeat(10)} ${'word '.repeat(20)}`)).toMatch(/^Mac: x+ word/);
  });

  it("uses the agent's own title when it is short and names no card", () => {
    const own = 'Mac: the Dock icon brings back the window minimized last';
    expect(prTitle({ title: own, subject: 'Something else', summary, key: 'PEN-67' })).toBe(own);
    expect(prTitle({ title: `${own}.`, summary, key: 'PEN-67' })).toBe(own);
    // Too long, or naming the card: the commit subject instead.
    for (const title of [`${own} and restores its size and its place`, `${own} (PEN-67)`])
      expect(prTitle({ title, subject: 'Mac: the Dock restores', summary, key: 'PEN-67' })).toBe(
        'Mac: the Dock restores',
      );
  });
});
