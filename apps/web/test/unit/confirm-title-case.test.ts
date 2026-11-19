/**
 * PEN-137 ac44 (A938 amended): every confirmation asks in Title Case. A web confirmation is a
 * `ConfirmBlock` (inline: its title a line of its own and the block's name), a `ConfirmDialog`
 * (modal) or the Privacy page's `InlineConfirm`; this reads every `title` given to one in the
 * page's source, and every button inside it, as the literals each expression may come to (a
 * `${…}` is "X"). A hand-made `role="alertdialog"` elsewhere fails, so none goes without a
 * title. The Mac's native message boxes (`dialog.showMessageBox`) are read the same way.
 */
import { isTitleCase, titleCaseProblem } from '@penmoss/core/title-case';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const WEB = fileURLToPath(new URL('../../src', import.meta.url));
const DESKTOP = fileURLToPath(new URL('../../../desktop/src', import.meta.url));

/** The components that frame a confirmation, by the name the page writes. */
const CONFIRMS = new Set(['ConfirmBlock', 'ConfirmDialog', 'InlineConfirm']);
/** Where `role="alertdialog"` may be written: inside those components. */
const ALERT_DIALOG_HOMES = new Set(['shell/ConfirmBlock.tsx', 'analytics/InlineConfirm.tsx']);
/**
 * The Privacy page's words are `ANALYTICS_COPY`'s, which core's copy test holds to Title Case
 * (ac41): a title there that is not a literal is one of them.
 */
const COPY_CHECKED = /^analytics\//;

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts') ? [path] : [];
  });
}

const parse = (path: string) =>
  ts.createSourceFile(
    path,
    readFileSync(path, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );

/** A call whose words the analytics copy test checks (`copy('…')`, `analyticsCopy('…')`). */
const isCopyCall = (node: ts.Node) =>
  ts.isCallExpression(node) &&
  ts.isIdentifier(node.expression) &&
  /^(copy|analyticsCopy)$/.test(node.expression.text);

/** The `const name = …` in `file`, if there is one. */
function constant(file: ts.SourceFile, name: string): ts.Expression | undefined {
  let found: ts.Expression | undefined;
  const visit = (node: ts.Node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === name &&
      node.initializer
    ) {
      found = node.initializer;
    }
    if (!found) ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

/**
 * The words an expression may come to, a `${…}` read as "X" unless it is itself literals; null
 * when it is none of these (a value from elsewhere), or 'copy' for the analytics copy's.
 */
function texts(node: ts.Node, file: ts.SourceFile): string[] | null | 'copy' {
  if (ts.isJsxExpression(node)) return node.expression ? texts(node.expression, file) : null;
  if (ts.isStringLiteralLike(node)) return [node.text];
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node)) {
    return texts(node.expression, file);
  }
  if (ts.isConditionalExpression(node)) {
    const yes = texts(node.whenTrue, file);
    const no = texts(node.whenFalse, file);
    if (yes === 'copy' || no === 'copy') return 'copy';
    return yes && no ? [...yes, ...no] : null;
  }
  if (ts.isTemplateExpression(node)) {
    let out = [node.head.text];
    for (const span of node.templateSpans) {
      const inner = texts(span.expression, file);
      const parts = Array.isArray(inner) ? inner : ['X'];
      out = out.flatMap((start) => parts.map((part) => start + part + span.literal.text));
    }
    return out;
  }
  if (isCopyCall(node)) return 'copy';
  if (ts.isIdentifier(node)) {
    const value = constant(file, node.text);
    return value ? texts(value, file) : null;
  }
  return null;
}

const attribute = (element: ts.JsxOpeningLikeElement, name: string) =>
  element.attributes.properties.find(
    (each): each is ts.JsxAttribute =>
      ts.isJsxAttribute(each) && ts.isIdentifier(each.name) && each.name.text === name,
  );

interface Found {
  readonly text: string;
  readonly where: string;
}

