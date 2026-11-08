import { describe, expect, it } from 'vitest';
import { checkPlanContract } from '../src/artifact.ts';

const good = `<!doctype html><html><head><style>body{}</style></head><body>
<nav><a href="#spec">Spec</a></nav>
<h2 id="spec">Spec</h2><svg viewBox="0 0 10 10"><rect width="5" height="5"/></svg>
<h2>Acceptance criteria</h2><ol><li>When Ryan opens a nested tag on a phone, the tags panel <b>shall</b> show it collapsed.</li></ol>
<h2>Tasks</h2><ul><li>T1</li></ul></body></html>`;

describe('the plan contract (F16)', () => {
  it('passes a self-contained plan with a nav, a diagram and EARS criteria', () => {
    expect(checkPlanContract(good)).toEqual([]);
  });
  it('refuses anything that loads from the network', () => {
    for (const bad of [
      '<script src="https://cdn.example/x.js"></script>',
      '<link rel="stylesheet" href="//fonts.example/css">',
      '<img src="https://example.com/a.png">',
      '<style>@import url("https://x/y.css");</style>',
      '<style>.a{background:url(https://x/y.png)}</style>',
      '<script>fetch("/x")</script>',
    ])
      expect(checkPlanContract(good.replace('<nav>', `${bad}<nav>`))).toContain(
        'it loads something from the network: inline every script, style, font and image',
      );
  });
  it('allows inline data images and in-page links', () => {
    expect(
      checkPlanContract(good.replace('<nav>', '<img src="data:image/png;base64,AAAA"><nav>')),
    ).toEqual([]);
  });
  it('needs a nav, a rendered diagram and the criteria section', () => {
    const bare = '<h2>Spec</h2><pre class="mermaid">graph TD; A-->B</pre>';
    expect(checkPlanContract(bare)).toEqual([
      'it has no <nav>',
      'it has no rendered diagram (an inline <svg>)',
      'it has no "Acceptance criteria" section',
    ]);
  });
  it('needs criteria in EARS form, not a wish list', () => {
    const vague = good.replace(/<ol>[\s\S]*?<\/ol>/, '<ul><li>Nested tags look nice</li></ul>');
    expect(checkPlanContract(vague)).toEqual([
      'its acceptance criteria are not testable EARS statements ("When …, the … shall …")',
    ]);
  });
});
