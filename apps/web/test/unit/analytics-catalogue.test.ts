/**
 * PEN-137 ac15: every name the page records is in the catalogue, so none is dropped (or built
 * from data). Every command of the registry; every `data-event` id written in the page (as a
 * literal, or as the literals an expression picks between); every screen kind the router's
 * routes map to; every dialog name `useTrackedDialog` is given. The ESLint rule
 * `penmoss/tracked-control` makes sure every control has such an id in the first place.
 */
import {
  CLICK_NAMES,
  COMMAND_NAMES,
  DIALOG_NAMES,
  EVENT_ID_PATTERN,
  RETIRED_CLICK_NAMES,
  SCREEN_NAMES,
  SETTING_NAMES,
} from '@penmoss/core/analytics';
import { DISPLAY_SETTING_KEYS } from '@penmoss/core/display';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { screenKindOf } from '../../src/analytics/track';
import { COMMANDS } from '../../src/commands/definitions';
import { SETTINGS_SECTIONS, type Route } from '../../src/router';

const SOURCE = fileURLToPath(new URL('../../src', import.meta.url));
const ROOT = fileURLToPath(new URL('../../../..', import.meta.url));
const WEB = fileURLToPath(new URL('../..', import.meta.url));
const UI_SOURCE = join(ROOT, 'packages/ui/src');
const EDITOR_SOURCE = join(ROOT, 'packages/editor/src');
const DESKTOP_SOURCE = join(ROOT, 'apps/desktop/src');

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts') ? [path] : [];
  });
}

/** Every string literal an expression may come to (`a ? 'x.on' : 'x.off'`, `'x' ?? 'y'`). */
function literals(node: ts.Node): string[] {
  if (ts.isStringLiteralLike(node)) return [node.text];
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node)) {
    return literals(node.expression);
  }
  if (ts.isConditionalExpression(node)) {
    return [...literals(node.whenTrue), ...literals(node.whenFalse)];
  }
  if (ts.isBinaryExpression(node)) return [...literals(node.left), ...literals(node.right)];
  return [];
}

interface Use {
  readonly name: string;
  readonly where: string;
}

/** Whether `node` is `<x>.dataset['event']` or `<x>.dataset.event`. */
function isDatasetEvent(node: ts.Node): boolean {
  if (ts.isElementAccessExpression(node)) {
    const key = node.argumentExpression;
    return (
      ts.isStringLiteralLike(key) &&
      key.text === 'event' &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'dataset'
    );
  }
  return (
    ts.isPropertyAccessExpression(node) &&
    node.name.text === 'event' &&
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === 'dataset'
  );
}

/** A property's name as written (`event`, `'data-event'`), or null when it is computed. */
function propertyName(node: ts.PropertyAssignment): string | null {
  const { name } = node;
  return ts.isIdentifier(name) || ts.isStringLiteralLike(name) ? name.text : null;
}

/**
 * The `data-event` ids and the dialog names written in the page, the shared components and the
 * editor, with where each is. JSX's `data-event`; and, for controls built with DOM calls (the
 * editor's widgets, PEN-175), `setAttribute('data-event', …)`, `dataset['event'] = …` and an
 * attribute object's `'data-event'`. An editor id set from a spec's field (`action.event`) is
 * that field's literal in the same file (`event: 'editor.table.delete-row'`). `unresolved` lists
 * any DOM-set id that is neither a literal nor such a field, which this test could not check.
 */
