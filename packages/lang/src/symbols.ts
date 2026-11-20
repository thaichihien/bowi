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
    }

    seen.add(node.id);
    candidates.push({
      node,
      range: rangeNodes(node),
      nameNode: nameCapture.node,
      name,
      kind,
      exported: isExported(node),
    });
  }

  candidates.sort(
    (a, b) => a.range[0]!.startIndex - b.range[0]!.startIndex || b.node.endIndex - a.node.endIndex,
  );

  const symbols: SourceSymbol[] = [];
  // What a symbol's children are qualified with: its own qualified name, except for Markdown
  // sections that end a run of headings without text between them (below).
  const prefixes: (string | null)[] = [];
  const stack: number[] = [];
  for (const c of candidates) {
    while (stack.length > 0 && candidates[stack.at(-1)!]!.node.endIndex <= c.node.startIndex)
      stack.pop();
    const parent = stack.length > 0 ? stack.at(-1)! : null;
    const prefix = parent === null ? null : prefixes[parent]!;
    let own = c.name;
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

function isExported(node: Node): boolean {
  const p = node.parent;
  if (p?.type === 'export_statement') return true;
  return node.type === 'variable_declarator' && p?.parent?.type === 'export_statement';
}

function signatureOf(node: Node, range: Node[], source: string): string {
  const start = range[0]!.startIndex;
  const body = node.childForFieldName('body') ?? node.childForFieldName('value');
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
