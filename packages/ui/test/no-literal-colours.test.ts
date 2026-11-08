import { RuleTester } from 'eslint';
import tseslint from 'typescript-eslint';
import { describe, it } from 'vitest';
import { noLiteralColours } from '../lint/no-literal-colours.js';

// T28 acceptance: "all UI colours come from tokens (lint rule forbids literal colours)".
RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const tester = new RuleTester({
  languageOptions: {
    parser: tseslint.parser,
    parserOptions: { ecmaFeatures: { jsx: true } },
  },
});

const error = { messageId: 'literal' } as const;

tester.run('no-literal-colours', noLiteralColours, {
  valid: [
    // Tokens, derived tokens and keywords are fine.
    "const a = <div style={{ color: 'var(--pm-muted)', background: 'transparent' }} />;",
    "const b = <div style={{ borderColor: 'currentColor', outlineColor: 'CanvasText' }} />;",
    "el.style.color = 'var(--pm-fg)';",
    "el.style.setProperty('--depth', '3');",
    "const mixed = 'color-mix(in oklab, var(--pm-accent) 14%, transparent)';",
    // Strings that only look like colours outside a style: tags, anchors, ids.
    "const tag = '#garden';",
    "const issue = 'see issue #12';",
    "const anchor = <a href='#notes'>Notes</a>;",
    // Named colours are only colours in a style.
    "const label = 'red';",
    "const css = { whiteSpace: 'nowrap' };",
    // A hex-looking fragment in a link, a path or an anchor is not a colour.
    "const link = <a href='#abc'>Top</a>;",
    "el.setAttribute('href', '#beef');",
    "const url = 'https://example.com/page#fade';",
    "const path = '/notes/01ABC#add';",
    // Colour words outside colours: a label, an option, a non-colour attribute.
    "const option = { label: 'white', value: 'white' };",
    "const icon = <svg aria-label='black cat' />;",
    "const svg = <path fill='currentColor' stroke='var(--pm-accent)' />;",
    "chart.attr('class', 'red');",
  ],
  invalid: [
    { code: "const bg = '#fbfaf7';", errors: [error] },
    { code: "const short = '#fff';", errors: [error] },
    { code: 'const t = `#3f7d4e`;', errors: [error] },
    { code: "const shadow = '0 1px 2px rgb(0 0 0 / 10%)';", errors: [error] },
    { code: "const c = 'hsl(120deg 40% 50%)';", errors: [error] },
    { code: "const c = 'oklch(70% 0.1 150)';", errors: [error] },
    { code: "const a = <div style={{ color: 'white' }} />;", errors: [error] },
    { code: "const a = <div style={{ border: '1px solid #ccc' }} />;", errors: [error] },
    { code: 'const a = <div style={{ boxShadow: `0 0 0 1px ${x} black` }} />;', errors: [error] },
    { code: "el.style.color = 'black';", errors: [error] },
    { code: "el.style.borderColor = '#123456';", errors: [error] },
    { code: "el.style.setProperty('--pm-bg', 'rebeccapurple');", errors: [error] },
    { code: "el.style.cssText = 'color: navy';", errors: [error] },
    { code: "ctx.fillStyle = 'red';", errors: [error] },
    // The T28 review's probe cases.
    { code: "const p = <path fill='#3f7d4e' stroke='white' />;", errors: [error, error] },
    { code: "const p = <path fill={'red'} />;", errors: [error] },
    { code: 'const p = <stop stopColor={`#abcdef`} />;', errors: [error] },
    { code: "const p = <stop stop-color='navy' />;", errors: [error] },
    { code: "const f = <feFlood floodColor='black' />;", errors: [error] },
    { code: "const t = <text color='white'>x</text>;", errors: [error] },
    { code: "selection.attr('stroke', 'steelblue');", errors: [error] },
    { code: "selection.style('fill', 'navy');", errors: [error] },
    { code: "el.setAttribute('fill', 'black');", errors: [error] },
    { code: "const border = '1px solid #ccc';", errors: [error] },
    { code: 'const css = `.x{color:#fff}`;', errors: [error] },
    { code: 'const css = `.x { color: white; }`;', errors: [error] },
    { code: "ctx['fillStyle'] = 'red';", errors: [error] },
    {
      code: "mermaid.initialize({ themeVariables: { primaryColor: 'white', mainBkg: 'navy' } });",
      errors: [error, error],
    },
    { code: "const s = { color: 'white' }; const a = <div style={s} />;", errors: [error] },
    {
      code: "const s = { backgroundColor: 'black', borderColor: 'gray' };",
      errors: [error, error],
    },
  ],
});
