/**
 * Stage: optional AI enrichment (AI-1..6), after groups.
 *
 * Input: the groups and the analysis they came from, plus an AiEnricher. Output: the groups with
 * AI titles and intents where an answer was valid, the AI's suggestions to move a hunk to another
 * group (shown in the report, never applied: the groups stay as Bowi made them), and a short PR
 * overview.
 *
 * One call per logic group (at most `concurrency` at a time, each with a timeout), then one for
 * the overview. Moved code and noise groups are never sent (AI-4). Every answer is validated
 * (AI-5); a failed, late or invalid answer keeps the rule-based result for that group and adds a
 * warning. A fatal error (not installed, not logged in) stops further calls. Suggestions that
 * name an unknown hunk or group, a hunk of another group, or a noise or moved-code group are
 * dropped with a warning.
 */

import {
  aiGroupAnswer,
  aiOverviewAnswer,
  AiError,
  type AiAnswer,
  type AiEnricher,
  type AiGroupAnswer,
  type AiGroupInput,
  type AiHunk,
  type AiOverviewInput,
  type AiPullRequest,
} from '../ai.ts';
import type { Stage, StageContext } from '../stage.ts';
import type {
  ChangedSymbol,
  ChangeEdge,
  FileChange,
  Group,
  Hunk,
  MoveSuggestion,
  ReviewPlan,
} from '../types.ts';

export interface AiStageInput {
  source: ReviewPlan['source'];
  files: FileChange[];
  hunks: Hunk[];
  symbols: ChangedSymbol[];
  edges: ChangeEdge[];
  groups: Group[];
  enricher: AiEnricher;
  /** Calls running at once (default 3). */
  concurrency?: number;
  /** Per call (default 120 s). */
  timeoutMs?: number;
}

export interface AiStageOutput {
  groups: Group[];
  overview?: string;
  /** The model that answered, when the provider said. */
  model?: string;
  titled: number;
  /** Hunks the AI suggests moving to another group. */
  suggested: number;
  cached: number;
  /** Tokens used by the calls made, when the provider said. */
  tokens?: { input: number; output: number };
}

/** Context lines kept on each side of a change. */
const CONTEXT = 2;
const MAX_LINES_PER_HUNK = 80;
const MAX_LINES_PER_GROUP = 600;
const MAX_LINE_CHARS = 200;
const MAX_DESCRIPTION_CHARS = 3000;
const MAX_COMMITS = 30;
const MAX_GROUP_SYMBOLS = 40;
const MAX_OTHER_SYMBOLS = 12;
const MAX_OTHER_FILES = 8;

const isLogicGroup = (g: Group) => g.kind !== 'noise' && g.kind !== 'move';

export const aiStage: Stage<AiStageInput, AiStageOutput> = async (input, ctx) => {
  const { enricher } = input;
  const timeoutMs = input.timeoutMs ?? 120_000;
  const targets = input.groups.filter(isLogicGroup);
  const out: AiStageOutput = {
    groups: input.groups,
    titled: 0,
    suggested: 0,
    cached: 0,
  };
  if (targets.length === 0) return out;

  const pr = pullRequest(input.source);
  const requests = buildGroupInputs(pr, targets, input);
  const stop = new AbortController();
  let fatal: AiError | undefined;

  /** The answer, or why there is none ('' once a fatal error has stopped everything). */
  const ask = async (
    call: (signal: AbortSignal) => Promise<AiAnswer>,
  ): Promise<AiAnswer | { error: string }> => {
    if (fatal) return { error: '' };
    try {
      const answer = await withTimeout(call, timeoutMs, stop.signal);
      if (answer.model) out.model ??= answer.model;
      if (answer.cached) out.cached++;
      else if (answer.usage) {
        out.tokens ??= { input: 0, output: 0 };
        out.tokens.input += answer.usage.inputTokens;
        out.tokens.output += answer.usage.outputTokens;
      }
      return answer;
    } catch (e) {
      if (e instanceof AiError && e.fatal && !fatal) {
        fatal = e;
        stop.abort();
      }
      return { error: fatal ? '' : e instanceof Error ? e.message : String(e) };
    }
  };

  // Calls finish in any order; warnings are written in group order so the plan does not vary.
  const answers = new Map<string, AiGroupAnswer>();
  const failures = new Map<string, string>();
  await pool(requests, input.concurrency ?? 3, async (request) => {
    const answer = await ask((signal) => enricher.group(request, signal));
    if ('error' in answer) {
      if (answer.error) failures.set(request.group.id, answer.error);
      return;
    }
    const parsed = aiGroupAnswer.safeParse(answer.output);
    if (parsed.success) answers.set(request.group.id, parsed.data);
    else failures.set(request.group.id, `the answer was not valid: ${issue(parsed)}`);
  });
  if (fatal) {
    const { message, hint } = fatal as AiError;
    ctx.warn(`AI enrichment stopped, rule-based titles kept: ${message}${hint ? ` ${hint}` : ''}`);
  }
  for (const r of requests) {
    const why = failures.get(r.group.id);
    if (why) ctx.warn(`AI: group ${r.group.id} kept its rule-based text (${why})`);
  }

  const suggestions = moveSuggestions(input.groups, answers, input.hunks, ctx);
  const groups = input.groups.map((g) => {
    const a = answers.get(g.id);
    if (!a) return g;
    out.titled++;
    const moves = suggestions.get(g.id) ?? [];
    out.suggested += moves.length;
    return {
      ...g,
      title: a.title.replace(/\.$/, ''),
      titleSource: 'ai' as const,
      intent: a.intent,
      ...(moves.length > 0 && { moveSuggestions: moves }),
    };
  });
  out.groups = groups;

  if (!fatal && answers.size > 0) {
    const request = overviewInput(pr, groups, input.hunks);
    const answer = await ask((signal) => enricher.overview(request, signal));
    const parsed = 'error' in answer ? undefined : aiOverviewAnswer.safeParse(answer.output);
    if (parsed?.success) out.overview = parsed.data.overview;
    else if (parsed) ctx.warn(`AI: no overview (the answer was not valid: ${issue(parsed)})`);
    else if (fatal) ctx.warn(`AI: no overview: ${(fatal as AiError).message}`);
    else if ('error' in answer && answer.error) ctx.warn(`AI: no overview (${answer.error})`);
  }
  return out;
};