function uses(): {
  readonly events: Use[];
  readonly dialogs: Use[];
  readonly unresolved: string[];
} {
  const events: Use[] = [];
  const dialogs: Use[] = [];
  const unresolved: string[] = [];
  for (const dir of [SOURCE, UI_SOURCE, EDITOR_SOURCE]) {
    const editor = dir === EDITOR_SOURCE;
    for (const path of sources(dir)) {
      const text = readFileSync(path, 'utf8');
      if (!/data-event|useTrackedDialog|\['event'\]|\.event\b|\bevent:/.test(text)) continue;
      const file = ts.createSourceFile(
        path,
        text,
        ts.ScriptTarget.Latest,
        true,
        path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
      );
      const where = (node: ts.Node) =>
        `${relative(ROOT, path)}:${file.getLineAndCharacterOfPosition(node.getStart()).line + 1}`;
      const add = (value: ts.Node, at: ts.Node) => {
        const names = literals(value);
        for (const name of names) events.push({ name, where: where(at) });
        const field = ts.isPropertyAccessExpression(value) && value.name.text === 'event';
        if (names.length === 0 && !(editor && field)) {
          unresolved.push(`${value.getText(file)} (${where(at)})`);
        }
      };
      const visit = (node: ts.Node) => {
        if (
          ts.isJsxAttribute(node) &&
          node.name.getText(file) === 'data-event' &&
          node.initializer
        ) {
          const value = ts.isJsxExpression(node.initializer)
            ? node.initializer.expression
            : node.initializer;
          for (const name of value ? literals(value) : []) {
            events.push({ name, where: where(node) });
          }
        }
        if (
          ts.isCallExpression(node) &&
          ts.isPropertyAccessExpression(node.expression) &&
          node.expression.name.text === 'setAttribute' &&
          node.arguments.length === 2 &&
          ts.isStringLiteralLike(node.arguments[0]!) &&
          node.arguments[0].text === 'data-event'
        ) {
          add(node.arguments[1]!, node);
        }
        if (
          ts.isBinaryExpression(node) &&
          node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
          isDatasetEvent(node.left)
        ) {
          add(node.right, node);
        }
        if (ts.isPropertyAssignment(node)) {
          const name = propertyName(node);
          if (name === 'data-event') add(node.initializer, node);
          // An id given as a field: an editor spec's, a first-run choice's (`Options` items) or
          // a note bar button's (PEN-175).
          else if (name === 'event' && ts.isStringLiteralLike(node.initializer)) {
            events.push({ name: node.initializer.text, where: where(node) });
          }
        }
        if (
          ts.isCallExpression(node) &&
          ts.isIdentifier(node.expression) &&
          node.expression.text === 'useTrackedDialog' &&
          node.arguments[0]
        ) {
          for (const name of literals(node.arguments[0])) {
            dialogs.push({ name, where: where(node) });
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(file);
    }
  }
  return { events, dialogs, unresolved };
}

const found = uses();

describe('the analytics catalogue knows every name the page records (PEN-137)', () => {
  it('every command of the registry', () => {
    const missing = COMMANDS.map((command) => command.id).filter(
      (id) => !COMMAND_NAMES.includes(id),
    );
    expect(missing).toEqual([]);
  });

  it('every data-event id, each a dotted id', () => {
    expect(found.events.length).toBeGreaterThan(0);
    const missing = found.events.filter((use) => !CLICK_NAMES.includes(use.name));
    expect(missing.map((use) => `${use.name} (${use.where})`)).toEqual([]);
    const malformed = found.events.filter((use) => !EVENT_ID_PATTERN.test(use.name));
    expect(malformed.map((use) => `${use.name} (${use.where})`)).toEqual([]);
  });

  it("every id the editor's widgets set through the DOM (PEN-175)", () => {
    const editor = found.events.filter((use) => use.where.startsWith('packages/editor/'));
    const names = new Set(editor.map((use) => use.name));
    // The fixed ids both clients record, as a check that the DOM forms are read at all.
    for (const id of ['editor.callout.fold', 'editor.code.copy', 'editor.task.toggle']) {
      expect(names).toContain(id);
    }
    // Table actions, set from each action's `event` field.
    expect(names).toContain('editor.table.delete-table');
    expect(found.unresolved).toEqual([]);
  });

  it('never turns the tracked-control rule off: a control says why with data-untracked (PEN-175)', () => {
    const disabled = [SOURCE, UI_SOURCE, EDITOR_SOURCE].flatMap((dir) =>
      sources(dir).flatMap((path) =>
        readFileSync(path, 'utf8')
          .split('\n')
          .flatMap((line, index) =>
            // Naming the rule, or naming none (which turns every rule off).
            /eslint-disable(?:-next-line|-line)?(?:\s*\*\/|\s*$|\s+--|[^\n]*penmoss\/tracked-control)/.test(
              line,
            )
              ? [`${relative(ROOT, path)}:${index + 1}`]
              : [],
          ),
      ),
    );
    expect(disabled).toEqual([]);
  });

  it('every dialog useTrackedDialog names', () => {
    expect(found.dialogs.length).toBeGreaterThan(0);
    const missing = found.dialogs.filter((use) => !DIALOG_NAMES.includes(use.name));
    expect(missing.map((use) => `${use.name} (${use.where})`)).toEqual([]);
  });

  it('every screen kind a route maps to, each section its own', () => {
    const id = '01J00000000000000000000000';
    const routes: Route[] = [
      { name: 'home' },
      { name: 'note', id },
      { name: 'window', id },
      { name: 'graph' },
      { name: 'trash' },
      { name: 'tags' },
      ...SETTINGS_SECTIONS.map((section): Route => ({ name: 'settings', section })),
      { name: 'settings', section: 'git-notebooks', item: id },
      { name: 'settings', section: 'agents', item: id },
    ];
    for (const route of routes) {
      const kind = screenKindOf(route);
      expect(kind, JSON.stringify(route)).not.toBeNull();
      expect(SCREEN_NAMES, JSON.stringify(route)).toContain(kind);
      if (route.name === 'settings') expect(kind).not.toBe('settings');
    }
  });
});

/** A call's name: `f(…)`, `a.f(…)` and `a.f?.(…)` are all `f`. */
function calleeName(node: ts.CallExpression): string | null {
  const callee = node.expression;
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
  return null;
}

/** Calls in `file`, with where each is. */
function callsIn(
  file: ts.SourceFile,
  base: string,
): Array<{ node: ts.CallExpression; where: string }> {
  const found: Array<{ node: ts.CallExpression; where: string }> = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const line = file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
      found.push({ node, where: `${relative(base, file.fileName)}:${line}` });
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

/** A shortcut's key (`keys.<command id>`) is recorded as one name, as `recordSetting` does. */
const nameOfKey = (key: string) => (key.startsWith('keys.') ? 'shortcuts.custom' : key);

/** Functions that make a family of keys, and the keys they make. */
const KEY_FAMILIES: Readonly<Record<string, readonly string[]>> = {
  sidebarSetting: DISPLAY_SETTING_KEYS,
};

/**
 * The setting names an expression may come to: a literal; a constant or a union of them, from
 * its type; a family's keys; or, for a template (`privacy.limits.${key}`, `${BINDING_PREFIX}${id}`),
 * every catalogued name its fixed start begins. Null when it cannot say (a key passed along).
 */
function settingNamesOf(node: ts.Expression, checker: ts.TypeChecker): string[] | null {
  if (ts.isStringLiteralLike(node)) return [nameOfKey(node.text)];
  if (ts.isCallExpression(node)) {
    const family = calleeName(node);
    if (family && KEY_FAMILIES[family]) return KEY_FAMILIES[family].map(nameOfKey);
  }
  if (ts.isTemplateExpression(node)) {
    let start = node.head.text;
    for (const span of node.templateSpans) {
      const type = checker.getTypeAtLocation(span.expression);
      if (!type.isStringLiteral()) break;
      start += type.value + span.literal.text;
    }
    if (start.startsWith('keys.')) return ['shortcuts.custom'];
    return start ? SETTING_NAMES.filter((name) => name.startsWith(start)) : null;
  }
  const type = checker.getTypeAtLocation(node);
  const parts = type.isUnion() ? type.types : [type];
  if (parts.every((part) => part.isStringLiteral())) {
    return parts.map((part) => nameOfKey(part.value));
  }
  return null;
}

/**
 * The settings the page records: each key a `setSetting` call can write (the page's setSetting
 * records every catalogued key it is given), and each name a `recordSetting` or
 * `record('setting', …)` call gives. In apps/web/src and packages/ui/src, typed with the page's
 * own tsconfig so a constant's value is known.
 */
function pageSettings(): Map<string, string> {
  const files = [...sources(SOURCE), ...sources(UI_SOURCE)].filter((path) => {
    const text = readFileSync(path, 'utf8');
    return /setSetting\(|recordSetting\(|record\(\s*'setting'/.test(text);
  });
  const config = ts.readConfigFile(join(WEB, 'tsconfig.json'), (path) => ts.sys.readFile(path));
  const options = ts.parseJsonConfigFileContent(config.config, ts.sys, WEB).options;
  const program = ts.createProgram(files, { ...options, noEmit: true });
  const checker = program.getTypeChecker();
  const found = new Map<string, string>();
  for (const path of files) {
    for (const { node, where } of callsIn(program.getSourceFile(path)!, ROOT)) {
      const name = calleeName(node);
      const [first, second] = node.arguments;
      let argument: ts.Expression | undefined;
      if (name === 'setSetting' || name === 'recordSetting') argument = first;
      else if (name === 'record' && first && ts.isStringLiteralLike(first)) {
        argument = first.text === 'setting' ? second : undefined;
      }
      if (!argument) continue;
      for (const each of settingNamesOf(argument, checker) ?? []) {
        if (!found.has(each)) found.set(each, where);
      }
    }
  }
  return found;
}

/**
 * The settings the Mac's main process records itself (setting-events.ts): the literal name of
 * each `recordSetting(…)` call, and of each `analytics.record('setting', …)`.
 */
function mainSettings(): Map<string, string> {
  const found = new Map<string, string>();
  for (const path of sources(DESKTOP_SOURCE)) {
    const text = readFileSync(path, 'utf8');
    if (!text.includes('recordSetting') && !text.includes("'setting'")) continue;
    const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
    for (const { node, where } of callsIn(file, ROOT)) {
      const name = calleeName(node);
      const [first, second] = node.arguments;
      let argument: ts.Expression | undefined;
      if (name === 'recordSetting') argument = first;
      else if (name === 'record' && first && ts.isStringLiteralLike(first)) {
        argument = first.text === 'setting' ? second : undefined;
      }
      if (argument && ts.isStringLiteralLike(argument) && !found.has(argument.text)) {
        found.set(argument.text, where);
      }
    }
  }
  return found;
}

/**
 * Catalogued settings the Mac has no control for, each with why. Android records them; nothing
 * on the Mac can change them, so nothing records them there.
 */
const NOT_ON_THE_MAC: Readonly<Record<string, string>> = {
  'sidebar.journal': 'the phone’s Journal shortcut on Home; the Mac’s sidebar has its own ways',
  'sidebar.capture': 'the phone’s Capture shortcut on Home; the Mac has the menu bar and hotkey',
  'quickAccess.inDrawer': 'whether Android’s drawer lists Quick Access notes; the Mac has none',
  'git.wifiOnly': 'Android’s Sync Only on Wi-Fi; a Mac syncs on any network',
  'pictures.fromWeb': 'Android’s Load Pictures from the Web; the Mac always loads them',
};

describe('every catalogued setting has a recorder on the Mac (PEN-175 ac13)', () => {
  const page = pageSettings();
  const main = mainSettings();

  it('is recorded by the page or by main, unless the Mac has no such setting', () => {
    const missing = SETTING_NAMES.filter(
      (name) => !page.has(name) && !main.has(name) && !Object.hasOwn(NOT_ON_THE_MAC, name),
    );
    expect(missing).toEqual([]);
  });

  it('lists only catalogued settings the Mac really lacks', () => {
    const wrong = Object.keys(NOT_ON_THE_MAC).filter(
      (name) => !SETTING_NAMES.includes(name) || page.has(name) || main.has(name),
    );
    expect(wrong).toEqual([]);
  });

  it('main records the nine settings it writes itself, each a catalogued name', () => {
    expect([...main.keys()].sort()).toEqual(
      [
        'capture.hotkey',
        'git.pullEvery',
        'git.pushAfter',
        'git.signCommits',
        'meaning.enabled',
        'menuBar.icon',
        'titleBar.compact',
        'updates.auto',
        'updates.channel',
      ].sort(),
    );
    for (const name of main.keys()) expect(SETTING_NAMES).toContain(name);
  });
});

describe('no source writes a retired id (PEN-175 ac4)', () => {
  it('in the page, the shared components or the editor', () => {
    const writes: string[] = [];
    for (const dir of [SOURCE, UI_SOURCE, EDITOR_SOURCE]) {
      for (const path of sources(dir)) {
        const text = readFileSync(path, 'utf8');
        if (!RETIRED_CLICK_NAMES.some((id) => text.includes(id))) continue;
        const file = ts.createSourceFile(
          path,
          text,
          ts.ScriptTarget.Latest,
          true,
          path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
        );
        const visit = (node: ts.Node) => {
          if (ts.isStringLiteralLike(node) && RETIRED_CLICK_NAMES.includes(node.text)) {
            const line = file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
            writes.push(`${node.text} (${relative(ROOT, path)}:${line})`);
          }
          ts.forEachChild(node, visit);
        };
        visit(file);
      }
    }
    expect(writes).toEqual([]);
  });
});
