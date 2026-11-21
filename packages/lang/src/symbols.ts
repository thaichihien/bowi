/**
 * Symbol extraction (SYM-1): runs a language's symbol query and turns the matches into a flat,
 * position-ordered list with nesting, qualified names, signatures and fingerprints.
 */

import type { Node, Query } from 'web-tree-sitter';
import { fingerprint } from './fingerprint.ts';
import type { LanguageId } from './languages.ts';

export type SymbolKind =
  'function' | 'method' | 'class' | 'interface' | 'type' | 'variable' | 'section';

export interface SourceSymbol {
  /** Display name: `verifyEmail`, `describe('AuthService')`, `beforeEach()`. */
  name: string;
  /** Names of enclosing symbols joined with `.`, e.g. `AuthService.verifyEmail`. */
  qualifiedName: string;
  kind: SymbolKind;
  /** 1-based, inclusive. Includes `export`, decorators and the declaration keyword. */
  startLine: number;
  endLine: number;
  exported: boolean;
  /** Declaration text up to the body, whitespace collapsed: `async verifyEmail(token: string)`. */
  signature: string;
  /** Structural fingerprint of the whole symbol (formatting-insensitive). */
  fingerprint: string;
  /** Same, with the symbol's own name masked: equal for a renamed but otherwise same symbol. */
  shapeFingerprint: string;
  /** Index of the enclosing symbol in the list, or null at top level. */
  parent: number | null;
}

const KIND_OF_CAPTURE: Record<string, SymbolKind> = {
  'symbol.function': 'function',
  'symbol.method': 'method',
  'symbol.class': 'class',
  'symbol.interface': 'interface',
  'symbol.type': 'type',
  'symbol.variable': 'variable',
  'symbol.section': 'section',
  'symbol.test': 'function',
  'symbol.hook': 'function',
  // Module-level names in Python and Go (the query keeps them at top level).
  'symbol.constant': 'variable',
};

/**
 * JSON and YAML keys deeper than this many objects are not symbols (`dependencies.nodemailer`
 * and `jobs.build` are).
 */
const MAX_KEY_DEPTH = 2;
const MAPPING_TYPES = new Set(['object', 'block_mapping', 'flow_mapping']);

interface Candidate {
  node: Node;
  range: Node[];
  nameNode: Node;
  name: string;
  kind: SymbolKind;
  exported: boolean;
  /** Go: a method's receiver type, which qualifies its name (`Server.Start`). */
  receiver?: string;
}