function pullRequest(source: ReviewPlan['source']): AiPullRequest {
  const description = source.description?.trim();
  return {
    repo: source.repo,
    ...(source.prNumber !== undefined && { prNumber: source.prNumber }),
    ...(source.title && { title: source.title }),
    ...(description && {
      description:
        description.length > MAX_DESCRIPTION_CHARS
          ? `${description.slice(0, MAX_DESCRIPTION_CHARS)}…`
          : description,
    }),
    baseRef: source.baseRef,
    headRef: source.headRef,
    commits: source.commits.slice(0, MAX_COMMITS).map((c) => c.subject),
  };
}

/** AI-4: per group, its symbols, why it is grouped and trimmed diff lines; no noise, no files. */
function buildGroupInputs(
  pr: AiPullRequest,
  targets: Group[],
  input: AiStageInput,
): AiGroupInput[] {
  const hunkById = new Map(input.hunks.map((h) => [h.id, h]));
  const pathOf = new Map(input.files.map((f) => [f.id, f.path]));
  const symbolById = new Map(input.symbols.map((s) => [s.id, s]));
  const symbolsOf = (g: Group) => {
    const ids = new Set(
      g.steps.flatMap((s) => s.hunkIds.flatMap((id) => hunkById.get(id)!.symbolIds)),
    );
    return [...ids].map((id) => symbolById.get(id)!).filter((s) => s.kind !== 'file');
  };

  return targets.map((g) => {
    let budget = MAX_LINES_PER_GROUP;
    const hunks: AiHunk[] = g.steps.flatMap((step) =>
      step.hunkIds.map((id) => {
        const h = hunkById.get(id)!;
        const changed = h.lines.filter((l) => l.kind !== 'context').length;
        const trimmed =
          budget > 0
            ? trimHunk(h, Math.min(MAX_LINES_PER_HUNK, budget))
            : { lines: [], omitted: changed };
        budget -= trimmed.lines.length;
        return {
          id,
          path: pathOf.get(h.fileId)!,
          header: h.header,
          symbols: h.symbolIds
            .map((s) => symbolById.get(s))
            .filter((s) => s !== undefined)
            .map((s) => `${s.qualifiedName} (${s.change})`),
          lines: trimmed.lines,
          omittedLines: trimmed.omitted,
        };
      }),
    );
    return {
      pr,
      group: {
        id: g.id,
        title: g.title,
        kind: g.kind,
        reasons: g.reasons,
        steps: g.steps.map((s) => ({ title: s.title, hunkIds: s.hunkIds })),
        symbols: symbolsOf(g)
          .slice(0, MAX_GROUP_SYMBOLS)
          .map((s) => `${s.qualifiedName} (${s.change})`),
      },
      hunks,
      otherGroups: targets
        .filter((o) => o.id !== g.id)
        .map((o) => ({
          id: o.id,
          title: o.title,
          files: [
            ...new Set(
              o.steps.flatMap((s) => s.hunkIds.map((id) => pathOf.get(hunkById.get(id)!.fileId)!)),
            ),
          ].slice(0, MAX_OTHER_FILES),
          symbols: symbolsOf(o)
            .slice(0, MAX_OTHER_SYMBOLS)
            .map((s) => s.qualifiedName),
        })),
    };
  });
}

