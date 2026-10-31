/**
 * Optional AI enrichment (§7.11): what the engine sends to an AI provider and what it accepts.
 *
 * The enricher (`@bowi/ai`) is passed to `analyze()` by the CLI, like plugins, so the engine does
 * no I/O of its own. The engine builds every request from the analysis (AI-4: group symbols,
 * links, trimmed diff lines, PR title and description; never noise hunks or whole files) and
 * validates every answer with the schemas below before using it (AI-5).
 */

import { z } from 'zod';

/** The pull request as the AI sees it: metadata only, no code. */
export interface AiPullRequest {
  repo: string;
  prNumber?: number;
  title?: string;
  /** Trimmed to a few thousand characters. */
  description?: string;
  baseRef: string;
  headRef: string;
  /** Commit subjects, oldest first, at most a few dozen. */
  commits: string[];
}

export interface AiHunk {
  id: string;
  path: string;
  /** Symbol named in the hunk's header bar, e.g. "register()". */
  header: string;
  /** Changed symbols in the hunk: "AuthService.register (body)". */
  symbols: string[];
  /** "+added", "-removed", " context" (only near changes), "⋯" where lines were left out. */
  lines: string[];
  /** Changed lines not sent (hunk too long, or the group's budget used up). */
  omittedLines: number;
}

export interface AiGroupInput {
  pr: AiPullRequest;
  group: {
    id: string;
    /** The rule-based title (GRP-10), as a starting point. */
    title: string;
    kind: string;
    /** "Why these changes are grouped" sentences. */
    reasons: string[];
    steps: { title: string; hunkIds: string[] }[];
    symbols: string[];
  };
  /** The group's hunks in reading order; all are logic hunks. */
  hunks: AiHunk[];
  /** The other logic groups: where a hunk of this group may be moved (AI-3). */
  otherGroups: { id: string; title: string; files: string[]; symbols: string[] }[];
}

export interface AiOverviewInput {
  pr: AiPullRequest;
  /** Logic groups in reading order, with the titles and intents the AI gave them. */
  groups: {
    id: string;
    title: string;
    intent?: string;
    kind: string;
    files: number;
    changedLines: number;
  }[];
  /** Collapsed groups (moved code, noise), by title. */
  collapsed: string[];
}

const oneLine = /^[^\r\n]*$/;

/** Answer for one group: a new title, an intent, and hunks that belong to another group. */
export const aiGroupAnswer = z.object({
  title: z.string().trim().min(3).max(100).regex(oneLine, 'must be one line'),
  intent: z.string().trim().min(10).max(600),
  moves: z
    .array(
      z.object({
        hunkId: z.string(),
        toGroupId: z.string(),
        reason: z.string().trim().min(3).max(300),
      }),
    )
    .max(50),
});
export type AiGroupAnswer = z.infer<typeof aiGroupAnswer>;

/** Answer for the whole pull request: a short overview. */
export const aiOverviewAnswer = z.object({
  overview: z.string().trim().min(10).max(1200),
});
export type AiOverviewAnswer = z.infer<typeof aiOverviewAnswer>;

/** JSON Schemas of the answers, for providers that can enforce structured output. */
export function aiAnswerJsonSchema(kind: 'group' | 'overview'): Record<string, unknown> {
  const { $schema: _ignored, ...schema } = z.toJSONSchema(
    kind === 'group' ? aiGroupAnswer : aiOverviewAnswer,
  ) as Record<string, unknown>;
  return schema;
}

/** What a provider returned, before validation. */
export interface AiAnswer {
  output: unknown;
  /** The model that answered, when the provider says. */
  model?: string;
  /** True when the answer came from Bowi's cache (AI-6). */
  cached?: boolean;
}

export interface AiEnricher {
  /** Provider id for `meta.ai.provider`, e.g. "claude-code". */
  id: string;
  /** Who receives the code, for the notice printed before AI runs (AI-1). */
  describe(): string;
  group(input: AiGroupInput, signal: AbortSignal): Promise<AiAnswer>;
  overview(input: AiOverviewInput, signal: AbortSignal): Promise<AiAnswer>;
}

/**
 * A failed AI call. `fatal` means every further call would fail the same way (not installed,
 * not logged in, usage limit), so the engine stops asking.
 */
export class AiError extends Error {
  readonly fatal: boolean;
  readonly hint: string | undefined;

  constructor(message: string, options: { fatal?: boolean; hint?: string } = {}) {
    super(message);
    this.name = 'AiError';
    this.fatal = options.fatal ?? false;
    this.hint = options.hint;
  }
}
