/**
 * Line-sequence similarity for moved-with-edits detection (NOISE-4).
 */

export interface LineMatch {
  /** 2·LCS / (a + b), 1 when both are empty. */
  similarity: number;
  /** Indexes into `a` / `b` that are not part of the longest common subsequence. */
  unmatchedA: number[];
  unmatchedB: number[];
}

export function matchLines(a: string[], b: string[]): LineMatch {
  const n = a.length;
  const m = b.length;
  // dp[i][j] = LCS length of a[i..] and b[j..]
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const matchedA = new Set<number>();
  const matchedB = new Set<number>();
  for (let i = 0, j = 0; i < n && j < m;) {
    if (a[i] === b[j]) {
      matchedA.add(i++);
      matchedB.add(j++);
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) i++;
    else j++;
  }
  const lcs = matchedA.size;
  return {
    similarity: n + m === 0 ? 1 : (2 * lcs) / (n + m),
    unmatchedA: [...Array(n).keys()].filter((i) => !matchedA.has(i)),
    unmatchedB: [...Array(m).keys()].filter((j) => !matchedB.has(j)),
  };
}