/** Changed lines with a little context; unchanged runs far from a change become "⋯". */
function trimHunk(h: Hunk, maxLines: number): { lines: string[]; omitted: number } {
  const near = new Set<number>();
  h.lines.forEach((l, i) => {
    if (l.kind === 'context') return;
    for (let j = i - CONTEXT; j <= i + CONTEXT; j++) near.add(j);
  });
  const lines: string[] = [];
  let omitted = 0;
  let gap = false;
  h.lines.forEach((l, i) => {
    if (!near.has(i)) {
      gap = true;
      return;
    }
    if (lines.length >= maxLines) {
      if (l.kind !== 'context') omitted++;
      return;
    }
    if (gap && lines.length > 0) lines.push('⋯');
    gap = false;
    const prefix = l.kind === 'add' ? '+' : l.kind === 'del' ? '-' : ' ';
    const text = l.text.length > MAX_LINE_CHARS ? `${l.text.slice(0, MAX_LINE_CHARS)}…` : l.text;
    lines.push(prefix + text);
  });
  return { lines, omitted };
}

/**
 * AI-3, AI-5: the AI's suggestions to move a hunk of a group to another logic group, kept only
 * when the hunk exists and is in that group, the target is another logic group (noise and moved
 * code never give or take hunks), and the hunk is not suggested twice. They are not applied.
 */
function moveSuggestions(
  groups: Group[],
  answers: Map<string, AiGroupAnswer>,
  hunks: Hunk[],
  ctx: StageContext,
): Map<string, MoveSuggestion[]> {
  const groupById = new Map(groups.map((g) => [g.id, g]));
  const groupOfHunk = new Map<string, string>();
  for (const g of groups)
    for (const s of g.steps) for (const id of s.hunkIds) groupOfHunk.set(id, g.id);
  const known = new Set(hunks.map((h) => h.id));

  const out = new Map<string, MoveSuggestion[]>();
  for (const g of groups) {
    const seen = new Set<string>();
    for (const move of answers.get(g.id)?.moves ?? []) {
      const target = groupById.get(move.toGroupId);
      const why = !known.has(move.hunkId)
        ? 'no such hunk'
        : groupOfHunk.get(move.hunkId) !== g.id
          ? `the hunk is not in ${g.id}`
          : !target || !isLogicGroup(target)
            ? 'not a group of changes to read'
            : target.id === g.id
              ? 'it is already there'
              : seen.has(move.hunkId)
                ? 'the hunk was already suggested'
                : undefined;
      if (why) {
        ctx.warn(`AI: suggestion to move ${move.hunkId} to ${move.toGroupId} was dropped (${why})`);
        continue;
      }
      seen.add(move.hunkId);
      out.set(g.id, [
        ...(out.get(g.id) ?? []),
        { hunkId: move.hunkId, toGroupId: move.toGroupId, reason: move.reason },
      ]);
    }
  }
  return out;
}

function overviewInput(pr: AiPullRequest, groups: Group[], hunks: Hunk[]): AiOverviewInput {
  const hunkById = new Map(hunks.map((h) => [h.id, h]));
  return {
    pr,
    groups: groups.filter(isLogicGroup).map((g) => {
      const groupHunks = g.steps.flatMap((s) => s.hunkIds.map((id) => hunkById.get(id)!));
      return {
        id: g.id,
        title: g.title,
        ...(g.intent && { intent: g.intent }),
        kind: g.kind,
        files: new Set(groupHunks.map((h) => h.fileId)).size,
        changedLines: groupHunks.reduce(
          (n, h) => n + h.lines.filter((l) => l.kind !== 'context').length,
          0,
        ),
      };
    }),
    collapsed: groups.filter((g) => !isLogicGroup(g)).map((g) => g.title),
  };
}

/** Runs `call` with a signal that aborts after `ms` or when `stop` aborts; rejects either way. */
async function withTimeout<T>(
  call: (signal: AbortSignal) => Promise<T>,
  ms: number,
  stop: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  let reject!: (e: unknown) => void;
  const aborted = new Promise<never>((_, r) => (reject = r));
  const timer = setTimeout(() => {
    const e = new AiError(`no answer after ${Math.round(ms / 1000)} s`);
    controller.abort(e);
    reject(e);
  }, ms);
  const onStop = () => {
    const e = new AiError('stopped');
    controller.abort(e);
    reject(e);
  };
  stop.addEventListener('abort', onStop, { once: true });
  try {
    return await Promise.race([call(controller.signal), aborted]);
  } finally {
    clearTimeout(timer);
    stop.removeEventListener('abort', onStop);
  }
}

async function pool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await fn(items[next++]!);
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
}

function issue(result: { error?: { issues: { path: PropertyKey[]; message: string }[] } }): string {
  const first = result.error?.issues[0];
  if (!first) return 'unknown problem';
  return `${first.path.length ? `${first.path.map(String).join('.')}: ` : ''}${first.message}`;
}
