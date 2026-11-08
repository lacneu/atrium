// Which property NAMES a piece of bridge code touches — through the TypeScript parser,
// never a text scan.
//
// The coverage manifest's truth guard (test/coverage-truth.test.ts, V3) asks one question
// of a READ SITE (a named function, or a whole file, that reads one protocol schema's
// payload): does it touch a field the manifest declares unread? A textual sweep of the
// whole bridge cannot answer it — `status`, `kind`, `reason` are read everywhere, for
// other objects — but inside the function that reads the payload the same name is that
// payload's field. So the names are collected per function, from the syntax:
//   - `x.name`, `x?.name`, `x["name"]`                       (a read)
//   - `const { name } = x`, `const { name: y } = x`           (a read)
//   - `"name" in x`                                          (a read)
//   - `{ name: v }`, `{ name }` in an object literal         (a WRITE — counted only when
//     the caller asks, for the schemas the bridge SENDS)
// Comments and string contents are not syntax, so they never count.

import ts from "typescript";

const FUNCTION_LIKE = new Set([
  ts.SyntaxKind.FunctionDeclaration,
  ts.SyntaxKind.MethodDeclaration,
  ts.SyntaxKind.FunctionExpression,
  ts.SyntaxKind.ArrowFunction,
  ts.SyntaxKind.Constructor,
  ts.SyntaxKind.GetAccessor,
  ts.SyntaxKind.SetAccessor,
]);

/** The name a function-like node is known by: its own, or the binding it is assigned to. */
function nameOf(node) {
  if (node.name && (ts.isIdentifier(node.name) || ts.isStringLiteral(node.name) || ts.isPrivateIdentifier(node.name))) {
    return node.name.text;
  }
  if (node.kind === ts.SyntaxKind.Constructor) return "constructor";
  const p = node.parent;
  if (p && ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) return p.name.text;
  if (p && ts.isPropertyAssignment(p) && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name))) return p.name.text;
  if (p && ts.isPropertyDeclaration(p) && ts.isIdentifier(p.name)) return p.name.text;
  return null;
}

function propName(n) {
  if (!n) return null;
  if (ts.isIdentifier(n) || ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isPrivateIdentifier(n)) return n.text;
  return null;
}

/**
 * Every named function of a source file, with the names its WHOLE body touches (nested
 * closures included: a site is the function and everything it encloses).
 *
 * @param {string} text
 * @param {string} fileName
 * @returns {{ functions: Map<string, {reads: Set<string>, writes: Set<string>}>, file: {reads: Set<string>, writes: Set<string>} }}
 */
export function touchedNames(text, fileName) {
  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true, fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const functions = new Map();
  const file = { reads: new Set(), writes: new Set() };
  const stack = [];
  const note = (kind, name) => {
    if (name === null) return;
    file[kind].add(name);
    for (const f of stack) f[kind].add(name);
  };
  const visit = (node) => {
    let pushed = false;
    if (FUNCTION_LIKE.has(node.kind)) {
      const name = nameOf(node);
      if (name !== null) {
        if (!functions.has(name)) functions.set(name, { reads: new Set(), writes: new Set() });
        stack.push(functions.get(name));
        pushed = true;
      }
    }
    if (ts.isPropertyAccessExpression(node)) note("reads", propName(node.name));
    else if (ts.isElementAccessExpression(node) && node.argumentExpression && ts.isStringLiteralLike(node.argumentExpression)) {
      note("reads", node.argumentExpression.text);
    } else if (ts.isBindingElement(node) && ts.isObjectBindingPattern(node.parent)) {
      note("reads", propName(node.propertyName ?? node.name));
    } else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.InKeyword && ts.isStringLiteralLike(node.left)) {
      note("reads", node.left.text);
    } else if (ts.isPropertyAssignment(node) && ts.isObjectLiteralExpression(node.parent)) {
      note("writes", propName(node.name));
    } else if (ts.isShorthandPropertyAssignment(node)) {
      note("writes", node.name.text);
    }
    ts.forEachChild(node, visit);
    if (pushed) stack.pop();
  };
  visit(sf);
  return { functions, file };
}
