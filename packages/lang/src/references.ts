/**
 * Names used in a file, for building the change graph (GRAPH-1..3).
 *
 * - references: every identifier-like token with how it is used (call, new, type, member, key,
 *   name) and its line. Names being declared (a function's or field's own name) are
 *   `declaration`, not uses.
 * - fields: properties declared in classes, interfaces and object types.
 * - imports: module specifiers with the names they bring in.
 * - decorators and classes: what framework plugins need (PLG-2), e.g. `@Controller('auth')` on
 *   a class, `@Get(':id')` on a method, the types a constructor injects.
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
const CLASS_TYPES = new Set(['class_declaration', 'abstract_class_declaration', 'class']);
const PARAMETER_TYPES = new Set(['required_parameter', 'optional_parameter']);
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

export interface DecoratorUse {
  /** `Controller` for `@Controller('auth')`, `Get` for `@nest.Get()`. */
  name: string;
  /** String literals in the arguments, in order: `['auth']`, `['email_verified']` for `{ name: 'email_verified' }`. */
  args: string[];
  /** Identifiers passed as arguments: `['AdminGuard']` for `@UseGuards(AdminGuard)`. */
  refs: string[];
  /** 1-based line of the `@`. */
  line: number;
  /** What the decorator is called on, in Python: `app` for `@app.get('/users')`, `api.v1` too. */
  receiver?: string;
  target: {
    kind: 'class' | 'method' | 'property' | 'parameter' | 'other';
    /** The decorated name: class, method, property or parameter. */
    name: string;
    /** Enclosing class, for members and parameters. */
    className?: string;
  };
}

export interface ClassDeclaration {
  name: string;
  /** 1-based line of the name. */
  line: number;
  /** Names in `extends` and `implements`, without type arguments. */
  extends: string[];
  implements: string[];
  /** Constructor parameters with the type names in their annotation (`Repository<User>` → both). */
  constructorParams: { name: string; types: string[]; line: number }[];
}

export interface NameIndex {
  references: Reference[];
  fields: FieldDeclaration[];
  imports: ImportDeclaration[];
  decorators: DecoratorUse[];
  classes: ClassDeclaration[];
  /** Directive prologue of the file: `use client`, `use server`. */
  directives: string[];
  /**
   * The package the file declares (M16): Java's and Kotlin's `package a.b`, C#'s first
   * namespace. Files of one package see each other without imports.
   */
  packageName?: string;
}

