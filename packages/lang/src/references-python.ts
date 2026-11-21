/**
 * Names used in a Python file (M15), the same index as references.ts builds for TypeScript:
 * references with how they are used, class-level fields, imports, decorators and classes.
 *
 * Imports keep Python's module paths as their source: `from .mail import send` is `.mail`,
 * `from . import mail` is `.mail` too (a module of the package), `import app.mail as m` is
 * `app.mail`. The language family in the engine resolves them to files.
 */

import type { Node } from 'web-tree-sitter';
import type {
  ClassDeclaration,
  DecoratorUse,
  FieldDeclaration,
  ImportDeclaration,
  NameIndex,
  Reference,
  ReferenceKind,
} from './references.ts';

/** Nodes whose `name` field declares a name rather than using one. */
const DECLARATIONS = new Set(['function_definition', 'class_definition']);

export function indexPython(root: Node): NameIndex {
  const references: Reference[] = [];
  const fields: FieldDeclaration[] = [];
  const imports: ImportDeclaration[] = [];
  const decorators: DecoratorUse[] = [];
  const classes: ClassDeclaration[] = [];
  const line = (n: Node) => n.startPosition.row + 1;

  const visit = (node: Node) => {
    const type = node.type;
    if (type === 'comment') return;
    if (type === 'import_statement' || type === 'import_from_statement') {
      imports.push(...importsOf(node));
      return;
    }
    if (type === 'decorator') {
      const use = decoratorUse(node);
      if (use) decorators.push(use);
    }
    if (type === 'class_definition') {
      const decl = classDeclaration(node);
      if (decl) classes.push(decl);
      for (const f of classFields(node)) fields.push(f);
    }
    if (type === 'identifier') {
      references.push({ name: node.text, kind: kindOf(node), line: line(node) });
      return;
    }
    for (const child of node.children) if (child) visit(child);
  };
  visit(root);
  return { references, fields, imports, decorators, classes, directives: [] };
}

function kindOf(node: Node): ReferenceKind {
  const parent = node.parent;
  if (!parent) return 'name';
  if (DECLARATIONS.has(parent.type) && parent.childForFieldName('name')?.equals(node))
    return 'declaration';
  if (parent.type === 'call' && parent.childForFieldName('function')?.equals(node)) return 'call';
  if (parent.type === 'attribute' && parent.childForFieldName('attribute')?.equals(node)) {
    const grand = parent.parent;
    if (grand?.type === 'call' && grand.childForFieldName('function')?.equals(parent))
      return 'call';
    return 'member';
  }
  if (parent.type === 'keyword_argument' && parent.childForFieldName('name')?.equals(node))
    return 'key';
  for (let n: Node | null = parent; n; n = n.parent) {
    if (n.type === 'type') return 'type';
    if (n.type === 'block' || n.type === 'module') break;
  }
  return 'name';
}

/** One declaration per module a statement names; see the file comment. */
function importsOf(node: Node): ImportDeclaration[] {
  const at = node.startPosition.row + 1;
  const bound = (n: Node): string | undefined => {
    if (n.type === 'aliased_import') return n.childForFieldName('alias')?.text;
    if (n.type === 'dotted_name') return n.namedChildren[0]?.text;
    return n.type === 'identifier' ? n.text : undefined;
  };
  if (node.type === 'import_statement') {
    return node.childrenForFieldName('name').flatMap((n) => {
      if (!n) return [];
      const module = n.type === 'aliased_import' ? n.childForFieldName('name') : n;
      const name = bound(n);
      return module && name ? [{ source: module.text, names: [name], line: at }] : [];
    });
  }
  const module = node.childForFieldName('module_name');
  if (!module) return [];
  const names = node
    .childrenForFieldName('name')
    .flatMap((n) => (n && bound(n) ? [bound(n)!] : []));
  const source = module.text;
  // `from . import mail`: each name may be a module of the package.
  if (/^\.+$/.test(source)) {
    return [
      { source, names, line: at },
      ...node.childrenForFieldName('name').flatMap((n) => {
        const name = n && (n.type === 'aliased_import' ? n.childForFieldName('name') : n)?.text;
        return name ? [{ source: `${source}${name}`, names: [bound(n)!], line: at }] : [];
      }),
    ];
  }
  return [{ source, names, line: at }];
}