export function extractSymbols(
  root: Node,
  query: Query,
  language: LanguageId,
  source: string,
): SourceSymbol[] {
  const candidates: Candidate[] = [];
  const seen = new Set<number>();

  for (const match of query.matches(root)) {
    const symbolCapture = match.captures.find((c) => c.name.startsWith('symbol.'));
    const nameCapture = match.captures.find((c) => c.name === 'name');
    if (!symbolCapture || !nameCapture) continue;
    const node = symbolCapture.node;
    if (seen.has(node.id)) continue;

    let kind = KIND_OF_CAPTURE[symbolCapture.name];
    if (!kind) continue;
    let name = nameCapture.node.text;

    if (symbolCapture.name === 'symbol.test') {
      const fn = match.captures.find((c) => c.name === 'test.fn')!.node.text;
      name = `${fn}(${nameCapture.node.text})`;
    } else if (symbolCapture.name === 'symbol.hook') {
      name = `${name}()`;
    } else if (language === 'json' || language === 'yaml') {
      if (keyDepth(node) > MAX_KEY_DEPTH) continue;
      name = language === 'json' ? jsonKey(nameCapture.node) : yamlKey(nameCapture.node);
      if (!name) continue;
    } else if (kind === 'section') {
      name = nameCapture.node.text.replace(/\s+/g, ' ').trim();
      if (!name) continue;
    } else if (symbolCapture.name === 'symbol.variable') {
      // Only top-level variables are symbols; locals belong to their function.
      const declaration = node.parent;
      const holder = declaration?.parent;
      if (
        !declaration ||
        !holder ||
        (holder.type !== 'program' && holder.type !== 'export_statement')
      ) {
        continue;
      }
      const value = node.childForFieldName('value');
      if (value && (value.type === 'arrow_function' || value.type === 'function_expression'))
        kind = 'function';
    } else if (node.type === 'type_spec') {
      // Go: a struct is a class, an interface an interface, anything else a type.
      const of = node.childForFieldName('type')?.type;
      kind = of === 'struct_type' ? 'class' : of === 'interface_type' ? 'interface' : 'type';
    } else if (language === 'kotlin' && node.type === 'class_declaration') {
      // Kotlin: `interface Dns` is a class declaration with the `interface` keyword.
      if (node.children.some((ch) => ch?.type === 'interface')) kind = 'interface';
    }

    seen.add(node.id);
    const receiver = node.type === 'method_declaration' ? receiverType(node) : undefined;
    candidates.push({
      node,
      range: rangeNodes(node),
      nameNode: nameCapture.node,
      name,
      kind,
      exported:
        language === 'go'
          ? /^[A-Z]/.test(name)
          : language === 'python'
            ? !name.startsWith('_') || /^__\w+__$/.test(name)
            : MEMBER_LANGUAGES.has(language)
              ? isVisible(node, language)
              : isExported(node),
      ...(receiver && { receiver }),
    });
  }

  candidates.sort(
    (a, b) => a.range[0]!.startIndex - b.range[0]!.startIndex || b.node.endIndex - a.node.endIndex,
  );

  const overloaded = MEMBER_LANGUAGES.has(language) ? overloads(candidates) : new Set<number>();

  const symbols: SourceSymbol[] = [];
  // What a symbol's children are qualified with: its own qualified name, except for Markdown
  // sections that end a run of headings without text between them (below).
  const prefixes: (string | null)[] = [];
  const stack: number[] = [];
  for (const [i, c] of candidates.entries()) {
    while (stack.length > 0 && candidates[stack.at(-1)!]!.node.endIndex <= c.node.startIndex)
      stack.pop();
    const parent = stack.length > 0 ? stack.at(-1)! : null;
    const prefix = c.receiver ?? (parent === null ? null : prefixes[parent]!);
    let own = c.name;
    // Python and Kotlin: a function defined directly in a class (Kotlin: also an object, an
    // interface or a class's companion object) is a method.
    if (
      (language === 'python' || language === 'kotlin') &&
      c.kind === 'function' &&
      parent !== null &&
      (symbols[parent]!.kind === 'class' ||
        (language === 'kotlin' && symbols[parent]!.kind === 'interface'))
    )
      c.kind = 'method';
    // Java, Kotlin, C#: overloads stay apart by their parameter types, `save(User)`; the name
    // stays `save`, which is what calls use.
    if (overloaded.has(i)) own = `${own}(${parameterTypes(c.node, language).join(', ')})`;
    // `###### hooks.beforeRetry` under `##### hooks`: `hooks.beforeRetry`, not `hooks.hooks.…`.
    if (c.kind === 'section' && parent !== null && own.startsWith(`${symbols[parent]!.name}.`))
      own = own.slice(symbols[parent]!.name.length + 1);
    const qualifiedName = prefix === null ? own : `${prefix}.${own}`;
    prefixes.push(c.kind === 'section' && endsHeadingRun(c.node) ? prefix : qualifiedName);
    const first = c.range[0]!;
    const last = c.range.at(-1)!;
    symbols.push({
      name: c.name,
      qualifiedName,
      kind: c.kind,
      startLine: first.startPosition.row + 1,
      // A node that ends at the start of a line (a Markdown section before the next heading)
      // ends on the line before.
      endLine:
        last.endPosition.column === 0 && last.endPosition.row > first.startPosition.row
          ? last.endPosition.row
          : last.endPosition.row + 1,
      exported: c.exported,
      signature:
        c.node.type === 'call_expression'
          ? c.name
          : c.kind === 'section'
            ? headingOf(c.node)
            : signatureOf(c.node, c.range, source),
      fingerprint: fingerprint(c.node),
      shapeFingerprint: fingerprint(c.node, c.nameNode),
      parent,
    });
    stack.push(symbols.length - 1);
  }
  return symbols;
}

