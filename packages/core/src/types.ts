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
    description?: string; // markdown, as written on the host
    /** Filled only in the plan embedded in review.html: `description` rendered and sanitized. */
    descriptionHtml?: string;
    author?: string;
    createdAt?: string; // ISO timestamp the pull request was opened
    baseRef: string;
    headRef: string;
    baseSha: string;
    headSha: string;
    mergeBaseSha: string;
    commits: Commit[]; // oldest first
    totalCommits?: number; // set when the host listed fewer commits than the PR has
    uncommitted?: boolean; // local: the working tree has changes not in HEAD
    linkedIssues?: string[]; // "#12", "owner/repo#5" from closing keywords in the description
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
  overview?: string; // AI only (AI-3): a short overview of the whole pull request
  outsideRefs: OutsideReference[];
  hints: ReviewHint[];
  /** The reviewer's own comments (M10): user data, never read by the engine nor compared (GRP-12). */
  review?: Review;
  meta: {
    ai: { enabled: boolean; provider?: string; model?: string; effort?: string };
    languages: string[];
    plugins: string[];
    /** Reading order the report opens with (CLI-7, config `order`); both orders are in `groups`. */
    order?: 'dependency' | 'tests-first';
    warnings: string[]; // e.g. "src/legacy.js failed to parse; used text-only analysis"
    timingsMs: Record<string, number>;
  };
}

export interface Commit {
  sha: string;
  subject: string;
  body?: string; // the message after the subject, trimmed; omitted when empty
  author: CommitPerson;
  authoredAt: string; // ISO timestamp with offset
  committer?: CommitPerson; // only when it differs from the author
  committedAt: string;
}

/** No email address: review.html may be shared. */
export interface CommitPerson {
  name: string;
  login?: string; // host account, when known
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
  | 'schema'
  | 'data'
  | 'util'
  | 'domain'
  | 'service'
  | 'api'
  | 'ui'
  | 'config'
  | 'test'
  | 'docs'
  | 'unknown';

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
  moveSuggestions?: MoveSuggestion[]; // AI only (AI-3): shown in the report, never applied
}

/** A hunk of this group that the AI thinks belongs to another group. */
export interface MoveSuggestion {
  hunkId: string;
  toGroupId: string;
  reason: string;
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

/**
 * Comments written in the report (UI-25..27), kept in the plan as a record. No author: the report
 * may be shared (§15 #27). A re-run carries them over (§15 #64).
 */
export interface Review {
  body: string; // the review summary, Markdown; '' when none
  comments: ReviewComment[];
}

export interface ReviewComment {
  id: string; // random, unique within the plan
  body: string; // Markdown, as written
  anchor: CommentAnchor;
  /** The commented lines as they read when written (none for a file comment). */
  snippet: SnippetLine[];
  createdAt: string; // ISO timestamp
  updatedAt: string;
  /** Outdated: the lines changed since; the comment keeps its anchor and snippet as written. */
  status: 'active' | 'outdated';
}

/**
 * Where a comment sits: a file, or lines shown in one of its hunks (GitHub and GitLab accept
 * comments on those only). Like GitHub's review comments: `line` and `side` are the last line,
 * `startLine` and `startSide` the first one of a range. Context lines are on the new side unless
 * commented in the old column of the split layout.
 */
export interface CommentAnchor {
  path: string;
  headSha: string; // head of the report the anchor belongs to
  hunkId?: string; // absent for a file comment
  line?: number;
  side?: 'old' | 'new';
  startLine?: number; // only for a range
  startSide?: 'old' | 'new';
}

export interface SnippetLine {
  kind: 'context' | 'add' | 'del';
  text: string;
  oldNo?: number;
  newNo?: number;
}

export interface ReviewHint {
  id: string;
  ruleId: string; // "migration", "public-route", ...
  severity: 'info' | 'attention';
  message: string;
  target: { groupId?: string; stepId?: string; hunkId?: string; symbolId?: string };
}
