/**
 * Output contract of the Bowi engine: `review-plan.json` (requirement.md §8).
 *
 * The engine writes a ReviewPlan; renderers only read it. Keep this file in sync with §8.
 */

export interface ReviewPlan {
  schemaVersion: 1;
  generatedAt: string; // ISO timestamp (excluded from determinism checks)
  tool: { name: 'bowi'; version: string };
  source: {
    kind: 'github' | 'local';
    repo: string; // "owner/name" or local folder name
    prNumber?: number;
    title?: string;
    description?: string;
    author?: string;
    baseRef: string;
    headRef: string;
    baseSha: string;
    headSha: string;
    mergeBaseSha: string;
    commits: { sha: string; subject: string }[];
  };
  stats: {
    files: number;
    hunks: number;
    additions: number;
    deletions: number;
    reviewLines: number; // changed lines in logic hunks + changed lines inside moves
    noiseLines: number;
  };
  files: FileChange[];
  hunks: Hunk[];
  symbols: ChangedSymbol[];
  edges: ChangeEdge[];
  groups: Group[]; // already in reading order
  outsideRefs: OutsideReference[];
  hints: ReviewHint[];
  meta: {
    ai: { enabled: boolean; provider?: string; model?: string };
    languages: string[];
    plugins: string[];
    warnings: string[]; // e.g. "src/legacy.js failed to parse; used text-only analysis"
    timingsMs: Record<string, number>;
  };
}

export interface FileChange {
  id: string;
  path: string;
  oldPath?: string;
  status: 'added' | 'deleted' | 'modified' | 'renamed' | 'copied' | 'binary' | 'mode';
  language?: string;
  parseStatus: 'ok' | 'error' | 'unsupported';
  layer: Layer;
  additions: number;
  deletions: number;
  generated: boolean;
}

export type Layer =
  'schema' | 'data' | 'domain' | 'service' | 'api' | 'ui' | 'config' | 'test' | 'docs' | 'unknown';

export interface Hunk {
  id: string;
  fileId: string;
  header: string; // e.g. "register()" or the git @@ section text
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
  kind: 'logic' | 'generated' | 'format' | 'move';
  symbolIds: string[];
  move?: {
    fromFileId: string; // file the code was moved out of (same on both halves)
    fromStart: number; // first line of the moved code in that file, old version
    similarity: number; // 1 = moved unchanged (formatting ignored)
    changedLineIndexes: number[]; // indexes into this hunk's `lines` that differ from the other half
    pairHunkId: string; // the other half: the deletion for an addition and vice versa
  };
}

export interface DiffLine {
  kind: 'context' | 'add' | 'del';
  text: string;
  oldNo?: number;
  newNo?: number;
  html?: string; // pre-highlighted by shiki at build time
  noEol?: boolean; // line has no trailing newline ("\ No newline at end of file")
}

export interface ChangedSymbol {
  id: string;
  name: string; // "verifyEmail"
  qualifiedName: string; // "AuthService.verifyEmail"
  kind: 'function' | 'method' | 'class' | 'interface' | 'type' | 'variable' | 'section' | 'file';
  fileId: string;
  change: 'added' | 'deleted' | 'signature' | 'body' | 'renamed' | 'moved';
  layer: Layer;
  hunkIds: string[];
  oldSignature?: string;
  newSignature?: string;
}

export interface ChangeEdge {
  from: string;
  to: string; // symbol ids
  type:
    | 'calls'
    | 'uses-type'
    | 'tests'
    | 'same-symbol'
    | 'shared-literal'
    | 'same-commit'
    | 'co-change'
    | 'docs-mentions'
    | 'framework';
  weight: number; // after hub down-weighting
  evidence: { text: string; locations: { fileId: string; line: number }[] };
}

export interface Group {
  id: string;
  title: string;
  titleSource: 'rule' | 'ai';
  kind: 'feature' | 'refactor' | 'move' | 'fix' | 'test' | 'config' | 'docs' | 'noise' | 'mixed';
  intent?: string; // AI only
  confidence: 'high' | 'medium' | 'low';
  reasons: string[];
  steps: Step[]; // in reading order (default order)
  testsFirstStepOrder: string[]; // step ids for the tests-first mode
  summary?: string; // for noise groups
  dependsOn: string[]; // group ids
}

export interface Step {
  id: string;
  title: string; // "Data shape", "Auth service"
  layer: Layer;
  hunkIds: string[]; // in reading order
}

export interface OutsideReference {
  symbolId: string;
  fileId?: string;
  path: string;
  line: number;
  excerpt: string;
}

export interface ReviewHint {
  id: string;
  ruleId: string; // "migration", "public-route", ...
  severity: 'info' | 'attention';
  message: string;
  target: { groupId?: string; stepId?: string; hunkId?: string; symbolId?: string };
}