/** Every confirmation's title and buttons in the page, and any hand-made alertdialog. */
function confirmations(): { titles: Found[]; buttons: Found[]; unread: string[]; loose: string[] } {
  const titles: Found[] = [];
  const buttons: Found[] = [];
  const unread: string[] = [];
  const loose: string[] = [];
  for (const path of sources(WEB)) {
    const name = relative(WEB, path);
    const file = parse(path);
    const where = (node: ts.Node) =>
      `${name}:${file.getLineAndCharacterOfPosition(node.getStart()).line + 1}`;
    const add = (list: Found[], node: ts.Node, value: ts.Node) => {
      const words = texts(value, file);
      if (words === 'copy') return;
      if (words === null && COPY_CHECKED.test(name)) return;
      if (words === null) unread.push(where(node));
      else for (const text of words) list.push({ text, where: where(node) });
    };
    const buttonsIn = (node: ts.Node) => {
      const visit = (child: ts.Node) => {
        if (ts.isJsxElement(child) && child.openingElement.tagName.getText(file) === 'button') {
          // Its words, text and expressions together; an icon in it says nothing.
          let words = [''];
          for (const part of child.children) {
            if (ts.isJsxText(part)) words = words.map((start) => start + part.text);
            else if (ts.isJsxExpression(part) && part.expression) {
              const inner = texts(part.expression, file);
              if (inner === 'copy') return;
              const parts = Array.isArray(inner) ? inner : ['X'];
              words = words.flatMap((start) => parts.map((each) => start + each));
            }
          }
          for (const text of words) {
            const clean = text.replace(/\s+/g, ' ').trim();
            if (clean) buttons.push({ text: clean, where: where(child) });
          }
          return;
        }
        ts.forEachChild(child, visit);
      };
      visit(node);
    };
    const visit = (node: ts.Node) => {
      if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
        const opening = ts.isJsxElement(node) ? node.openingElement : node;
        const tag = opening.tagName.getText(file);
        if (CONFIRMS.has(tag)) {
          const title = attribute(opening, 'title');
          if (title?.initializer) add(titles, title, title.initializer);
          else unread.push(where(opening));
          buttonsIn(node);
        }
        const role = attribute(opening, 'role');
        if (
          role?.initializer &&
          ts.isStringLiteral(role.initializer) &&
          role.initializer.text === 'alertdialog' &&
          !ALERT_DIALOG_HOMES.has(name)
        ) {
          loose.push(where(opening));
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
  return { titles, buttons, unread, loose };
}

/** The Mac's native message boxes: each `message` and button. */
function messageBoxes(): { titles: Found[]; buttons: Found[] } {
  const titles: Found[] = [];
  const buttons: Found[] = [];
  for (const path of sources(DESKTOP)) {
    const text = readFileSync(path, 'utf8');
    if (!text.includes('showMessageBox')) continue;
    const file = parse(path);
    const visit = (node: ts.Node) => {
      if (
        ts.isCallExpression(node) &&
        node.expression.getText(file).endsWith('showMessageBox') &&
        node.arguments.length > 0
      ) {
        const options = node.arguments.at(-1)!;
        if (ts.isObjectLiteralExpression(options)) {
          for (const property of options.properties) {
            if (!ts.isPropertyAssignment(property)) continue;
            const key = property.name.getText(file);
            const where = `${relative(DESKTOP, path)}:${file.getLineAndCharacterOfPosition(property.getStart()).line + 1}`;
            if (key === 'message') {
              const words = texts(property.initializer, file);
              for (const each of Array.isArray(words) ? words : []) {
                titles.push({ text: each, where });
              }
            }
            if (key === 'buttons' && ts.isArrayLiteralExpression(property.initializer)) {
              for (const button of property.initializer.elements) {
                const words = texts(button, file);
                for (const each of Array.isArray(words) ? words : []) {
                  buttons.push({ text: each, where });
                }
              }
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
  return { titles, buttons };
}

const problems = (found: readonly Found[]) =>
  found
    .filter(({ text }) => !isTitleCase(text))
    .map(({ text, where }) => `${where}: ${titleCaseProblem(text)}`);

describe('confirmations ask in Title Case (PEN-137 ac44)', () => {
  const found = confirmations();

  it('reads every confirmation’s title', () => {
    expect(found.unread, 'a title the check cannot read: use literals').toEqual([]);
    const titles = new Set(found.titles.map((each) => each.text));
    // The inline ones (ac44), each a question of its own above its sentence.
    for (const title of [
      'Delete This Thread?',
      'Delete for Good?',
      'Remove This Notebook?',
      'Disconnect Anyway?',
      'Replace This Shortcut?',
      'Delete #X?',
      'Delete X Tags?',
      'Delete “X” on Every Device?',
    ]) {
      expect(titles, title).toContain(title);
    }
  });

  it('writes every title and button in Title Case', () => {
    expect(problems(found.titles)).toEqual([]);
    expect(problems(found.buttons)).toEqual([]);
  });

  it('frames every inline confirmation with ConfirmBlock, so none is without its title', () => {
    expect(found.loose).toEqual([]);
  });

  it('asks the Mac’s native questions in Title Case too', () => {
    const boxes = messageBoxes();
    expect(boxes.titles.map((each) => each.text)).toEqual(
      expect.arrayContaining([
        'Use the Compact Title Bar?',
        'Use the Standard Title Bar?',
        'The Title Bar Was Not Changed',
      ]),
    );
    expect(problems(boxes.titles)).toEqual([]);
    expect(problems(boxes.buttons)).toEqual([]);
  });
});