/**
 * Nodes whose lines belong to the symbol: the declaration plus a wrapping `export` /
 * `lexical_declaration` and any decorators written before a class member.
 */
function rangeNodes(node: Node): Node[] {
  let top = node;
  // Python: `@decorator` lines belong to the function or class they decorate.
  if (node.parent?.type === 'decorated_definition') top = node.parent;
  if (
    node.type === 'variable_declarator' &&
    node.parent &&
    node.parent.namedChildren.filter((c) => c.type === 'variable_declarator').length === 1
  ) {
    top = node.parent;
  }
  if (top.parent?.type === 'export_statement') top = top.parent;

  const nodes = [top];
  let prev = top.previousSibling;
  while (prev && prev.type === 'decorator') {
    nodes.unshift(prev);
    prev = prev.previousSibling;
  }
  return nodes;
}

/** Languages whose functions live in classes and can be overloaded (M16). */
const MEMBER_LANGUAGES: ReadonlySet<LanguageId> = new Set(['java', 'kotlin', 'csharp']);

/** Candidates (by index) that share their name with a sibling function or method. */
function overloads(candidates: Candidate[]): Set<number> {
  const byKey = new Map<string, number[]>();
  const stack: number[] = [];
  candidates.forEach((c, i) => {
    while (stack.length > 0 && candidates[stack.at(-1)!]!.node.endIndex <= c.node.startIndex)
      stack.pop();
    const parent = stack.length > 0 ? stack.at(-1)! : -1;
    stack.push(i);
    if (c.kind !== 'method' && c.kind !== 'function') return;
    const key = `${parent}:${c.name}`;
    byKey.set(key, [...(byKey.get(key) ?? []), i]);
  });
  return new Set([...byKey.values()].filter((ids) => ids.length > 1).flat());
}

/**
 * A function's parameter types, without packages, namespaces or type arguments, so that a
 * qualified name stays one dotted path: `List<a.b.User>` → `List`, `String...` → `String[]`.
 * A Kotlin extension function's receiver comes first, as `this Socket`.
 */
function parameterTypes(fn: Node, language: LanguageId): string[] {
  const out: string[] = [];
  if (language === 'kotlin') {
    const name = fn.childForFieldName('name');
    const receiver = fn.namedChildren.find(
      (ch) => ch && name && ch.endIndex <= name.startIndex && KOTLIN_TYPES.has(ch.type),
    );
    if (receiver) out.push(`this ${simpleType(receiver.text)}`);
    const params = fn.namedChildren.find((ch) => ch?.type === 'function_value_parameters');
    for (const p of params?.namedChildren ?? []) {
      if (p?.type !== 'parameter') continue;
      const type = p.namedChildren.find((ch) => ch && KOTLIN_TYPES.has(ch.type));
      if (type) out.push(simpleType(type.text));
    }
    return out;
  }
  const params = fn.childForFieldName('parameters');
  for (const p of params?.namedChildren ?? []) {
    if (!p) continue;
    if (p.type === 'spread_parameter') {
      const type = p.namedChildren.find((ch) => ch && ch.type !== 'modifiers');
      if (type) out.push(`${simpleType(type.text)}[]`);
      continue;
    }
    const type = p.childForFieldName('type');
    if (type) out.push(simpleType(type.text));
  }
  return out;
}

const KOTLIN_TYPES = new Set(['user_type', 'nullable_type', 'function_type', 'parenthesized_type']);

function simpleType(text: string): string {
  let t = text.replace(/\s+/g, '');
  // Type arguments, innermost first.
  for (let prev = ''; prev !== t;) [prev, t] = [t, t.replace(/<[^<>]*>/g, '')];
  return t.replace(/\.\.\.$/, '[]').replace(/^(?:[\w]+\.)+/, '');
}

