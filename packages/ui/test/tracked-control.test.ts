import { RuleTester } from 'eslint';
import tseslint from 'typescript-eslint';
import { describe, it } from 'vitest';
import { trackedControl } from '../lint/tracked-control.js';

// PEN-137 ac15: a clickable control without a command or an event id fails the check, naming it.
RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const tester = new RuleTester({
  languageOptions: {
    parser: tseslint.parser,
    parserOptions: { ecmaFeatures: { jsx: true } },
  },
});

const untracked = { messageId: 'untracked' } as const;

tester.run('tracked-control', trackedControl, {
  valid: [
    // A command's control is counted by its run.
    '<button data-command="app.settings" onClick={open}>Settings</button>;',
    '<a href="/" data-command="app.home" onClick={go}>Home</a>;',
    // A tracked id, written out or picked from literals, or a prop passed on.
    '<button data-event="feedback.logs.preview" onClick={show}>Preview</button>;',
    "<button data-event={on ? 'privacy.share.on' : 'privacy.share.off'} onClick={flip} />;",
    '<button data-event={event} onClick={onClick} />;',
    '<input type="checkbox" data-event="feedback.logs.toggle" onChange={toggle} />;',
    '<summary data-event="feedback.logs.preview">Logs</summary>;',
    '<div role="switch" data-event="privacy.share.on" onClick={flip} />;',
    // Not controls: a plain link, a text field, an element without an interactive role, a
    // component (its own <button> is checked where it is written).
    '<a href="https://penmoss.app/privacy">Privacy Policy</a>;',
    '<input type="text" onChange={type} />;',
    '<div className="overlay" onMouseDown={close} />;',
    '<div role="option" onClick={choose} />;',
    '<IconButton onClick={go} />;',
    '<Menu.Item onClick={go} />;',
    // A role from a spread is not known here.
    '<div {...picker.optionProps(0)} onClick={choose} />;',
  ],
  invalid: [
    { code: '<button onClick={go}>Go</button>;', errors: [untracked] },
    { code: '<button type="submit">Save</button>;', errors: [untracked] },
    { code: '<a href="#" onClick={go}>Go</a>;', errors: [untracked] },
    { code: '<input type="checkbox" checked={on} onChange={flip} />;', errors: [untracked] },
    { code: '<input type={\'radio\'} name="mode" />;', errors: [untracked] },
    { code: '<summary>More</summary>;', errors: [untracked] },
    { code: '<div role="button" onClick={go} />;', errors: [untracked] },
    { code: '<li role="menuitem" onMouseDown={go} />;', errors: [untracked] },
    { code: '<span role="tab" onClick={go} />;', errors: [untracked] },
    { code: '<span role="switch" onPointerDown={go} />;', errors: [untracked] },
    // A spread may carry anything, so it never stands in for an id.
    { code: '<button {...props} />;', errors: [untracked] },
    // Ids are lower case and dotted, and never built from data.
    {
      code: '<button data-event="Feedback.Logs" onClick={go} />;',
      errors: [{ messageId: 'badId' }],
    },
    { code: '<button data-event="feedback" onClick={go} />;', errors: [{ messageId: 'badId' }] },
    {
      code: '<button data-event={`tags.${tag}`} onClick={go} />;',
      errors: [{ messageId: 'built' }],
    },
  ],
});
