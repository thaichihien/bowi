/**
 * Names used in a file, for building the change graph (GRAPH-1..3).
 *
 * - references: every identifier-like token with how it is used (call, new, type, member, key,
 *   name) and its line. Names being declared (a function's or field's own name) are
 *   `declaration`, not uses.
 * - fields: properties declared in classes, interfaces and object types.
 * - imports: module specifiers with the names they bring in.
 */

import type { Node } from 'web-tree-sitter';

export type ReferenceKind = 'call' | 'new' | 'type' | 'member' | 'key' | 'name' | 'declaration';

export interface Reference {
  name: string;
  kind: ReferenceKind;
  /** 1-based. */
  line: number;
}

export interface FieldDeclaration {
  name: string;
  line: number;
}

export interface ImportDeclaration {
  /** Module specifier as written, e.g. `../mail/mail.service`. */
  source: string;
  names: string[];
  line: number;
}

const IDENTIFIER_TYPES = new Set([
  'identifier',
  'property_identifier',
  'type_identifier',
  'shorthand_property_identifier',
]);
const FIELD_TYPES = new Set(['public_field_definition', 'field_definition', 'property_signature']);
const DECLARATION_PARENTS = new Set([
  'function_declaration',
  'generator_function_declaration',
  'function_signature',
  'class_declaration',
  'abstract_class_declaration',
  'method_definition',
  'method_signature',
  'abstract_method_signature',
  'interface_declaration',
  'type_alias_declaration',
  'enum_declaration',
  'variable_declarator',
  ...FIELD_TYPES,
]);

export interface NameIndex {
  references: Reference[];
  fields: FieldDeclaration[];
  imports: ImportDeclaration[];
}

export function indexNames(root: Node): NameIndex {
  const references: Reference[] = [];
  const fields: FieldDeclaration[] = [];
  const imports: ImportDeclaration[] = [];

  const visit = (node: Node) => {
    const type = node.type;
    if (type === 'comment') return;
    if (
      type === 'import_statement' ||
      (type === 'export_statement' && node.childForFieldName('source'))
    ) {
      const source = node.childForFieldName('source');
      if (source) {
        imports.push({
          source: stringValue(source),
          names: node
            .descendantsOfType(['identifier', 'type_identifier'])
            .flatMap((n) => (n ? [n.text] : [])),
          line: node.startPosition.row + 1,
        });
      }
      return; // names in import lines are not uses
    }
    if (FIELD_TYPES.has(type)) {
      const name = node.childForFieldName('name') ?? node.childForFieldName('property');
      if (name) fields.push({ name: name.text, line: name.startPosition.row + 1 });
    }
    if (IDENTIFIER_TYPES.has(type)) {
      references.push({ name: node.text, kind: kindOf(node), line: node.startPosition.row + 1 });
      return;
    }
    for (const child of node.children) visit(child);
  };
  visit(root);
  return { references, fields, imports };
}

function kindOf(node: Node): ReferenceKind {
  const parent = node.parent;
  if (
    parent &&
    DECLARATION_PARENTS.has(parent.type) &&
    (parent.childForFieldName('name') ?? parent.childForFieldName('property'))?.equals(node)
  ) {
    return 'declaration';
  }
  if (node.type === 'type_identifier') return 'type';
  if (node.type === 'shorthand_property_identifier') return 'key';
  if (!parent) return 'name';
  if (parent.type === 'call_expression' && parent.childForFieldName('function')?.equals(node))
    return 'call';
  if (parent.type === 'new_expression' && parent.childForFieldName('constructor')?.equals(node))
    return 'new';
  if (parent.type === 'member_expression' && parent.childForFieldName('property')?.equals(node)) {
    const grand = parent.parent;
    if (grand?.type === 'call_expression' && grand.childForFieldName('function')?.equals(parent))
      return 'call';
    return 'member';
  }
  if (parent.type === 'pair' && parent.childForFieldName('key')?.equals(node)) return 'key';
  return 'name';
}

function stringValue(node: Node): string {
  const fragment = node.namedChildren.find((c) => c?.type === 'string_fragment');
  return fragment?.text ?? node.text.replace(/^['"`]|['"`]$/g, '');
}
