/**
 * Names used in a C# file (M16), the same index as references.ts builds for TypeScript:
 * references with how they are used, fields, `using` directives as imports, attributes (as
 * decorators), classes and the first namespace the file declares.
 *
 * An import's source is the name after `using` (`Acme.Core.Services`, `Acme.Core.Utilities.
 * CoreHelpers` for `using static`); only an alias (`using User = Acme.Core.Entities.User`) brings
 * in a name of its own. C# writes types as plain identifiers, so a name's place says whether it
 * is a type. Property symbols are members: `new User { Email = e }` sets the member `Email`.
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

const CLASS_TYPES = new Set(['class_declaration', 'struct_declaration', 'record_declaration']);
const TYPE_DECLARATIONS = new Set([
  ...CLASS_TYPES,
  'interface_declaration',
  'enum_declaration',
  'delegate_declaration',
]);
const METHOD_TYPES = new Set(['method_declaration', 'constructor_declaration']);
/** Nodes whose `name` field declares a name rather than using one. */
const DECLARATIONS = new Set([
  ...TYPE_DECLARATIONS,
  ...METHOD_TYPES,
  'property_declaration',
  'event_declaration',
  'variable_declarator',
  'parameter',
  'enum_member_declaration',
  'local_function_statement',
  'type_parameter',
  'catch_declaration',
  'foreach_statement',
]);
const NAMESPACES = new Set(['namespace_declaration', 'file_scoped_namespace_declaration']);
/** Parents in which a name is a type. */
const TYPE_PARENTS = new Set([
  'base_list',
  'type_argument_list',
  'nullable_type',
  'array_type',
  'pointer_type',
  'ref_type',
  'typeof_expression',
  'type_parameter_constraint',
  'attribute',
]);