export function indexNames(root: Node): NameIndex {
  const references: Reference[] = [];
  const fields: FieldDeclaration[] = [];
  const imports: ImportDeclaration[] = [];
  const decorators: DecoratorUse[] = [];
  const classes: ClassDeclaration[] = [];

  const visit = (node: Node) => {
    const type = node.type;
    if (type === 'comment') return;
    if (type === 'decorator') {
      const use = decoratorUse(node);
      if (use) decorators.push(use);
    }
    if (CLASS_TYPES.has(type)) {
      const decl = classDeclaration(node);
      if (decl) classes.push(decl);
    }
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
      // Names in import lines are not uses. A re-export (`export { a } from './x'`) is: the file
      // offers `a` to its importers, so a changed re-export depends on what it names.
      if (type === 'export_statement') {
        for (const n of node.descendantsOfType(['identifier', 'type_identifier'])) {
          if (!n || n.parent?.type === 'namespace_export') continue;
          const named = n.parent?.type === 'export_specifier' ? n.parent : null;
          // `export { a as b }`: `a` is the use, `b` a new name.
          if (named && named.childForFieldName('alias')?.equals(n)) continue;
          references.push({ name: n.text, kind: 'name', line: n.startPosition.row + 1 });
        }
      }
      return;
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
  // Directives open a file: `'use client'`, `'use server'` (React frameworks, M14).
  const directives: string[] = [];
  for (const child of root.namedChildren) {
    if (!child || child.type === 'comment') continue;
    const str = child.type === 'expression_statement' ? child.namedChild(0) : null;
    if (str?.type !== 'string') break;
    directives.push(str.text.slice(1, -1));
  }
  return { references, fields, imports, decorators, classes, directives };
}

function decoratorUse(node: Node): DecoratorUse | undefined {
  const expr = node.namedChildren[0];
  if (!expr) return undefined;
  const callee = expr.type === 'call_expression' ? expr.childForFieldName('function') : expr;
  const name =
    callee?.type === 'member_expression'
      ? callee.childForFieldName('property')?.text
      : callee?.type === 'identifier'
        ? callee.text
        : undefined;
  if (!name) return undefined;
  const argsNode = expr.type === 'call_expression' ? expr.childForFieldName('arguments') : null;
  const args: string[] = [];
  const refs: string[] = [];
  if (argsNode) {
    for (const s of argsNode.descendantsOfType(['string', 'template_string'])) {
      if (s && !s.descendantsOfType('template_substitution').length) args.push(stringValue(s));
    }
    for (const a of argsNode.namedChildren) if (a?.type === 'identifier') refs.push(a.text);
  }
  return { name, args, refs, line: node.startPosition.row + 1, target: decoratorTarget(node) };
}

function decoratorTarget(node: Node): DecoratorUse['target'] {
  const parent = node.parent;
  if (!parent) return { kind: 'other', name: '' };
  const nameOf = (n: Node | null | undefined) =>
    (n?.childForFieldName('name') ?? n?.childForFieldName('property'))?.text ?? '';
  if (CLASS_TYPES.has(parent.type)) return { kind: 'class', name: nameOf(parent) };
  if (parent.type === 'export_statement') {
    const decl = parent.childForFieldName('declaration');
    if (decl && CLASS_TYPES.has(decl.type)) return { kind: 'class', name: nameOf(decl) };
    return { kind: 'other', name: '' };
  }
  const className = enclosingClass(parent);
  const withClass = <T extends DecoratorUse['target']>(t: T): T =>
    className ? { ...t, className } : t;
  if (FIELD_TYPES.has(parent.type)) return withClass({ kind: 'property', name: nameOf(parent) });
  if (PARAMETER_TYPES.has(parent.type)) {
    const pattern = parent.childForFieldName('pattern');
    return withClass({ kind: 'parameter', name: pattern?.text ?? '' });
  }
  if (parent.type === 'class_body') {
    // Method decorators are siblings written before the method.
    let next = node.nextNamedSibling;
    while (next?.type === 'decorator') next = next.nextNamedSibling;
    if (next?.type === 'method_definition')
      return withClass({ kind: 'method', name: nameOf(next) });
    if (next && FIELD_TYPES.has(next.type))
      return withClass({ kind: 'property', name: nameOf(next) });
  }
  return { kind: 'other', name: '' };
}

function enclosingClass(node: Node): string | undefined {
  for (let n: Node | null = node; n; n = n.parent) {
    if (CLASS_TYPES.has(n.type)) return n.childForFieldName('name')?.text;
  }
  return undefined;
}

function classDeclaration(node: Node): ClassDeclaration | undefined {
  const nameNode = node.childForFieldName('name');
  if (!nameNode) return undefined;
  const extendsNames: string[] = [];
  const implementsNames: string[] = [];
  const heritage = node.namedChildren.find((c) => c?.type === 'class_heritage');
  for (const clause of heritage?.namedChildren ?? []) {
    if (!clause) continue;
    const into = clause.type === 'implements_clause' ? implementsNames : extendsNames;
    for (const t of clause.namedChildren) {
      const head = t?.type === 'generic_type' ? t.childForFieldName('name') : t;
      if (
        head &&
        /^(identifier|type_identifier|member_expression|nested_type_identifier)$/.test(head.type)
      )
        into.push(head.text.slice(head.text.lastIndexOf('.') + 1));
    }
  }
  // JavaScript: `class A extends B` has the expression directly under class_heritage.
  if (heritage && extendsNames.length === 0 && implementsNames.length === 0) {
    const value = heritage.namedChildren.find((c) => c?.type === 'identifier');
    if (value) extendsNames.push(value.text);
  }
  const body = node.childForFieldName('body');
  const ctor = body?.namedChildren.find(
    (m) => m?.type === 'method_definition' && m.childForFieldName('name')?.text === 'constructor',
  );
  const constructorParams: ClassDeclaration['constructorParams'] = [];
  for (const p of ctor?.childForFieldName('parameters')?.namedChildren ?? []) {
    if (!p || !PARAMETER_TYPES.has(p.type)) continue;
    const pattern = p.childForFieldName('pattern');
    const annotation = p.childForFieldName('type');
    if (!pattern || !annotation) continue;
    constructorParams.push({
      name: pattern.text,
      types: annotation.descendantsOfType('type_identifier').flatMap((t) => (t ? [t.text] : [])),
      line: p.startPosition.row + 1,
    });
  }
  return {
    name: nameNode.text,
    line: nameNode.startPosition.row + 1,
    extends: extendsNames,
    implements: implementsNames,
    constructorParams,
  };
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