/**
 * Java, Kotlin, C#: whether code in another file can use the symbol. Java's package-private and
 * Kotlin's default are; `private` is not. C# members are private by default, types internal.
 */
function isVisible(node: Node, language: LanguageId): boolean {
  const modifiers =
    language === 'csharp'
      ? node.children.filter((ch) => ch?.type === 'modifier').map((ch) => ch!.text)
      : (node.children.find((ch) => ch?.type === 'modifiers')?.text.split(/\s+/) ?? []);
  if (modifiers.includes('private')) return false;
  if (language !== 'csharp') return true;
  if (modifiers.some((m) => m === 'public' || m === 'protected' || m === 'internal')) return true;
  // No access modifier: a member of a class, struct or record is private; a type outside any
  // type is internal, and an interface member public.
  const holder = node.parent?.type === 'declaration_list' ? node.parent.parent : null;
  return !holder || holder.type.includes('namespace') || holder.type === 'interface_declaration';
}

/** Go: the type a method is declared on, without `*` or type arguments: `Server`. */
function receiverType(method: Node): string | undefined {
  const param = method
    .childForFieldName('receiver')
    ?.namedChildren.find((c) => c?.type === 'parameter_declaration');
  const name = param?.childForFieldName('type')?.descendantsOfType('type_identifier')[0];
  return name?.text;
}

function isExported(node: Node): boolean {
  const p = node.parent;
  if (p?.type === 'export_statement') return true;
  return node.type === 'variable_declarator' && p?.parent?.type === 'export_statement';
}

function signatureOf(node: Node, range: Node[], source: string): string {
  const start = range[0]!.startIndex;
  const body =
    node.childForFieldName('body') ??
    node.childForFieldName('value') ??
    // C# properties; Kotlin bodies have no field name.
    node.childForFieldName('accessors') ??
    node.namedChildren.find((ch) => ch !== null && KOTLIN_BODIES.has(ch.type));
  let text: string;
  if (body && body.startIndex > start) {
    text = source.slice(start, body.startIndex);
  } else {
    text = source.slice(start, range.at(-1)!.endIndex);
  }
  text = text
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\s*[={:]$/, '');
  return text.length > 300 ? `${text.slice(0, 299)}…` : text;
}

const KOTLIN_BODIES = new Set(['class_body', 'enum_class_body', 'function_body']);

function keyDepth(pair: Node): number {
  let depth = 0;
  for (let n: Node | null = pair.parent; n; n = n.parent) if (MAPPING_TYPES.has(n.type)) depth++;
  return depth;
}

/** A YAML key's text without quotes; empty for complex keys (`? [a, b]`). */
function yamlKey(key: Node): string {
  const text = key.text.trim();
  if (/^(['"]).*\1$/s.test(text)) return text.slice(1, -1);
  return /[\n[\]{}]/.test(text) ? '' : text;
}

/**
 * A section right after sibling sections that hold only their heading: a list of headings such
 * as `### ky.get(input, options?)` … `### ky.query(input, options?)` that share what follows.
 * Its subsections belong to the whole list, so they are not named after its last heading.
 */
function endsHeadingRun(section: Node): boolean {
  const prev = section.previousNamedSibling;
  return (
    prev?.type === 'section' &&
    prev.namedChildren.length === 1 &&
    prev.namedChildren[0]?.type === 'atx_heading'
  );
}

/** A section's heading line as written, e.g. `## Email verification`. */
function headingOf(section: Node): string {
  const heading = section.namedChildren.find(
    (c) => c?.type === 'atx_heading' || c?.type === 'setext_heading',
  );
  const text = (heading?.text ?? '').split('\n')[0]!.replace(/\s+/g, ' ').trim();
  return text.length > 300 ? `${text.slice(0, 299)}…` : text;
}

function jsonKey(stringNode: Node): string {
  const content = stringNode.namedChildren.find((c) => c.type === 'string_content');
  return content?.text ?? stringNode.text.replace(/^"|"$/g, '');
}
