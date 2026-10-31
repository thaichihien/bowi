/**
 * Adjusted Rand Index (Hubert & Arabie, 1985): how well two partitions of the same items agree,
 * corrected for chance. 1 = the same partition (label names do not matter), 0 = what random
 * grouping would score on average, below 0 = worse than chance.
 *
 * Used to compare Bowi's groups with the commits a synthetic PR was squashed from (§12.3).
 */

/** ARI of two labelings of the same items; NaN with fewer than two items. */
export function adjustedRandIndex(a: readonly string[], b: readonly string[]): number {
  if (a.length !== b.length) throw new Error('labelings differ in length');
  const n = a.length;
  const pairs = (x: number) => (x * (x - 1)) / 2;
  const total = pairs(n);
  if (total === 0) return NaN;

  const cells = new Map<string, number>();
  const rows = new Map<string, number>();
  const cols = new Map<string, number>();
  for (let i = 0; i < n; i++) {
    const key = `${a[i]}\u0000${b[i]}`;
    cells.set(key, (cells.get(key) ?? 0) + 1);
    rows.set(a[i]!, (rows.get(a[i]!) ?? 0) + 1);
    cols.set(b[i]!, (cols.get(b[i]!) ?? 0) + 1);
  }
  const sum = (m: Map<string, number>) => [...m.values()].reduce((s, x) => s + pairs(x), 0);
  const index = sum(cells);
  const sumA = sum(rows);
  const sumB = sum(cols);
  const expected = (sumA * sumB) / total;
  const max = (sumA + sumB) / 2;
  // Both partitions trivial in the same way (all together, or all apart): they agree fully.
  if (max === expected) return index === max ? 1 : 0;
  return (index - expected) / (max - expected);
}
