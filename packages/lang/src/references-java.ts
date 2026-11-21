/**
 * Names used in a Java file (M16), the same index as references.ts builds for TypeScript:
 * references with how they are used, fields, imports, annotations (as decorators), classes and
 * the declared package.
 *
 * An import's source is its dotted name: `org.acme.User`, `org.acme.Util.check` for a static
 * import, `org.acme.mail.*` for a whole package. Names in package and import declarations are
 * not uses.
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

const CLASS_TYPES = new Set(['class_declaration', 'record_declaration', 'enum_declaration']);
const TYPE_DECLARATIONS = new Set([
  ...CLASS_TYPES,
  'interface_declaration',
  'annotation_type_declaration',
]);
const METHOD_TYPES = new Set([
  'method_declaration',
  'constructor_declaration',
  'compact_constructor_declaration',
]);
/** Nodes whose `name` field declares a name rather than using one. */
const DECLARATIONS = new Set([
  ...TYPE_DECLARATIONS,
  ...METHOD_TYPES,
  'annotation_type_element_declaration',
  'variable_declarator',
  'formal_parameter',
  'catch_formal_parameter',
  'enum_constant',
  'type_parameter',
]);
const ANNOTATIONS = new Set(['annotation', 'marker_annotation']);

export function indexJava(root: Node): NameIndex {
  const references: Reference[] = [];
  const fields: FieldDeclaration[] = [];
  const imports: ImportDeclaration[] = [];
  const decorators: DecoratorUse[] = [];
  const classes: ClassDeclaration[] = [];
  let packageName: string | undefined;

  const visit = (node: Node) => {
    const type = node.type;
    if (type === 'line_comment' || type === 'block_comment') return;
    if (type === 'package_declaration') {
      packageName ??= node.namedChildren.find((c) => c && /identifier$/.test(c.type))?.text;
      return;
    }
    if (type === 'import_declaration') {
      const path = node.namedChildren.find((c) => c && /identifier$/.test(c.type));
      if (path) {
        const wildcard = node.namedChildren.some((c) => c?.type === 'asterisk');
        const source = wildcard ? `${path.text}.*` : path.text;
        imports.push({
          source,
          names: wildcard ? [] : [source.slice(source.lastIndexOf('.') + 1)],
          line: line(node),
        });
      }
      return;
    }
    if (ANNOTATIONS.has(type)) {
      const use = annotationUse(node);
      if (use) decorators.push(use);
    }
    if (CLASS_TYPES.has(type)) {
      const decl = classDeclaration(node);
      if (decl) classes.push(decl);
    }
    if (type === 'field_declaration') {
      for (const d of node.childrenForFieldName('declarator')) {
        const name = d?.childForFieldName('name');
        if (name) fields.push({ name: name.text, line: line(name) });
      }
    }
    // Record components and enum constants are reached like fields: `point.x()`, `Color.RED`.
    if (type === 'record_declaration') {
      for (const p of node.childForFieldName('parameters')?.namedChildren ?? []) {
        const name = p?.childForFieldName('name');
        if (name) fields.push({ name: name.text, line: line(name) });
      }
    }
    if (type === 'enum_constant') {
      const name = node.childForFieldName('name');
      if (name) fields.push({ name: name.text, line: line(name) });
    }
    if (type === 'identifier' || type === 'type_identifier') {
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

function kindOf(node: Node): ReferenceKind {
  const parent = node.parent;
  if (!parent) return 'name';
  if (DECLARATIONS.has(parent.type) && parent.childForFieldName('name')?.equals(node))
    return 'declaration';
  if (node.type === 'type_identifier') {
    return parent.type === 'object_creation_expression' &&
      parent.childForFieldName('type')?.equals(node)
      ? 'new'
      : 'type';
  }
  if (ANNOTATIONS.has(parent.type) && parent.childForFieldName('name')?.equals(node)) return 'type';
  if (parent.type === 'method_invocation' && parent.childForFieldName('name')?.equals(node))
    return 'call';
  if (parent.type === 'field_access' && parent.childForFieldName('field')?.equals(node))
    return 'member';
  return 'name';
}

function annotationUse(node: Node): DecoratorUse | undefined {
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return undefined;
  const name = nameNode.text.slice(nameNode.text.lastIndexOf('.') + 1);
  const args: string[] = [];
  const refs: string[] = [];
  const list = node.childForFieldName('arguments');
  if (list) {
    for (const s of list.descendantsOfType('string_literal'))
      if (s) args.push(s.namedChildren.find((c) => c?.type === 'string_fragment')?.text ?? '');
    for (const id of list.descendantsOfType('identifier')) {
      if (!id) continue;
      // `key = value`: the key names the annotation's element, not something passed.
      const pair = id.parent?.type === 'element_value_pair' ? id.parent : null;
      if (!pair?.childForFieldName('key')?.equals(id)) refs.push(id.text);
    }
  }
  return { name, args, refs, line: line(node), target: annotationTarget(node) };
}

function annotationTarget(node: Node): DecoratorUse['target'] {
  // Annotations sit in the `modifiers` of what they annotate.
  const owner = node.parent?.type === 'modifiers' ? node.parent.parent : null;
  if (!owner) return { kind: 'other', name: '' };
  const nameOf = (n: Node) => n.childForFieldName('name')?.text ?? '';
  if (TYPE_DECLARATIONS.has(owner.type)) return { kind: 'class', name: nameOf(owner) };
  const className = enclosingClass(owner);
  const withClass = <T extends DecoratorUse['target']>(t: T): T =>
    className ? { ...t, className } : t;
  if (METHOD_TYPES.has(owner.type)) return withClass({ kind: 'method', name: nameOf(owner) });
  if (owner.type === 'field_declaration') {
    const d = owner.childForFieldName('declarator');
    return withClass({ kind: 'property', name: d ? nameOf(d) : '' });
  }
  if (owner.type === 'formal_parameter')
    return withClass({ kind: 'parameter', name: nameOf(owner) });
  return { kind: 'other', name: '' };
}

function enclosingClass(node: Node): string | undefined {
  for (let n: Node | null = node.parent; n; n = n.parent)
    if (TYPE_DECLARATIONS.has(n.type)) return n.childForFieldName('name')?.text;
  return undefined;
}

/** A type's name without package or type arguments: `java.util.List<User>` → `List`. */
function headName(type: Node): string {
  const head = type.type === 'generic_type' ? (type.namedChildren[0] ?? type) : type;
  return head.text.slice(head.text.lastIndexOf('.') + 1);
}

function classDeclaration(node: Node): ClassDeclaration | undefined {
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return undefined;
  const superclass = node.childForFieldName('superclass')?.namedChildren[0];
  const interfaces = node.childForFieldName('interfaces')?.namedChildren[0];
  const constructorParams: ClassDeclaration['constructorParams'] = [];
  // A record's components, else the first constructor's parameters.
  const params =
    node.type === 'record_declaration'
      ? node.childForFieldName('parameters')
      : node
          .childForFieldName('body')
          ?.namedChildren.find((m) => m?.type === 'constructor_declaration')
          ?.childForFieldName('parameters');
  for (const p of params?.namedChildren ?? []) {
    if (p?.type !== 'formal_parameter') continue;
    const name = p.childForFieldName('name');
    const type = p.childForFieldName('type');
    if (!name || !type) continue;
    constructorParams.push({
      name: name.text,
      types: type.descendantsOfType('type_identifier').flatMap((t) => (t ? [t.text] : [])),
      line: line(p),
    });
  }
  return {
    name: nameNode.text,
    line: line(nameNode),
    extends: superclass ? [headName(superclass)] : [],
    implements: (interfaces?.namedChildren ?? []).flatMap((t) => (t ? [headName(t)] : [])),
    constructorParams,
  };
}
