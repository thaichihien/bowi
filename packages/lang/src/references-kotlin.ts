/**
 * Names used in a Kotlin file (M16), the same index as references.ts builds for TypeScript:
 * references with how they are used, class properties as fields, imports, annotations (as
 * decorators), classes and the declared package.
 *
 * An import's source is its dotted name (`netlib.Call`, `netlib.internal.closeQuietly` for a
 * top-level function, `java.util.*` for a whole package); `as` renames what it brings in.
 * Kotlin has no `new`: calling a capitalized name (`HttpCall(client)`) counts as constructing
 * it, which links like a call either way (Compose functions are capitalized too).
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

const CLASS_TYPES = new Set(['class_declaration', 'object_declaration']);
const FUNCTION_TYPES = new Set(['function_declaration', 'secondary_constructor']);
const BODIES = new Set(['class_body', 'enum_class_body']);

export function indexKotlin(root: Node): NameIndex {
  const references: Reference[] = [];
  const fields: FieldDeclaration[] = [];
  const imports: ImportDeclaration[] = [];
  const decorators: DecoratorUse[] = [];
  const classes: ClassDeclaration[] = [];
  let packageName: string | undefined;

  const visit = (node: Node) => {
    const type = node.type;
    if (type === 'line_comment' || type === 'block_comment') return;
    if (type === 'package_header') {
      packageName ??= node.namedChildren.find((c) => c?.type === 'qualified_identifier')?.text;
      return;
    }
    if (type === 'import') {
      const path = node.namedChildren.find((c) => c?.type === 'qualified_identifier');
      if (path) {
        const wildcard = /\*\s*$/.test(node.text);
        const alias = node.namedChildren.find((c) => c?.type === 'identifier')?.text;
        const source = wildcard ? `${path.text}.*` : path.text;
        imports.push({
          source,
          names: wildcard ? [] : [alias ?? source.slice(source.lastIndexOf('.') + 1)],
          line: line(node),
        });
      }
      return;
    }
    if (type === 'annotation') {
      const use = annotationUse(node);
      if (use) decorators.push(use);
    }
    if (type === 'class_declaration' && !isInterface(node)) {
      const decl = classDeclaration(node);
      if (decl) classes.push(decl);
    }
    if (type === 'object_declaration') {
      const decl = classDeclaration(node);
      if (decl) classes.push(decl);
    }
    // Properties of a class body (a companion object's too), `val`/`var` constructor
    // parameters and enum entries are reached like fields: `call.client`, `Color.RED`.
    if (type === 'property_declaration' && node.parent && BODIES.has(node.parent.type)) {
      const name = propertyName(node);
      if (name) fields.push({ name: name.text, line: line(name) });
    }
    if (
      type === 'class_parameter' &&
      node.children.some((c) => c?.type === 'val' || c?.type === 'var')
    ) {
      const name = node.namedChildren.find((c) => c?.type === 'identifier');
      if (name) fields.push({ name: name.text, line: line(name) });
    }
    if (type === 'enum_entry') {
      const name = node.namedChildren.find((c) => c?.type === 'identifier');
      if (name) fields.push({ name: name.text, line: line(name) });
    }
    if (type === 'identifier') {
      references.push({ name: node.text, kind: kindOf(node), line: line(node) });
      return;
    }
    for (const child of node.children) if (child) visit(child);
  };
  visit(root);
  return {
    references,
    fields,
    imports,
    decorators,
    classes,
    directives: [],
    ...(packageName !== undefined && { packageName }),
  };
}

const line = (n: Node) => n.startPosition.row + 1;

function isInterface(node: Node): boolean {
  return node.children.some((c) => c?.type === 'interface');
}

function propertyName(node: Node): Node | undefined {
  const v = node.namedChildren.find((c) => c?.type === 'variable_declaration');
  return v?.namedChildren.find((c) => c?.type === 'identifier') ?? undefined;
}

/** Whether `node` is the identifier a parameter, property or entry declares. */
function declares(parent: Node, node: Node): boolean {
  switch (parent.type) {
    case 'class_declaration':
    case 'object_declaration':
    case 'function_declaration':
      return parent.childForFieldName('name')?.equals(node) ?? false;
    case 'type_alias':
      return parent.childForFieldName('type')?.equals(node) ?? false;
    case 'variable_declaration':
    case 'parameter':
    case 'class_parameter':
    case 'enum_entry':
    case 'type_parameter':
    case 'lambda_parameters':
      return parent.namedChildren.find((c) => c?.type === 'identifier')?.equals(node) ?? false;
    default:
      return false;
  }
}

