'use strict';
/* global document, window, getComputedStyle */
/**
 * The factory's UI audit, which the validator runs on every screen it captures in the web build
 * and in the Mac app (a Playwright `Page` either way), beside its screenshot. It finds, without
 * judgement, the kinds of problem a person reviewing the evidence found by eye on PEN-137:
 *
 * - `title-case`: a button, tab, menu item, heading, legend, summary, table heading, field label
 *   or dialog title not in the app's Title Case (title-case.cjs).
 * - `overflow`: something that sticks out of the box it sits in (a dialog, a fieldset, a group,
 *   a card with a border or its own background) by more than a pixel, or a page wider than its
 *   window.
 * - `unequal-choices`: two or three buttons side by side in one row whose widths differ, where
 *   the design usually wants equal answers. The reviewer decides with the plan whether it matters.
 *
 * Usage in a validator's test (the factory stages this file in the worktree's `.factory/`):
 *
 *   const { createRequire } = require('node:module') // or import it in an ESM spec
 *   const { auditTo } = createRequire(import.meta.url)(`${root}/.factory/ui-audit.cjs`)
 *   await auditTo(page, `${root}/.factory/validation/ac3-audit.json`)
 */
const { writeFileSync, mkdirSync } = require('node:fs');
const { dirname } = require('node:path');
const { titleCaseProblem } = require('./title-case.cjs');

/** What Title Case applies to: the app's titles and clickable labels. */
const TITLED = [
  'button',
  '[role=button]',
  '[role=tab]',
  '[role=menuitem]',
  '[role=menuitemcheckbox]',
  '[role=menuitemradio]',
  'h1',
  'h2',
  'h3',
  'h4',
  'legend',
  'summary',
  'th',
  'label',
  'nav a',
  '[role=dialog] h1, [role=dialog] h2, [role=dialog] h3',
  '[role=alertdialog] h1, [role=alertdialog] h2, [role=alertdialog] h3',
].join(', ');

/** Runs in the page: collects labels, boxes that overflow, and rows of unequal buttons. */
/* c8 ignore start */
function collect(selector) {
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    const s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0;
  };
  const name = (el) => {
    const id = el.getAttribute('data-testid') || el.getAttribute('data-setting') || el.id;
    const label = (el.getAttribute('aria-label') || el.textContent || '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 60);
    const role = el.getAttribute('role');
    return `${el.tagName.toLowerCase()}${role ? `[role=${role}]` : ''}${id ? `#${id}` : ''}${label ? ` "${label}"` : ''}`;
  };
  // The text a person reads as the label: the element's own first line, without what a nested
  // control (a switch inside a label, a badge) adds.
  const ownText = (el) => {
    const clone = el.cloneNode(true);
    for (const n of clone.querySelectorAll(
      'input, select, textarea, [role=switch], [aria-hidden=true], .badge, kbd, code, svg',
    ))
      n.remove();
    return (clone.innerText ?? clone.textContent ?? '').split('\n')[0].replace(/\s+/g, ' ').trim();
  };
  const labels = [];
  for (const el of document.querySelectorAll(selector)) {
    if (!visible(el)) continue;
    const text = ownText(el);
    if (text) labels.push({ text, where: name(el) });
  }

  const isBox = (el) => {
    if (el === document.body || el === document.documentElement) return false;
    const tag = el.tagName.toLowerCase();
    if (['dialog', 'fieldset'].includes(tag)) return true;
    const role = el.getAttribute('role');
    if (['dialog', 'alertdialog', 'group', 'region'].includes(role)) return true;
    const s = getComputedStyle(el);
    const border = ['Top', 'Right', 'Bottom', 'Left'].some(
      (side) =>
        parseFloat(s[`border${side}Width`]) > 0 &&
        s[`border${side}Style`] !== 'none' &&
        !/rgba\(.*,\s*0\)$/.test(s[`border${side}Color`]),
    );
    const parentBg = el.parentElement ? getComputedStyle(el.parentElement).backgroundColor : '';
    const ownBg =
      s.backgroundColor &&
      !/rgba\(.*,\s*0\)$/.test(s.backgroundColor) &&
      s.backgroundColor !== 'transparent' &&
      s.backgroundColor !== parentBg;
    return border || (ownBg && parseFloat(s.borderTopLeftRadius) > 0);
  };
  const scrolls = (el) => /(auto|scroll)/.test(getComputedStyle(el).overflowX);
  const overflow = [];
  for (const el of document.body.querySelectorAll('*')) {
    if (!visible(el) || getComputedStyle(el).position === 'fixed') continue;
    let box = el.parentElement;
    while (box && !isBox(box)) box = box.parentElement;
    if (!box || scrolls(box)) continue;
    const r = el.getBoundingClientRect();
    const b = box.getBoundingClientRect();
    const out = Math.max(b.left - r.left, r.right - b.right);
    if (out > 1.5) {
      // One finding per box: its widest offender.
      const key = name(box);
      const prev = overflow.find((o) => o.box === key);
      if (prev && prev.by >= out) continue;
      if (prev) overflow.splice(overflow.indexOf(prev), 1);
      overflow.push({ where: name(el), box: key, by: Math.round(out) });
    }
  }
  const pageWider = document.documentElement.scrollWidth - window.innerWidth;

  const rows = [];
  const parents = new Set(
    [...document.querySelectorAll('button, [role=button]')]
      .filter(visible)
      .map((b) => b.parentElement),
  );
  for (const parent of parents) {
    if (!parent) continue;
    const buttons = [...parent.children].filter(
      (c) => visible(c) && (c.tagName === 'BUTTON' || c.getAttribute('role') === 'button'),
    );
    if (buttons.length < 2 || buttons.length > 3) continue;
    const rects = buttons.map((b) => b.getBoundingClientRect());
    if (rects.some((r) => Math.abs(r.top - rects[0].top) > 4)) continue;
    const widths = rects.map((r) => Math.round(r.width));
    const spread = Math.max(...widths) - Math.min(...widths);
    if (spread > 4 && spread / Math.max(...widths) > 0.05)
      rows.push({ buttons: buttons.map(name), widths });
  }
  return { labels, overflow, pageWider, rows };
}
/* c8 ignore stop */

/** Audits the page as it is now; returns the findings, worst first. */
async function audit(page) {
  const found = await page.evaluate(collect, TITLED);
  const findings = [];
  for (const o of found.overflow)
    findings.push({
      kind: 'overflow',
      where: o.where,
      detail: `sticks out of ${o.box} by ${o.by} px`,
    });
  if (found.pageWider > 1)
    findings.push({
      kind: 'overflow',
      where: 'the page',
      detail: `is ${found.pageWider} px wider than the window (sideways scrolling)`,
    });
  const titled = new Set();
  for (const l of found.labels) {
    const problem = titleCaseProblem(l.text);
    if (!problem || titled.has(problem.text)) continue;
    titled.add(problem.text);
    findings.push({
      kind: 'title-case',
      where: l.where,
      detail: `"${problem.text}" should read "${problem.suggestion}"`,
    });
  }
  for (const r of found.rows)
    findings.push({
      kind: 'unequal-choices',
      where: r.buttons.join(' | '),
      detail: `buttons side by side with widths ${r.widths.join(' / ')} px`,
    });
  return { url: page.url(), viewport: page.viewportSize(), findings };
}

/** Audits the page and writes the result as JSON beside the screenshot. */
async function auditTo(page, file) {
  const result = await audit(page);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(result, null, 2)}\n`);
  return result;
}

module.exports = { audit, auditTo, collect, TITLED };