export function indexCSharp(root: Node): NameIndex {
  const references: Reference[] = [];
  const fields: FieldDeclaration[] = [];
  const imports: ImportDeclaration[] = [];
  const decorators: DecoratorUse[] = [];
  const classes: ClassDeclaration[] = [];
  let packageName: string | undefined;

  const visit = (node: Node) => {
    const type = node.type;
    if (type === 'comment') return;
    if (type === 'using_directive') {
      const alias = node.childForFieldName('name');
      const target = node.namedChildren.find((c) => c !== null && !(alias && c.equals(alias)));
      if (target) {
        imports.push({
          source: target.text.replace(/\s+/g, ''),
          names: alias ? [alias.text] : [],
          line: line(node),
        });
      }
      return;
    }
    if (NAMESPACES.has(type)) {
      // The namespace's own name is not a use.
      const name = node.childForFieldName('name');
      packageName ??= name?.text.replace(/\s+/g, '');
      for (const child of node.namedChildren)
        if (child && !(name && child.equals(name))) visit(child);
      return;
    }
    if (type === 'attribute') {
      const use = attributeUse(node);
      if (use) decorators.push(use);
    }
    if (CLASS_TYPES.has(type)) {
      const decl = classDeclaration(node);
      if (decl) classes.push(decl);
    }
    if (type === 'field_declaration' || type === 'event_field_declaration') {
      const v = node.namedChildren.find((c) => c?.type === 'variable_declaration');
      for (const d of v?.namedChildren ?? []) {
        const name = d?.type === 'variable_declarator' ? d.childForFieldName('name') : null;
        if (name) fields.push({ name: name.text, line: line(name) });
      }
    }
    if (type === 'enum_member_declaration') {
      const name = node.childForFieldName('name');
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

const isField = (parent: Node, field: string, node: Node) =>
  parent.childForFieldName(field)?.equals(node) ?? false;

function kindOf(node: Node): ReferenceKind {
  let parent = node.parent;
  if (!parent) return 'name';
  if (DECLARATIONS.has(parent.type) && isField(parent, 'name', node)) return 'declaration';
  // `List<User>` and `Acme.Core.User` take the place of their whole name.
  let at: Node = node;
  while (parent && (parent.type === 'generic_name' || parent.type === 'qualified_name')) {
    if (parent.type === 'qualified_name' && !isField(parent, 'name', at)) return 'name';
    at = parent;
    parent = parent.parent;
  }
  if (!parent) return 'name';
  if (parent.type === 'object_creation_expression' && isField(parent, 'type', at)) return 'new';
  if (TYPE_PARENTS.has(parent.type)) return 'type';
  if (isField(parent, 'type', at) || isField(parent, 'returns', at)) return 'type';
  if (parent.type === 'invocation_expression' && isField(parent, 'function', at)) return 'call';
  if (parent.type === 'member_access_expression' && isField(parent, 'name', at)) {
    const grand = parent.parent;
    if (grand?.type === 'invocation_expression' && isField(grand, 'function', parent))
      return 'call';
    return 'member';
  }
  // `new User { Email = e }`.
  if (
    parent.type === 'assignment_expression' &&
    isField(parent, 'left', at) &&
    parent.parent?.type === 'initializer_expression'
  )
    return 'member';
  return 'name';
}

function attributeUse(node: Node): DecoratorUse | undefined {
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return undefined;
  const name = nameNode.text.slice(nameNode.text.lastIndexOf('.') + 1).replace(/<.*$/s, '');
  const args: string[] = [];
  const refs: string[] = [];
  const list = node.namedChildren.find((c) => c?.type === 'attribute_argument_list');
  for (const arg of list?.namedChildren ?? []) {
    if (!arg) continue;
    for (const s of arg.descendantsOfType('string_literal_content')) if (s) args.push(s.text);
    // `Name = "x"` and `name: x` name the attribute's parameter.
    const named = arg.childForFieldName('name');
    for (const id of arg.descendantsOfType('identifier'))
      if (id && !(named && id.equals(named))) refs.push(id.text);
  }
  return { name, args, refs, line: line(node), target: attributeTarget(node) };
}

function attributeTarget(node: Node): DecoratorUse['target'] {
  const owner = node.parent?.type === 'attribute_list' ? node.parent.parent : null;
  if (!owner) return { kind: 'other', name: '' };
  const nameOf = (n: Node) => n.childForFieldName('name')?.text ?? '';
  if (TYPE_DECLARATIONS.has(owner.type)) return { kind: 'class', name: nameOf(owner) };
  const className = enclosingClass(owner);
  const withClass = <T extends DecoratorUse['target']>(t: T): T =>
    className ? { ...t, className } : t;
  if (METHOD_TYPES.has(owner.type)) return withClass({ kind: 'method', name: nameOf(owner) });
  if (owner.type === 'property_declaration')
    return withClass({ kind: 'property', name: nameOf(owner) });
  if (owner.type === 'field_declaration') {
    const d = owner.descendantsOfType('variable_declarator')[0];
    return withClass({ kind: 'property', name: d ? nameOf(d) : '' });
  }
  if (owner.type === 'parameter') return withClass({ kind: 'parameter', name: nameOf(owner) });
  return { kind: 'other', name: '' };
}

function enclosingClass(node: Node): string | undefined {
  for (let n: Node | null = node.parent; n; n = n.parent)
    if (TYPE_DECLARATIONS.has(n.type)) return n.childForFieldName('name')?.text;
  return undefined;
}

/** A type's name without namespace or type arguments: `Acme.Core.ILogger<T>` → `ILogger`. */
function headName(type: Node): string {
  let t = type;
  if (t.type === 'qualified_name') t = t.childForFieldName('name') ?? t;
  if (t.type === 'generic_name') t = t.namedChildren[0] ?? t;
  return t.text;
}

function typeNames(type: Node): string[] {
  return type
    .descendantsOfType('identifier')
    .flatMap((t) =>
      t?.type === 'identifier' && t.parent?.type !== 'qualified_name' ? [t.text] : [],
    );
}

function classDeclaration(node: Node): ClassDeclaration | undefined {
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return undefined;
  // The base list mixes the base class and interfaces; by convention interfaces are `IName`.
  const bases = (
    node.namedChildren.find((c) => c?.type === 'base_list')?.namedChildren ?? []
  ).flatMap((t) => (t ? [headName(t)] : []));
  const isInterface = (n: string) => /^I[A-Z]/.test(n);
  // A primary constructor (C# 12, records), else the first constructor.
  const params =
    node.namedChildren.find((c) => c?.type === 'parameter_list') ??
    node
      .childForFieldName('body')
      ?.namedChildren.find((m) => m?.type === 'constructor_declaration')
      ?.childForFieldName('parameters');
  const constructorParams: ClassDeclaration['constructorParams'] = [];
  for (const p of params?.namedChildren ?? []) {
    if (p?.type !== 'parameter') continue;
    const name = p.childForFieldName('name');
    const type = p.childForFieldName('type');
    if (!name || !type) continue;
    constructorParams.push({ name: name.text, types: typeNames(type), line: line(p) });
  }
  return {
    name: nameNode.text,
    line: line(nameNode),
    extends: bases.filter((n) => !isInterface(n)),
    implements: bases.filter(isInterface),
    constructorParams,
  };
}