function kindOf(node: Node): ReferenceKind {
  const parent = node.parent;
  if (!parent) return 'name';
  if (declares(parent, node)) return 'declaration';
  if (parent.type === 'user_type') return 'type';
  if (parent.type === 'call_expression' && parent.namedChildren[0]?.equals(node))
    return /^[A-Z]/.test(node.text) ? 'new' : 'call';
  // `a.b`: the last name is the member; `a.b(…)` calls it.
  if (parent.type === 'navigation_expression' && parent.namedChildren.at(-1)?.equals(node)) {
    const grand = parent.parent;
    if (grand?.type === 'call_expression' && grand.namedChildren[0]?.equals(parent)) return 'call';
    return 'member';
  }
  return 'name';
}

function annotationUse(node: Node): DecoratorUse | undefined {
  // `@Inject`, `@Suppress("x")`, `@field:Json(name = "id")`.
  const call = node.namedChildren.find((c) => c?.type === 'constructor_invocation');
  const type =
    call?.namedChildren.find((c) => c?.type === 'user_type') ??
    node.namedChildren.find((c) => c?.type === 'user_type');
  if (!type) return undefined;
  const name = type.text.slice(type.text.lastIndexOf('.') + 1).replace(/<.*$/s, '');
  const args: string[] = [];
  const refs: string[] = [];
  const list = call?.namedChildren.find((c) => c?.type === 'value_arguments');
  for (const arg of list?.namedChildren ?? []) {
    if (!arg) continue;
    for (const s of arg.descendantsOfType('string_content')) if (s) args.push(s.text);
    // `name = value`: the first identifier names the parameter.
    const named = /^\s*\w+\s*=/.test(arg.text);
    arg.namedChildren.forEach((c, i) => {
      if (c?.type === 'identifier' && !(named && i === 0)) refs.push(c.text);
    });
  }
  return { name, args, refs, line: line(node), target: annotationTarget(node) };
}

function annotationTarget(node: Node): DecoratorUse['target'] {
  const owner = node.parent?.type === 'modifiers' ? node.parent.parent : null;
  if (!owner) return { kind: 'other', name: '' };
  const idOf = (n: Node) =>
    n.childForFieldName('name')?.text ??
    n.namedChildren.find((c) => c?.type === 'identifier')?.text ??
    '';
  if (CLASS_TYPES.has(owner.type)) return { kind: 'class', name: idOf(owner) };
  const className = enclosingClass(owner);
  const withClass = <T extends DecoratorUse['target']>(t: T): T =>
    className ? { ...t, className } : t;
  if (FUNCTION_TYPES.has(owner.type)) return withClass({ kind: 'method', name: idOf(owner) });
  if (owner.type === 'property_declaration')
    return withClass({ kind: 'property', name: propertyName(owner)?.text ?? '' });
  if (owner.type === 'class_parameter' || owner.type === 'parameter')
    return withClass({ kind: 'parameter', name: idOf(owner) });
  return { kind: 'other', name: '' };
}

function enclosingClass(node: Node): string | undefined {
  for (let n: Node | null = node.parent; n; n = n.parent)
    if (CLASS_TYPES.has(n.type)) return n.childForFieldName('name')?.text;
  return undefined;
}

/** The type names in a type, type arguments included: `List<User>` → `List`, `User`. */
function typeNames(type: Node): string[] {
  return type.descendantsOfType('user_type').flatMap((t) => {
    const id =
      t?.type === 'user_type'
        ? t.namedChildren.filter((c) => c?.type === 'identifier').at(-1)
        : undefined;
    return id ? [id.text] : [];
  });
}

function classDeclaration(node: Node): ClassDeclaration | undefined {
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return undefined;
  const extendsNames: string[] = [];
  const implementsNames: string[] = [];
  // `: Base(), Call`: a constructor call is the superclass, a bare type an interface.
  const specifiers = node.namedChildren.find((c) => c?.type === 'delegation_specifiers');
  for (const s of specifiers?.namedChildren ?? []) {
    const call = s?.namedChildren.find((c) => c?.type === 'constructor_invocation');
    const type = (call ?? s)?.namedChildren.find((c) => c?.type === 'user_type');
    const name = type ? typeNames(type)[0] : undefined;
    if (name) (call ? extendsNames : implementsNames).push(name);
  }
  const constructorParams: ClassDeclaration['constructorParams'] = [];
  const primary = node.namedChildren.find((c) => c?.type === 'primary_constructor');
  const params = primary?.namedChildren.find((c) => c?.type === 'class_parameters');
  for (const p of params?.namedChildren ?? []) {
    if (p?.type !== 'class_parameter') continue;
    const name = p.namedChildren.find((c) => c?.type === 'identifier');
    const type = p.namedChildren.find((c) => c && /_type$/.test(c.type));
    if (!name || !type) continue;
    constructorParams.push({ name: name.text, types: typeNames(type), line: line(p) });
  }
  return {
    name: nameNode.text,
    line: line(nameNode),
    extends: extendsNames,
    implements: implementsNames,
    constructorParams,
  };
}
