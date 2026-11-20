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
  SCREEN_NAMES,
} from '@penmoss/core/analytics';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { screenKindOf } from '../../src/analytics/track';
import { COMMANDS } from '../../src/commands/definitions';
import { SETTINGS_SECTIONS, type Route } from '../../src/router';

const SOURCE = fileURLToPath(new URL('../../src', import.meta.url));

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

/** The `data-event` ids and the dialog names written in the page, with where each is. */
function uses(): { readonly events: Use[]; readonly dialogs: Use[] } {
  const events: Use[] = [];
  const dialogs: Use[] = [];
  for (const path of sources(SOURCE)) {
    const text = readFileSync(path, 'utf8');
    if (!text.includes('data-event') && !text.includes('useTrackedDialog')) continue;
    const file = ts.createSourceFile(
      path,
      text,
      ts.ScriptTarget.Latest,
      true,
      path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const where = (node: ts.Node) =>
      `${relative(SOURCE, path)}:${file.getLineAndCharacterOfPosition(node.getStart()).line + 1}`;
    const visit = (node: ts.Node) => {
      if (ts.isJsxAttribute(node) && node.name.getText(file) === 'data-event' && node.initializer) {
        const value = ts.isJsxExpression(node.initializer)
          ? node.initializer.expression
          : node.initializer;
        for (const name of value ? literals(value) : []) events.push({ name, where: where(node) });
      }
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'useTrackedDialog' &&
        node.arguments[0]
      ) {
        for (const name of literals(node.arguments[0])) dialogs.push({ name, where: where(node) });
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
  return { events, dialogs };
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
      { name: 'time-machine' },
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
