/**
 * Structural fingerprints of syntax trees (NOISE-2, NOISE-3).
 *
 * A fingerprint serializes node types and token text while ignoring what formatters change:
 * whitespace and line breaks (never part of tokens), `;` and `,` separator tokens, string quote
 * characters, and whitespace inside comments. Comment text itself counts: an edited doc comment
 * describes changed behaviour and must stay visible (requirement.md §15 #10). Statement and
 * argument boundaries remain visible through the named node structure, so a semicolon that
 * changes how code parses still changes the fingerprint.
 */

import { createHash } from 'node:crypto';
import type { Node } from 'web-tree-sitter';

const DROPPED_TOKENS = new Set([';', ',', "'", '"']);

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
  if (node.childCount === 0) {
    if (!node.isNamed) {
      if (!DROPPED_TOKENS.has(node.type)) out.push(node.type);
      return;
    }
    out.push(`${node.type}:${node.text}`);
    return;
  }
  out.push(`(${node.type}`);
  for (const child of node.children) serialize(child, out, skip);
  out.push(')');
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
      (c) => !isIgnored(c) && c.startPosition.row <= endRow && c.endPosition.row >= startRow,
    );
    const only = kids[0];
    if (
      kids.length === 1 &&
      only &&
      only.childCount > 0 &&
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
  const lines = new Set<number>();
  const visit = (node: Node) => {
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
