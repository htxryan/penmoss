import { RuleTester } from 'eslint';
import tseslint from 'typescript-eslint';
import { describe, it } from 'vitest';
import { trackedControl } from '../lint/tracked-control.js';

// PEN-137 ac15: a clickable control without a command or an event id fails the check, naming it.
// PEN-175 ac2: so does a select, a slider, every link, the roles option, treeitem and slider, a
// short data-untracked reason, and each call of the app's wrappers without its id.
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
const wrapper = { messageId: 'wrapper' } as const;
const reason = { messageId: 'reason' } as const;

// The app's wrappers, as eslint.config.js lists them (PEN-175).
const options = [
  {
    wrappers: [
      { name: 'Menu', props: ['data-event'] },
      { name: 'MenuItem', props: ['data-event', 'data-command'] },
      { name: 'Switch', props: ['data-event'] },
      { name: 'SectionHead', props: ['data-event'] },
      { name: 'ActionToast', props: ['data-event'] },
      { name: 'Select', props: ['data-event', 'data-command'] },
      { name: 'Action', props: ['data-event'] },
      { name: 'LinkButton', props: ['data-event'] },
      { name: 'Options', props: ['event'], items: 'items' },
    ],
  },
];

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
    // Not controls: a text field, an element without an interactive role, a component that is
    // not a wrapper (its own <button> is checked where it is written).
    '<input type="text" onChange={type} />;',
    '<div className="overlay" onMouseDown={close} />;',
    '<IconButton onClick={go} />;',
    '<Menu.Item onClick={go} />;',
    // A role from a spread is not known here.
    '<div {...picker.optionProps(0)} onClick={choose} />;',
    // PEN-175: a select, a slider, every link, and the roles option, treeitem, slider and link,
    // each with its own id.
    '<select data-event="search.filter.tag" onChange={pick} />;',
    '<input type="range" data-event="time-machine.scrub" onChange={scrub} />;',
    '<a href="https://penmoss.app/privacy" data-event="privacy.policy">Privacy Policy</a>;',
    '<div role="option" data-event="icon-picker.icon" onClick={choose} />;',
    '<div role="treeitem" data-event="tree.open" />;',
    '<div role="slider" data-event="colour-picker.wheel" onPointerDown={drag} />;',
    '<span role="link" data-event="note.breadcrumb" onClick={go} />;',
    // A role picked between literals, each one with the id.
    "<div role={radio ? 'menuitemradio' : 'menuitem'} data-event=\"tree.sort-order.choose\" />;",
    // A native input's id may sit on the <label> around it.
    '<label data-event="firstrun.folder"><input type="radio" name="f" /> Root</label>;',
    // Not a control a person uses, saying why in three words or more.
    '<a href={path} data-untracked="its row is the control">Note</a>;',
    '<div role="option" data-untracked="the empty list\'s words, never picked" />;',
    "<button data-untracked={'a drag handle, no click'} {...handle} />;",
    // The wrappers, each given its own id (or a command, where it takes one).
    { code: '<Menu label="Note Actions" data-event="note.actions.open" />;', options },
    { code: '<MenuItem icon="trash" data-event="note.menu.trash" />;', options },
    { code: '<MenuItem icon="find" data-command="note.find" />;', options },
    { code: '<Switch checked={on} data-event="settings.dad-jokes" />;', options },
    { code: '<SectionHead name="Tags" data-event="sidebar.tags.toggle" />;', options },
    { code: '<ActionToast tone="info" data-event="toast.trashed.dismiss" />;', options },
    { code: '<Select value={v} data-event="graph.depth" />;', options },
    { code: '<Action primary data-event="firstrun.continue">Continue</Action>;', options },
    { code: '<LinkButton data-event="firstrun.list.refresh" onClick={go} />;', options },
    {
      code: "<Options items={[{ value: 'a', title: 'A', event: 'firstrun.way.paste-a-url' }]} />;",
      options,
    },
    // Items from elsewhere: their type makes each name its id.
    { code: '<Options items={ITEMS} />;', options },
    // Without the option, a component is never a wrapper.
    '<Switch checked={on} />;',
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
    // PEN-175: a select, a slider, every link (a plain one too), and the roles option, treeitem,
    // slider and link, with or without a click handler.
    { code: '<select value={v} onChange={pick} />;', errors: [untracked] },
    { code: '<input type="range" min={0} max={9} />;', errors: [untracked] },
    { code: '<a href="https://penmoss.app/privacy">Privacy Policy</a>;', errors: [untracked] },
    { code: '<a href={url} target="_blank" rel="noreferrer">Open</a>;', errors: [untracked] },
    { code: '<div role="option" onClick={choose} />;', errors: [untracked] },
    { code: '<div role="option" aria-selected={false} />;', errors: [untracked] },
    { code: '<div role="treeitem" aria-level={1} />;', errors: [untracked] },
    { code: '<div role="slider" onPointerDown={drag} />;', errors: [untracked] },
    { code: '<span role="link" onClick={go} />;', errors: [untracked] },
    { code: "<li role={on ? 'menuitemradio' : 'menuitem'} />;", errors: [untracked] },
    // A label without an id doesn't stand in for the input's.
    { code: '<label><input type="checkbox" /> Show</label>;', errors: [untracked] },
    // data-untracked needs a reason of three words or more, written out.
    { code: '<a href={path} data-untracked="row link">Note</a>;', errors: [reason] },
    { code: '<button data-untracked="" onClick={go} />;', errors: [reason] },
    { code: '<div role="option" data-untracked={why} />;', errors: [reason] },
    // Each wrapper without its id.
    { code: '<Menu label="Note Actions" icon="more" />;', options, errors: [wrapper] },
    { code: '<MenuItem icon="trash" onClick={go} />;', options, errors: [wrapper] },
    { code: '<Switch checked={on} onChange={flip} />;', options, errors: [wrapper] },
    { code: '<SectionHead name="Tags" onToggle={flip} />;', options, errors: [wrapper] },
    { code: '<ActionToast tone="info" onDismiss={close} />;', options, errors: [wrapper] },
    { code: '<Select value={v} onChange={pick} />;', options, errors: [wrapper] },
    { code: '<Action primary onClick={go}>Continue</Action>;', options, errors: [wrapper] },
    { code: '<LinkButton onClick={go}>Refresh</LinkButton>;', options, errors: [wrapper] },
    // A spread never stands in for a wrapper's id either.
    { code: '<Switch {...props} />;', options, errors: [wrapper] },
    {
      code: "<Options items={[{ value: 'a', event: 'firstrun.way.paste-a-url' }, { value: 'b' }]} />;",
      options,
      errors: [{ messageId: 'item' }],
    },
  ],
});
