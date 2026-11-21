/**
 * Names used in a Go file (M15), the same index as references.ts builds for TypeScript:
 * references with how they are used, struct fields, imports and structs.
 *
 * An import's source is its package path (`github.com/acme/app/internal/auth`) and its name the
 * one the file uses (`auth`, or the alias). Go has no decorators; files of one package see each
 * other without imports, which the language family in the engine knows.
 */

import type { Node } from 'web-tree-sitter';
import type {
  ClassDeclaration,
  FieldDeclaration,
  ImportDeclaration,
  NameIndex,
  Reference,
  ReferenceKind,
} from './references.ts';

const IDENTIFIERS = new Set([
  'identifier',
  'type_identifier',
  'field_identifier',
  'package_identifier',
]);
/** Nodes whose `name` field declares a name rather than using one. */
const DECLARATIONS = new Set([
  'function_declaration',
  'method_declaration',
  'type_spec',
  'type_alias',
  'field_declaration',
  'const_spec',
  'var_spec',
  'method_elem',
]);

export function indexGo(root: Node): NameIndex {
  const references: Reference[] = [];
  const fields: FieldDeclaration[] = [];
  const imports: ImportDeclaration[] = [];
  const classes: ClassDeclaration[] = [];

  const visit = (node: Node) => {
    const type = node.type;
    if (type === 'comment') return;
    if (type === 'import_spec') {
      const path = node.childForFieldName('path');
      if (path) {
        const source = path.text.replace(/^["`]|["`]$/g, '');
        const alias = node.childForFieldName('name')?.text;
        imports.push({
          source,
          names: [alias ?? source.slice(source.lastIndexOf('/') + 1)],
          line: node.startPosition.row + 1,
        });
      }
      return;
    }
    if (type === 'type_spec' && node.childForFieldName('type')?.type === 'struct_type') {
      const name = node.childForFieldName('name');
      if (name)
        classes.push({
          name: name.text,
          line: name.startPosition.row + 1,
          extends: [],
          implements: [],
          constructorParams: [],
        });
    }
    if (type === 'field_declaration') {
      for (const n of node.childrenForFieldName('name'))
        if (n) fields.push({ name: n.text, line: n.startPosition.row + 1 });
    }
    if (IDENTIFIERS.has(type)) {
      references.push({ name: node.text, kind: kindOf(node), line: node.startPosition.row + 1 });
      return;
    }
    for (const child of node.children) if (child) visit(child);
  };
  visit(root);
  return { references, fields, imports, decorators: [], classes, directives: [] };
}

function kindOf(node: Node): ReferenceKind {
  const parent = node.parent;
  if (!parent) return 'name';
  if (
    DECLARATIONS.has(parent.type) &&
    parent.childrenForFieldName('name').some((n) => n?.equals(node))
  )
    return 'declaration';
  if (node.type === 'type_identifier') {
    // `Server{…}` builds a value of the type.
    return parent.type === 'composite_literal' ? 'new' : 'type';
  }
  if (parent.type === 'call_expression' && parent.childForFieldName('function')?.equals(node))
    return 'call';
  if (parent.type === 'selector_expression' && parent.childForFieldName('field')?.equals(node)) {
    const grand = parent.parent;
    if (grand?.type === 'call_expression' && grand.childForFieldName('function')?.equals(parent))
      return 'call';
    return 'member';
  }
  if (parent.type === 'keyed_element' && parent.namedChildren[0]?.equals(node)) return 'key';
  return 'name';
}
