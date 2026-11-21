/**
 * Structural fingerprints of syntax trees (NOISE-2, NOISE-3).
 *
 * A fingerprint serializes node types and token text while ignoring what formatters change:
 * whitespace and line breaks (never part of tokens), `;` and `,` separator tokens, string quote
 * characters, and whitespace inside comments. Comment text itself counts: an edited doc comment
 * describes changed behaviour and must stay visible (requirement.md §15 #10). Statement and
 * argument boundaries remain visible through the named node structure, so a semicolon that
 * changes how code parses still changes the fingerprint.
 *
 * Markdown: line breaks inside a paragraph or heading do not count (re-wrapping text is
 * formatting), and the indentation that continues a list item or quote is ignored. Code blocks
 * and HTML blocks are compared by their text too, whitespace runs collapsed: the grammar keeps
 * only their punctuation as tokens, so `statusCodes: [413]` and `[500]` would otherwise match.
 */

import { createHash } from 'node:crypto';
import type { Node } from 'web-tree-sitter';

const DROPPED_TOKENS = new Set([';', ',', "'", '"']);
/** Python's string delimiters, prefix included: compared without their quote characters. */
const QUOTE_TOKENS = new Set(['string_start', 'string_end']);
/** Markdown text runs: compared by their text, whitespace collapsed, never by their tokens. */
const TEXT_RUNS = new Set(['inline', 'code_fence_content', 'indented_code_block', 'html_block']);
/** Markdown continuation markers: layout only, like whitespace. */
const LAYOUT_NODES = new Set(['block_continuation']);

export function isComment(node: Node): boolean {
  return node.type === 'comment' || node.type === 'html_comment';
}

/** Dropped separator tokens: invisible to fingerprints. */
function isIgnored(node: Node): boolean {
  return !node.isNamed && node.childCount === 0 && DROPPED_TOKENS.has(node.type);
}

/** Comment text without layout: line prefixes (`*`, `//`) and whitespace runs removed. */
function commentText(node: Node): string {
  return node.text
    .split('\n')
    .map((l) => l.trim().replace(/^(\/\/+|\/\*+|\*+\/?|\*)\s*/, ''))
    .join(' ')
    .replace(/\*+\/$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Appends the serialization of `node` to `out`; `skip` (if given) is serialized as `_`. */
export function serialize(node: Node, out: string[], skip?: Node): void {
  if (isComment(node)) {
    out.push(`comment:${commentText(node)}`);
    return;
  }
  if (skip && node.equals(skip)) {
    out.push('_');
    return;
  }
  if (LAYOUT_NODES.has(node.type)) return;
  if (TEXT_RUNS.has(node.type)) {
    out.push(`${node.type}:${runText(node)}`);
    return;
  }
  if (node.childCount === 0) {
    if (!node.isNamed) {
      if (!DROPPED_TOKENS.has(node.type)) out.push(node.type);
      return;
    }
    // Python keeps a string's quotes in named tokens: `'a'` and `"a"` are the same string; a
    // prefix (`f`, `r`, `b`) still counts.
    if (QUOTE_TOKENS.has(node.type)) {
      out.push(`${node.type}:${node.text.replace(/['"]/g, '')}`);
      return;
    }
    out.push(`${node.type}:${node.text}`);
    return;
  }
  out.push(`(${node.type}`);
  for (const child of node.children) serialize(child, out, skip);
  out.push(')');
}

/** A text run's text without continuation markers (`> `, indentation), whitespace collapsed. */
function runText(node: Node): string {
  let text = node.text;
  const markers = node.children.filter((c) => LAYOUT_NODES.has(c.type));
  for (const m of markers.reverse()) {
    const from = m.startIndex - node.startIndex;
    text = text.slice(0, from) + ' ' + text.slice(from + (m.endIndex - m.startIndex));
  }
  return text.replace(/\s+/g, ' ').trim();
}

export function hash(parts: string[]): string {
  return createHash('sha1').update(parts.join('\u0001')).digest('hex');
}

export function fingerprint(node: Node, skip?: Node): string {
  const out: string[] = [];
  serialize(node, out, skip);
  return hash(out);
}

/**
 * Fingerprint of the code on rows `startRow..endRow` (0-based, inclusive): descend from `root`
 * while a single child contains the whole range, then serialize every child overlapping it.
 * Equal results on two versions mean the code on those rows differs only in formatting.
 */
export function coverFingerprint(root: Node, startRow: number, endRow: number): string {
  let node = root;
  for (;;) {
    const kids = node.children.filter(
      (c) =>
        !isIgnored(c) &&
        !LAYOUT_NODES.has(c.type) &&
        c.startPosition.row <= endRow &&
        c.endPosition.row >= startRow,
    );
    const only = kids[0];
    if (
      kids.length === 1 &&
      only &&
      only.childCount > 0 &&
      !TEXT_RUNS.has(only.type) &&
      only.startPosition.row <= startRow &&
      only.endPosition.row >= endRow
    ) {
      node = only;
      continue;
    }
    const out = [node.type];
    for (const k of kids) serialize(k, out);
    return hash(out);
  }
}

/** 1-based line numbers that hold code or comment text (not blank). */
export function contentLines(root: Node): Set<number> {
  return linesOf(root, true);
}

/**
 * 1-based line numbers that hold code: a token that is not a comment. A line with code and a
 * trailing comment holds code.
 */
export function codeLines(root: Node): Set<number> {
  return linesOf(root, false);
}

function linesOf(root: Node, comments: boolean): Set<number> {
  const lines = new Set<number>();
  const visit = (node: Node) => {
    if (LAYOUT_NODES.has(node.type)) return;
    if (!comments && isComment(node)) return;
    if (TEXT_RUNS.has(node.type)) {
      // Only its non-blank lines: a code block can hold blank lines.
      node.text.split('\n').forEach((line, i) => {
        if (line.trim() !== '') lines.add(node.startPosition.row + i + 1);
      });
      return;
    }
    if (node.childCount === 0 || isComment(node)) {
      if (node.startIndex === node.endIndex) return; // zero-width (missing) token
      for (let row = node.startPosition.row; row <= node.endPosition.row; row++) lines.add(row + 1);
      return;
    }
    for (const child of node.children) visit(child);
  };
  visit(root);
  return lines;
}