/** `@app.get("/users")` on a function: name `get`, args `["/users"]`. */
function decoratorUse(node: Node): DecoratorUse | undefined {
  const expr = node.namedChildren[0];
  if (!expr) return undefined;
  const callee = expr.type === 'call' ? expr.childForFieldName('function') : expr;
  const name =
    callee?.type === 'attribute'
      ? callee.childForFieldName('attribute')?.text
      : callee?.type === 'identifier'
        ? callee.text
        : undefined;
  if (!name) return undefined;
  const argNodes =
    expr.type === 'call' ? (expr.childForFieldName('arguments')?.namedChildren ?? []) : [];
  const args: string[] = [];
  const refs: string[] = [];
  for (const a of argNodes) {
    if (!a) continue;
    const value = a.type === 'keyword_argument' ? a.childForFieldName('value') : a;
    if (value?.type === 'string') args.push(stringText(value));
    else if (value?.type === 'identifier') refs.push(value.text);
  }
  const definition = node.parent?.childForFieldName('definition');
  const targetName = definition?.childForFieldName('name')?.text ?? '';
  const inClass = enclosingClass(node.parent ?? node);
  return {
    name,
    args,
    refs,
    line: node.startPosition.row + 1,
    target: {
      kind:
        definition?.type === 'class_definition'
          ? 'class'
          : definition?.type === 'function_definition' && inClass
            ? 'method'
            : 'other',
      name: targetName,
      ...(inClass && definition?.type !== 'class_definition' && { className: inClass }),
    },
  };
}

function enclosingClass(node: Node): string | undefined {
  for (let n = node.parent; n; n = n.parent) {
    if (n.type === 'class_definition') return n.childForFieldName('name')?.text;
  }
  return undefined;
}

function classDeclaration(node: Node): ClassDeclaration | undefined {
  const name = node.childForFieldName('name');
  if (!name) return undefined;
  const bases = (node.childForFieldName('superclasses')?.namedChildren ?? []).flatMap((b) =>
    b?.type === 'identifier'
      ? [b.text]
      : b?.type === 'attribute'
        ? [b.childForFieldName('attribute')?.text ?? '']
        : [],
  );
  // `__init__(self, repo: UserRepository)`: parameters with the type names they are annotated with.
  const constructorParams: ClassDeclaration['constructorParams'] = [];
  for (const def of node.childForFieldName('body')?.namedChildren ?? []) {
    const fn = def?.type === 'decorated_definition' ? def.childForFieldName('definition') : def;
    if (fn?.type !== 'function_definition' || fn.childForFieldName('name')?.text !== '__init__')
      continue;
    for (const p of fn.childForFieldName('parameters')?.namedChildren ?? []) {
      if (p?.type !== 'typed_parameter' && p?.type !== 'typed_default_parameter') continue;
      const pname = p.namedChildren.find((c) => c?.type === 'identifier');
      const types = (p.childForFieldName('type')?.descendantsOfType('identifier') ?? []).flatMap(
        (t) => (t ? [t.text] : []),
      );
      if (pname)
        constructorParams.push({ name: pname.text, types, line: pname.startPosition.row + 1 });
    }
  }
  return {
    name: name.text,
    line: name.startPosition.row + 1,
    extends: bases.filter(Boolean),
    implements: [],
    constructorParams,
  };
}

/** Class-level names: `email: str`, `status = "draft"` (dataclass, Pydantic and ORM fields). */
function classFields(node: Node): FieldDeclaration[] {
  const out: FieldDeclaration[] = [];
  for (const stmt of node.childForFieldName('body')?.namedChildren ?? []) {
    if (stmt?.type !== 'expression_statement') continue;
    const assign = stmt.namedChildren[0];
    const left = assign?.type === 'assignment' ? assign.childForFieldName('left') : undefined;
    if (left?.type === 'identifier')
      out.push({ name: left.text, line: left.startPosition.row + 1 });
  }
  return out;
}

function stringText(node: Node): string {
  const content = node.namedChildren.find((c) => c?.type === 'string_content');
  return content?.text ?? '';
}
